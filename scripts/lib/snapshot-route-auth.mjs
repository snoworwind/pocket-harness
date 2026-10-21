import { spawnSync } from 'node:child_process'

const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')

/** Read fixed members in one archive pass without extracting paths onto disk. */
export function readSnapshotRouteFiles(snapshot, members) {
  const code = `import json,sys,tarfile
wanted=set(json.loads(sys.argv[2])); out={name:None for name in wanted}; seen=set(); total=0
with tarfile.open(sys.argv[1], 'r|*') as archive:
 for entry in archive:
  name=entry.name.removeprefix('./')
  if name not in wanted: continue
  if name in seen: raise ValueError('duplicate route member: '+name)
  seen.add(name)
  if not entry.isfile() or entry.size > 8*1024*1024: raise ValueError('invalid route member: '+name)
  total += entry.size
  if total > 16*1024*1024: raise ValueError('route members exceed size limit')
  out[name]=archive.extractfile(entry).read().decode('utf-8')
print(json.dumps(out, ensure_ascii=False))`
  const result = spawnSync(PYTHON, ['-c', code, snapshot, JSON.stringify(members)], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? String(result.stderr ?? '').trim().slice(0, 240))
  }
  return JSON.parse(result.stdout)
}

/** Each required package must carry its own route-auth marker in each shipped profile. */
export function snapshotRouteVerdicts(files, markers, profiles = ['web', 'headless']) {
  const verdicts = []
  for (const profile of profiles) {
    const prefix = 'home/.dsh/profiles/' + profile + '/node_modules/'
    for (const [path, marker] of markers) {
      const key = prefix + path
      const content = files[key]
      verdicts.push({
        label: profile + '/' + path,
        ok: typeof content === 'string' && content.includes(marker),
        detail: 'required member or its own auth marker missing',
      })
    }
  }
  return verdicts
}
