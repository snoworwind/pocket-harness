/** Limit decoded HTTP bytes before building a string or parsing JSON. */
export async function boundedResponseText(response: {
  body?: ReadableStream<Uint8Array> | null
  headers?: { get(name: string): string | null }
  text(): Promise<string>
}, maxBytes = 8 * 1024 * 1024): Promise<string> {
  const declared = Number(response.headers?.get('content-length'))
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new Error('HTTP response exceeds byte limit')
  }
  // Native fetch always supplies a stream for nonempty bodies. Text-only adapters
  // are for injected offline transports; still enforce their resulting byte size.
  if (!response.body) {
    if (response instanceof Response) return ''
    const text = await response.text()
    if (Buffer.byteLength(text) > maxBytes) throw new Error('HTTP response exceeds byte limit')
    return text
  }
  const reader = response.body.getReader()
  // Bound allocation independently of chunk count: retaining millions of tiny
  // chunks can exhaust memory long before their combined bytes reach the limit.
  const bytes = Buffer.allocUnsafe(maxBytes)
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new Error('HTTP response exceeds byte limit')
      bytes.set(value, size - value.byteLength)
    }
    return bytes.toString('utf8', 0, size)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
