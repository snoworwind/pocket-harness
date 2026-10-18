"""Read untrusted APK/tar bytes without extracting or executing their payload."""
import base64
import hashlib
import json
import pathlib
import re
import sys
import tarfile
import tempfile
import zipfile

ENGINE = 'usr/lib/node_modules/@deepseek-ai/dsh'
SPECIAL = {ENGINE + '/pnpm-workspace.yaml', ENGINE + '/node_modules/.modules.yaml',
           ENGINE + '/node_modules/.pnpm-workspace-state-v1.json'}
MAX_BYTES = 4 * 1024**3


def safe_path(name):
    if name.startswith('/') or '\\' in name or '\x00' in name:
        raise ValueError('unsafe archive path')
    while name.startswith('./'):
        name = name[2:]
    parts = name.rstrip('/').split('/')
    if any(part == '..' for part in parts):
        raise ValueError('archive traversal')
    return str(pathlib.PurePosixPath(name))


def digest_stream(stream, capture=False):
    h, size, chunks = hashlib.sha256(), 0, []
    while True:
        chunk = stream.read(1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > (16 * 1024**2 if capture else MAX_BYTES):
            raise ValueError('archive payload exceeds limit')
        h.update(chunk)
        if capture:
            chunks.append(chunk)
    return h.hexdigest(), b''.join(chunks), size


def read_apk(apk):
    result = {'apkEntries': {}, 'snapshotEntries': []}
    with tempfile.TemporaryDirectory(prefix='pocket-apk-read-') as work, zipfile.ZipFile(apk) as package:
        seen, total = set(), 0
        snapshot = pathlib.Path(work) / 'snapshot.tar.xz'
        snapshot_digest = None
        for item in package.infolist():
            name = safe_path(item.filename)
            if item.filename.rstrip('/') != name:
                raise ValueError('noncanonical APK entry name')
            if name in seen:
                raise ValueError('duplicate APK entry')
            seen.add(name)
            if item.is_dir():
                continue
            total += item.file_size
            if total > MAX_BYTES:
                raise ValueError('APK payload exceeds limit')
            if name == 'assets/snapshot.tar.xz':
                h = hashlib.sha256()
                with package.open(item) as source, snapshot.open('wb') as destination:
                    while chunk := source.read(1024 * 1024):
                        h.update(chunk)
                        destination.write(chunk)
                snapshot_digest = h.hexdigest()
            elif name in {'assets/snapshot.sha256', 'assets/plugin-hard-manifest.json'}:
                with package.open(item) as source:
                    _, data, _ = digest_stream(source, True)
                result[name] = data.decode('utf-8', errors='strict')
            elif re.fullmatch(r'META-INF/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC))', name, re.I):
                # Only JAR signing records vary; services and other META-INF files count.
                continue
            else:
                with package.open(item) as source:
                    result['apkEntries'][name] = digest_stream(source)[0]
        if snapshot_digest is None:
            raise ValueError('APK lacks runtime snapshot')
        if not {'AndroidManifest.xml', 'classes.dex'}.issubset(seen):
            raise ValueError('APK lacks Android executable payload')
        if result.get('assets/snapshot.sha256', '').strip() != snapshot_digest:
            raise ValueError('APK snapshot fingerprint is not bound to its bytes')
        hard = json.loads(result.get('assets/plugin-hard-manifest.json', '{}'))
        if hard.get('fingerprint') != snapshot_digest or hard.get('schema') != 2 or hard.get('complete') is not True:
            raise ValueError('APK hard manifest is not bound to its snapshot')
        del hard['fingerprint']
        result['hardManifest'] = hard
        entries, explicit, total = {}, set(), 0
        with tarfile.open(snapshot, 'r:xz') as archive:
            for item in archive:
                name = safe_path(item.name)
                if name == '.':
                    continue
                if name in explicit or len(explicit) >= 250_000:
                    raise ValueError('duplicate or excessive snapshot entries')
                explicit.add(name)
                row = {'path': name, 'mode': item.mode & 0o7777}
                if item.isdir():
                    row['kind'] = 'directory'
                elif item.issym():
                    row.update(kind='symlink', body=item.linkname)
                elif item.isfile():
                    total += item.size
                    if total > MAX_BYTES:
                        raise ValueError('decoded snapshot exceeds limit')
                    with archive.extractfile(item) as source:
                        digest, data, _ = digest_stream(source, name.endswith('/package.json') or name == 'package.json' or name in SPECIAL)
                    row.update(kind='file', rawSha256=digest)
                    if data:
                        row['bodyBase64'] = base64.b64encode(data).decode('ascii')
                elif item.islnk():
                    target = entries.get(safe_path(item.linkname))
                    if target is None or target.get('kind') != 'file':
                        raise ValueError('unresolved snapshot hardlink')
                    row.update({key: value for key, value in target.items() if key != 'path'})
                    row['path'] = name
                else:
                    raise ValueError('unsupported snapshot entry type')
                entries[name] = row
        # Filesystem normalization includes implicit parents created by tar.
        for name in list(entries):
            for parent in pathlib.PurePosixPath(name).parents:
                if str(parent) == '.':
                    continue
                key = str(parent)
                if key in entries and entries[key]['kind'] != 'directory':
                    raise ValueError('snapshot entry beneath non-directory')
                entries.setdefault(key, {'path': key, 'kind': 'directory', 'mode': 0o755})
        result['snapshotEntries'] = list(entries.values())
    return result


if __name__ == '__main__':
    pathlib.Path(sys.argv[2]).write_text(json.dumps(read_apk(sys.argv[1])), encoding='utf-8')
