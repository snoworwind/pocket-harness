import { MANIFEST_NAME, parseGithubUrl } from './manifest.js'
import { createHash } from 'node:crypto'

const REDIRECT_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
const RELEASE_LIMIT = 2 * 1024 * 1024
const MANIFEST_LIMIT = 256 * 1024

// Bound decoded bytes, including responses without Content-Length and compressed bodies.
// The deadline covers both headers and body; bootstrap serializes discovery with other operations.
async function fetchBytes(url, accept, fetchImpl, limit, timeoutMs) {
  const controller = new AbortController()
  let reader
  let response
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('GitHub request deadline exceeded'))
      controller.abort()
      void reader?.cancel().catch(() => {})
    }, timeoutMs)
  })
  try {
    return await Promise.race([deadline, (async () => {
      response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal, headers: { Accept: accept } })
      controller.signal.throwIfAborted()
      assertResponse(response, url)
      const declared = response.headers?.get('content-length')
      if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
        controller.abort()
        void response.body?.cancel().catch(() => {})
        throw new Error('GitHub response exceeds byte limit')
      }
      if (!response.body?.getReader) throw new Error('GitHub response has no readable body')
      reader = response.body.getReader()
      const chunks = []
      let total = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > limit) throw new Error('GitHub response exceeds byte limit')
          chunks.push(Buffer.from(value))
        }
        return Buffer.concat(chunks, total)
      } catch (error) {
        controller.abort()
        void reader.cancel().catch(() => {})
        throw error
      } finally {
        try { reader.releaseLock() } catch { /* Preserve the admission/read failure. */ }
      }
    })()])
  } catch (error) {
    controller.abort()
    if (reader === undefined) void response?.body?.cancel().catch(() => {})
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function assertResponse(response, requestedUrl) {
  if (!response || typeof response.ok !== 'boolean' || !response.ok) throw new Error(`GitHub request failed${response?.status ? ` (${response.status})` : ''}`)
  const finalUrl = new URL(response.url || requestedUrl)
  if (finalUrl.protocol !== 'https:' || !['github.com', 'api.github.com', ...REDIRECT_HOSTS].includes(finalUrl.hostname)) {
    throw new Error('GitHub request redirected outside HTTPS GitHub release hosts')
  }
}

async function readManifest(bytes, assetMetadata) {
  if (assetMetadata?.size !== undefined && bytes.length !== assetMetadata.size) throw new Error('Release manifest size does not match GitHub release metadata')
  if (typeof assetMetadata?.digest === 'string' && assetMetadata.digest.startsWith('sha256:')) {
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== assetMetadata.digest.slice('sha256:'.length)) throw new Error('Release manifest SHA-256 does not match GitHub release metadata')
  }
  return JSON.parse(bytes.toString('utf8'))
}

export async function fetchLatestManifest(releaseUrl, fetchImpl, { timeoutMs = 30_000 } = {}) {
  const parsed = parseGithubUrl(releaseUrl, { allowApi: true })
  if (parsed.search || parsed.hash) throw new TypeError('Release URL must not contain a query or fragment')
  let apiUrl
  if (parsed.hostname === 'api.github.com') {
    if (!/^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(parsed.pathname)) throw new TypeError('Expected /repos/{owner}/{repo}/releases/latest')
    apiUrl = parsed.href
  } else {
    const match = /^\/([^/]+)\/([^/]+)\/(?:releases\/latest)?$/.exec(parsed.pathname.replace(/\/$/, ''))
    if (!match) throw new TypeError('releaseUrl must identify a GitHub repository or its latest-release page')
    apiUrl = `https://api.github.com/repos/${match[1]}/${match[2]}/releases/latest`
  }
  const release = JSON.parse((await fetchBytes(apiUrl, 'application/vnd.github+json', fetchImpl, RELEASE_LIMIT, timeoutMs)).toString('utf8'))
  if (!release || typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) throw new TypeError('Invalid GitHub latest-release response')
  const metadata = release.assets.find((asset) => asset?.name === MANIFEST_NAME)
  if (!metadata || typeof metadata.browser_download_url !== 'string') throw new Error('Latest release does not contain linux-release.json')
  const assetUrl = parseGithubUrl(metadata.browser_download_url)
  const expectedPath = `/releases/download/${encodeURIComponent(release.tag_name)}/${MANIFEST_NAME}`
  if (!assetUrl.pathname.endsWith(expectedPath) || assetUrl.search || assetUrl.hash) throw new TypeError('Latest release manifest URL is not version-pinned')
  if (metadata.size !== undefined && (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > MANIFEST_LIMIT)) throw new Error('Release manifest metadata exceeds byte limit')
  const bytes = await fetchBytes(assetUrl.href, 'application/octet-stream', fetchImpl, MANIFEST_LIMIT, timeoutMs)
  const manifest = await readManifest(bytes, metadata)
  return { manifest, releaseTag: release.tag_name }
}
