#!/usr/bin/env python3
"""Build the Android PRoot closure from source, without Termux .debs/bootstrap.

Offline build: <sources-dir> <NDK-r30-root> <output-dir> --abi arm64|x86_64
Source acquisition: --download-sources <sources-dir> (hashes pinned in git).
Outputs are experimental; ELF validation is not Android device validation.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import urlparse
from urllib.request import urlopen
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ADAPTERS = HERE / 'proot-source'
NDK_REVISION = '30.0.16248370'
API = 26
SOURCES = ('proot', 'libtalloc', 'libandroid-shmem')
ABIS = {'arm64': ('arm64-v8a', 'aarch64', 183), 'x86_64': ('x86_64', 'x86_64', 62)}
OUTPUTS = ('libpocketharness_proot.so', 'libpocketharness_proot_loader.so', 'libtalloc.so', 'libandroid-shmem.so')
PUBLIC_LIBS = {'libc.so', 'libdl.so', 'libm.so', 'liblog.so', 'libandroid.so'}

spec = importlib.util.spec_from_file_location('pocket_native_inventory', HERE / 'inventory-native-runtime.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def source_records():
    # Reuse the reviewed source identities, not the Termux package binaries or
    # recipe execution. No .deb index, keyring, prefix or installed package is used.
    lock = json.loads((HERE / 'linux-backend-packages.json').read_text())
    records = {}
    for name in SOURCES:
        row = lock['packageSources'][name]
        url, digest = row['sourceUrl'], row['sourceSha256']
        if urlparse(url).scheme != 'https' or not re.fullmatch('[a-f0-9]{64}', digest):
            raise ValueError(f'invalid source identity: {name}')
        records[name] = dict(url=url, sha256=digest, version=lock['expectedVersions'][name],
                             archive=PurePosixPath(urlparse(url).path).name, license=row['license'])
    return records


def real_directory(path):
    path = Path(path)
    if path.is_symlink() or not path.is_dir():
        raise ValueError(f'not a real directory: {path}')
    return path.resolve()


def fetch_sources(destination):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    destination = real_directory(destination)
    for name, row in source_records().items():
        target = destination / row['archive']
        if target.exists() or target.is_symlink():
            if target.is_symlink() or not target.is_file() or native.sha256_file(target) != row['sha256']:
                raise ValueError(f'existing source archive has wrong identity: {name}')
            continue
        descriptor, temporary = tempfile.mkstemp(prefix='source-', dir=destination)
        try:
            with os.fdopen(descriptor, 'wb') as output, urlopen(row['url'], timeout=60) as response:
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > 128 * 1024 * 1024:
                        raise ValueError('source archive exceeds bound')
                    output.write(chunk)
            if native.sha256_file(Path(temporary)) != row['sha256']:
                raise ValueError(f'downloaded source digest mismatch: {name}')
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        print(f'verified source: {name}', flush=True)


def unpack_source(archive, destination):
    """Extract regular source files and deferred same-directory file aliases."""
    destination.mkdir()
    seen = set()
    links = []
    total = 0

    def target_for(name, size):
        nonlocal total
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or not path.parts or '\\' in name:
            raise ValueError('unsafe source archive path')
        normalized = str(path)
        if normalized in seen:
            raise ValueError('duplicate source archive path')
        seen.add(normalized)
        total += size
        if total > 256 * 1024 * 1024 or len(seen) > 20000:
            raise ValueError('source archive exceeds unpack bound')
        return destination.joinpath(*path.parts)

    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as source:
            for row in source.infolist():
                mode = row.external_attr >> 16
                kind = stat.S_IFMT(mode)
                if kind not in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK):
                    raise ValueError('source archive links/special entries are forbidden')
                target = target_for(row.filename, row.file_size)
                if kind == stat.S_IFLNK:
                    alias = source.read(row).decode('utf-8')
                    if not alias or alias in ('.', '..') or '/' in alias or '\\' in alias:
                        raise ValueError('unsafe source archive file alias')
                    links.append((target, alias))
                elif row.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with source.open(row) as stream, target.open('xb') as output:
                        shutil.copyfileobj(stream, output)
                    target.chmod((mode & 0o777) or 0o644)
    else:
        with tarfile.open(archive) as source:
            for row in source:
                if not (row.isfile() or row.isdir()):
                    raise ValueError('source archive links/special entries are forbidden')
                target = target_for(row.name, row.size)
                if row.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with source.extractfile(row) as stream, target.open('xb') as output:
                        shutil.copyfileobj(stream, output)
                    target.chmod(row.mode & 0o777)
    for target, alias in links:
        referent = target.parent / alias
        if referent.is_symlink() or not referent.is_file() or target.exists() or target.is_symlink():
            raise ValueError('source archive link target must be an existing regular file')
        target.symlink_to(alias)
    children = list(destination.iterdir())
    if len(children) != 1 or not children[0].is_dir():
        raise ValueError('source archive must have exactly one root directory')
    return children[0]


def replace_once(path, before, after):
    text = path.read_text()
    if text.count(before) != 1:
        raise ValueError(f'source patch anchor drift: {path.name}')
    original = native.sha256_file(path)
    path.write_text(text.replace(before, after))
    return dict(beforeSha256=original, afterSha256=native.sha256_file(path))


def require_gnu_awk():
    executable = shutil.which('gawk') or shutil.which('awk')
    if not executable:
        raise ValueError('GNU awk is required to generate PRoot loader metadata; install gawk')
    result = subprocess.run([executable, '--version'], capture_output=True, text=True, timeout=15)
    if result.returncode or not result.stdout.startswith('GNU Awk '):
        raise ValueError('GNU awk is required to generate PRoot loader metadata; install gawk')
    executable = Path(executable).resolve()
    return dict(path=str(executable), version=result.stdout.splitlines()[0], sha256=native.sha256_file(executable))


def patch_sources(sources):
    changes = {}
    changes['libtalloc/wscript'] = replace_once(sources['libtalloc'] / 'wscript',
        '                          vnum=VERSION,\n                          public_headers=',
        "                          vnum=VERSION,\n                          soname='libtalloc.so',\n                          public_headers=")
    shmem = sources['libandroid-shmem'] / 'shmem.c'
    before = native.sha256_file(shmem)
    replace_once(shmem, '#define ASHV_KEY_SYMLINK_PATH _PATH_TMP "ashv_key_%d"', '#include "pocket_shmem_path.h"')
    replace_once(shmem, '\t\tsprintf(symlink_path, ASHV_KEY_SYMLINK_PATH, key);',
        '\t\tif (pocket_shmem_key_path(symlink_path, sizeof(symlink_path), key) != 0) {\n'
        '\t\t\tpthread_mutex_unlock(&mutex);\n\t\t\treturn -1;\n\t\t}')
    changes['libandroid-shmem/shmem.c'] = dict(beforeSha256=before, afterSha256=native.sha256_file(shmem))
    shutil.copyfile(ADAPTERS / 'pocket_shmem_path.h', shmem.parent / 'pocket_shmem_path.h')
    changes['proot/src/extension/ashmem_memfd/ashmem_memfd.c'] = replace_once(
        sources['proot'] / 'src/extension/ashmem_memfd/ashmem_memfd.c',
        '#include <stdlib.h>\n', '#include <stdlib.h>\n#include <string.h>\n')
    patch_issue_322_diagnostics(sources, changes)
    return changes


def patch_issue_322_diagnostics(sources, changes):
    """Source-level diagnosis/workaround for the fork hang and loader exits (#322).

    Both changes are opt-in through the environment so that a kernel which reports the
    initial ptrace stop (every device seen so far) keeps the stock PRoot behaviour.
    """
    event = sources['proot'] / 'src/tracee/event.c'
    event_before = native.sha256_file(event)
    replace_once(event, '#include <inttypes.h>   /* PRI*, */\n',
        '#include <inttypes.h>   /* PRI*, */\n#include <stdio.h>      /* fprintf(3), */\n')
    replace_once(event, 'int event_loop()\n{\n',
        '''/**
 * Log every status waitpid(2) reports when PROOT_POCKET_TRACE_WAIT is set.
 * Issue #322: decides whether a child's initial ptrace stop is ever delivered.
 */
static bool pocket_trace_wait(void)
{
\tstatic int enabled = -1;

\tif (enabled < 0)
\t\tenabled = getenv("PROOT_POCKET_TRACE_WAIT") != NULL;
\treturn enabled != 0;
}

int event_loop()
{
''')
    replace_once(event,
        '\t\t/* Get information about this tracee. */\n',
        '''\t\tif (pocket_trace_wait())
\t\t\tfprintf(stderr,
\t\t\t\t"proot-wait: pid=%d status=0x%x stopped=%d sig=%d event=%d\\n",
\t\t\t\t(int) pid, (unsigned) tracee_status,
\t\t\t\tWIFSTOPPED(tracee_status) ? 1 : 0,
\t\t\t\tWIFSTOPPED(tracee_status) ? WSTOPSIG(tracee_status) : 0,
\t\t\t\t(tracee_status >> 16) & 0xff);

\t\t/* Get information about this tracee. */\n''')
    changes['proot/src/tracee/event.c'] = dict(
        beforeSha256=event_before, afterSha256=native.sha256_file(event))

    loader = sources['proot'] / 'src/loader/loader.c'
    loader_before = native.sha256_file(loader)
    fatal_old = (
        '#define FATAL() do {\t\t\t\t\t\t\\\n'
        '\t\tSYSCALL(EXIT, 1, 182);\t\t\t\t\\\n'
        '\t\t__builtin_unreachable();\t\t\t\\\n'
        '\t} while (0)\n')
    fatal_new = (
        '/**\n'
        ' * Report which load statement failed, and with which status, before the\n'
        ' * silent exit-with-182.  Issue #322: a bare 182 cannot tell a failed\n'
        ' * open(2) apart from a failed mmap(2), so the failure point was unknown.\n'
        ' */\n'
        'static word_t pocket_loader_number(char *out, word_t value)\n'
        '{\n'
        '\tchar digits[20];\n'
        '\tword_t count = 0;\n'
        '\tword_t index;\n'
        '\n'
        '\twhile (value != 0 && count < sizeof(digits)) {\n'
        '\t\tdigits[count++] = (char) (\'0\' + (value % 10));\n'
        '\t\tvalue /= 10;\n'
        '\t}\n'
        '\tif (count == 0)\n'
        '\t\tdigits[count++] = \'0\';\n'
        '\tfor (index = 0; index < count; index++)\n'
        '\t\tout[index] = digits[count - 1 - index];\n'
        '\treturn count;\n'
        '}\n'
        '\n'
        '/** Best effort: a guest with no writable stderr simply sees no line.  */\n'
        'static void pocket_loader_fatal(word_t site, word_t status)\n'
        '{\n'
        '\tstatic const char prefix[] = "[proot-loader] site=";\n'
        '\tstatic const char middle[] = " status=";\n'
        '\tchar line[64];\n'
        '\tword_t at = 0;\n'
        '\tword_t index;\n'
        '\n'
        '\tfor (index = 0; index < sizeof(prefix) - 1; index++)\n'
        '\t\tline[at++] = prefix[index];\n'
        '\tat += pocket_loader_number(line + at, site);\n'
        '\tfor (index = 0; index < sizeof(middle) - 1; index++)\n'
        '\t\tline[at++] = middle[index];\n'
        '\tif ((long) status < 0)\n'
        '\t\tstatus = (word_t) -status;\n'
        '\tat += pocket_loader_number(line + at, status);\n'
        '\tline[at++] = \'\\n\';\n'
        '\t(void) SYSCALL(WRITE, 3, 2, (word_t) line, at);\n'
        '}\n'
        '\n'
        '#define FATAL() do {\t\t\t\t\t\t\\\n'
        '\t\tpocket_loader_fatal(__LINE__, 0);\t\t\\\n'
        '\t\tSYSCALL(EXIT, 1, 182);\t\t\t\t\\\n'
        '\t\t__builtin_unreachable();\t\t\t\\\n'
        '\t} while (0)\n'
        '#define FATAL_STATUS(status_) do {\t\t\t\t\\\n'
        '\t\tpocket_loader_fatal(__LINE__, (word_t) (status_));\\\n'
        '\t\tSYSCALL(EXIT, 1, 182);\t\t\t\t\\\n'
        '\t\t__builtin_unreachable();\t\t\t\\\n'
        '\t} while (0)\n')
    replace_once(loader, fatal_old, fatal_new)
    replace_once(loader,
        '\t\t\tstatus = SYSCALL(CLOSE, 1, fd);\n'
        '\t\t\tif (unlikely((int) status < 0))\n'
        '\t\t\t\tFATAL();\n'
        '\t\t\t/* Fall through.  */\n',
        '\t\t\tstatus = SYSCALL(CLOSE, 1, fd);\n'
        '\t\t\tif (unlikely((int) status < 0))\n'
        '\t\t\t\tFATAL_STATUS(status);\n'
        '\t\t\t/* Fall through.  */\n')
    replace_once(loader,
        '\t\t\tif (unlikely((int) fd < 0))\n\t\t\t\tFATAL();\n',
        '\t\t\tif (unlikely((int) fd < 0))\n\t\t\t\tFATAL_STATUS(fd);\n')
    replace_once(loader,
        '\t\t\t\t\tstmt->mmap.prot, MAP_PRIVATE | MAP_FIXED, fd,\n'
        '\t\t\t\t\tstmt->mmap.offset >> MMAP_OFFSET_SHIFT);\n'
        '\t\t\tif (unlikely(status != stmt->mmap.addr))\n'
        '\t\t\t\tFATAL();\n',
        '\t\t\t\t\tstmt->mmap.prot, MAP_PRIVATE | MAP_FIXED, fd,\n'
        '\t\t\t\t\tstmt->mmap.offset >> MMAP_OFFSET_SHIFT);\n'
        '\t\t\tif (unlikely(status != stmt->mmap.addr))\n'
        '\t\t\t\tFATAL_STATUS(status);\n')
    replace_once(loader,
        '\t\t\t\t\tstmt->mmap.prot, MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS, -1, 0);\n'
        '\t\t\tif (unlikely(status != stmt->mmap.addr))\n'
        '\t\t\t\tFATAL();\n',
        '\t\t\t\t\tstmt->mmap.prot, MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS, -1, 0);\n'
        '\t\t\tif (unlikely(status != stmt->mmap.addr))\n'
        '\t\t\t\tFATAL_STATUS(status);\n')
    replace_once(loader,
        '\t\t\tstatus = SYSCALL(CLOSE, 1, fd);\n'
        '\t\t\tif (unlikely((int) status < 0))\n'
        '\t\t\t\tFATAL();\n\n'
        '\t\t\t/* Right after execve, the stack content is as follow:\n',
        '\t\t\tstatus = SYSCALL(CLOSE, 1, fd);\n'
        '\t\t\tif (unlikely((int) status < 0))\n'
        '\t\t\t\tFATAL_STATUS(status);\n\n'
        '\t\t\t/* Right after execve, the stack content is as follow:\n')
    changes['proot/src/loader/loader.c'] = dict(
        beforeSha256=loader_before, afterSha256=native.sha256_file(loader))

    for header, number in (('assembly-arm64.h', 64), ('assembly-x86_64.h', 1)):
        path = sources['proot'] / 'src/loader' / header
        header_before = native.sha256_file(path)
        replace_once(path, '#define EXIT\t', '#define WRITE\t%d\n#define EXIT\t' % number)
        changes['proot/src/loader/' + header] = dict(
            beforeSha256=header_before, afterSha256=native.sha256_file(path))

    tracee = sources['proot'] / 'src/tracee/tracee.c'
    tracee_before = native.sha256_file(tracee)
    replace_once(tracee,
        '\tVERBOSE(child, 1, "vpid %" PRIu64 ": pid %d", child->vpid, child->pid);\n\n\treturn 0;\n}\n',
        '''\t/* Issue #322: the HarmonyOS Linux ABI compatibility layer does not report the
\t * initial stop of a forked child, so the child waits inside the kernel while its
\t * parent waits in wait(2).  Resume it the same way the normal path does -- through
\t * restart_tracee() with an explicit restart_how -- because a bare PTRACE_CONT would
\t * skip the syscall-entry stops PRoot needs for path translation.  Opt-in only:
\t * kernels that do report the stop keep the stock ordering, and a stop that arrives
\t * late is still handled by the event loop (sigstop is already SIGSTOP_ALLOWED).  */
\tif (child->sigstop == SIGSTOP_IGNORED && !child->running
\t    && getenv("PROOT_POCKET_RESUME_SILENT_CHILD") != NULL) {
\t\tchild->sigstop = SIGSTOP_ALLOWED;
\t\tchild->restart_how = (child->seccomp == ENABLED ? PTRACE_CONT : PTRACE_SYSCALL);
\t\tif (restart_tracee(child, 0))
\t\t\tfprintf(stderr, "proot-resume: child %d resumed with %s\\n",
\t\t\t\tchild->pid,
\t\t\t\tchild->seccomp == ENABLED ? "PTRACE_CONT" : "PTRACE_SYSCALL");
\t\telse
\t\t\tfprintf(stderr, "proot-resume: child %d not resumed: %s\\n",
\t\t\t\tchild->pid, strerror(errno));
\t}

\tVERBOSE(child, 1, "vpid %" PRIu64 ": pid %d", child->vpid, child->pid);

\treturn 0;
}
''')
    changes['proot/src/tracee/tracee.c'] = dict(
        beforeSha256=tracee_before, afterSha256=native.sha256_file(tracee))


def check_bundle(directory, abi):
    directory = real_directory(directory)
    if abi not in ABIS or {path.name for path in directory.iterdir()} != set(OUTPUTS):
        raise ValueError('unexpected native source-build output set/ABI')
    rows = []
    for name in OUTPUTS:
        path = directory / name
        if path.is_symlink() or not path.is_file() or not path.stat().st_mode & 0o111:
            raise ValueError('native output must be an executable regular file')
        data = path.read_bytes()
        elf = native.elf_metadata(data)
        loader = name == OUTPUTS[1]
        program = name == OUTPUTS[0]
        if (elf['bits'] != 64 or elf['machine'] != ABIS[abi][2] or elf['type'] != (2 if loader else 3)
                or not elf['elf16kAligned'] or elf['writableExecutableSegments'] or elf['rpath'] or elf['runpath']):
            raise ValueError(f'invalid native ELF/ABI/page alignment: {name}')
        if program and (elf['interpreter'] != '/system/bin/linker64' or not elf['entry']
                        or not {'libtalloc.so', 'libandroid-shmem.so'}.issubset(elf['needed'])):
            raise ValueError('PRoot interpreter/dependency contract mismatch')
        if loader and (elf['interpreter'] is not None or elf['needed'] or not elf['entry']):
            raise ValueError('PRoot loader must be static with an executable entry')
        if not (loader or program) and (elf['interpreter'] is not None or elf['soname'] != [name]):
            raise ValueError(f'APK library SONAME mismatch: {name}')
        if set(elf['needed']) - PUBLIC_LIBS - set(OUTPUTS):
            raise ValueError(f'unresolved native dependency: {name}')
        rows.append(dict(name=name, size=len(data), sha256=hashlib.sha256(data).hexdigest(), elf=elf))
    return rows


def build(sources_dir, ndk, output, abi):
    if abi not in ABIS:
        raise ValueError('unsupported ABI')
    sources_dir, ndk = real_directory(sources_dir), real_directory(ndk)
    properties = (ndk / 'source.properties').read_text()
    if not re.search(r'^Pkg\.Revision\s*=\s*' + re.escape(NDK_REVISION) + r'\s*$', properties, re.M):
        raise ValueError('source build requires the pinned NDK revision')
    host = {'Linux': 'linux-x86_64', 'Darwin': 'darwin-x86_64'}.get(platform.system())
    if host is None:
        raise ValueError('NDK source build requires Linux or macOS')
    toolbin = ndk / 'toolchains/llvm/prebuilt' / host / 'bin'
    android_abi, triple, _ = ABIS[abi]
    cc = toolbin / f'{triple}-linux-android{API}-clang'
    if not cc.is_file():
        raise ValueError('NDK Android compiler is missing')
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    output = real_directory(output)
    parent = output / 'native-libs'
    if parent.exists() or parent.is_symlink():
        real_directory(parent)
    final = parent / android_abi
    receipt = output / f'proot-source-build-{abi}.json'
    if final.exists() or final.is_symlink() or receipt.exists() or receipt.is_symlink():
        raise ValueError('source build refuses to overwrite published outputs')
    # Upstream make/waf run shell commands containing these paths.
    for path in (output, ndk):
        if not re.fullmatch(r'[A-Za-z0-9_./+-]+', str(path)):
            raise ValueError('build and NDK paths must not contain shell metacharacters or whitespace')
    records = source_records()
    archives = {}
    for name, row in records.items():
        path = sources_dir / row['archive']
        if path.is_symlink() or not path.is_file() or native.sha256_file(path) != row['sha256']:
            raise ValueError(f'source archive digest mismatch: {name}')
        archives[name] = path
    awk = require_gnu_awk()
    work = Path(tempfile.mkdtemp(prefix=f'work-{abi}-', dir=output))
    source = {name: unpack_source(path, work / name) for name, path in archives.items()}
    changes = patch_sources(source)
    stage = work / 'stage'
    (stage / 'include/sys').mkdir(parents=True)
    (stage / 'lib').mkdir()
    tools = work / 'tools'
    tools.mkdir()
    (tools / 'awk').symlink_to(awk['path'])
    (tools / 'readelf').symlink_to(toolbin / 'llvm-readelf')
    logs = work / 'logs'
    logs.mkdir()
    commands = []
    env = {key: value for key, value in os.environ.items() if key not in (
        'CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'LIBRARY_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
        'SDKROOT', 'MACOSX_DEPLOYMENT_TARGET', 'CPPFLAGS', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'CC', 'CXX')}
    env.update(CC=str(cc), AR=str(toolbin / 'llvm-ar'), RANLIB=str(toolbin / 'llvm-ranlib'),
        PYTHON=sys.executable, PYTHONHASHSEED='1', PKG_CONFIG_PATH='', PKG_CONFIG_LIBDIR=str(work / 'no-host-pkgconfig'),
        CFLAGS=f'-O2 -fPIC -ffile-prefix-map={work}=/usr/src/pocket-harness/proot',
        LDFLAGS='-Wl,-z,max-page-size=16384',
        PATH=f'{tools}{os.pathsep}{toolbin}{os.pathsep}' + os.environ.get('PATH', ''))

    def run(name, argv, cwd):
        commands.append(dict(name=name, argv=[str(arg) for arg in argv], cwd=str(cwd),
            environment={key: env[key] for key in (
                'CC', 'AR', 'RANLIB', 'PYTHON', 'PYTHONHASHSEED', 'PKG_CONFIG_PATH', 'PKG_CONFIG_LIBDIR',
                'CPPFLAGS', 'CFLAGS', 'LDFLAGS', 'LOADER_LDFLAGS', 'PROOT_WITH_LIBANDROID_SHMEM',
                'PROOT_UNBUNDLE_LOADER') if key in env}))
        with (logs / f'{name}.log').open('w') as stream:
            result = subprocess.run(argv, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT)
        if result.returncode:
            raise ValueError(f'{name} failed ({result.returncode}); log: {logs / (name + ".log")}')
        print(f'{abi}: {name} passed', flush=True)

    talloc = source['libtalloc']
    shutil.copyfile(ADAPTERS / 'talloc-cross-answers.txt', talloc / 'cross-answers.txt')
    run('talloc-configure', [sys.executable, 'buildtools/bin/waf', 'configure', '--prefix=' + str(stage),
        '--disable-rpath', '--disable-python', '--cross-compile', '--cross-answers=cross-answers.txt'], talloc)
    run('talloc-build', [sys.executable, 'buildtools/bin/waf', 'build', '--targets=talloc', '-j4'], talloc)
    shutil.copyfile(talloc / 'talloc.h', stage / 'include/talloc.h')
    shutil.copyfile(talloc / 'bin/default/libtalloc.so', stage / 'lib/libtalloc.so')
    shmem = source['libandroid-shmem']
    shutil.copyfile(shmem / 'shm.h', stage / 'include/sys/shm.h')
    run('shmem-build', [str(cc), '-shared', '-fPIC', '-O2', f'-ffile-prefix-map={work}=/usr/src/pocket-harness/proot',
        '-Wl,-soname,libandroid-shmem.so', '-Wl,-z,max-page-size=16384', 'shmem.c',
        '-o', str(stage / 'lib/libandroid-shmem.so'), '-llog', '-landroid'], shmem)
    version = records['proot']['version'] + '-pocket-source.1'
    env.update(STRIP=str(toolbin / 'llvm-strip'), OBJCOPY=str(toolbin / 'llvm-objcopy'),
        OBJDUMP=str(toolbin / 'llvm-objdump'), CPPFLAGS=f'-DARG_MAX=131072 -DVERSION=\\"{version}\\" -I{stage}/include',
        CFLAGS=env['CFLAGS'] + ' -fPIE', LDFLAGS=env['LDFLAGS'] + f' -L{stage}/lib',
        LOADER_LDFLAGS='-Wl,-z,max-page-size=16384', PROOT_WITH_LIBANDROID_SHMEM='true',
        PROOT_UNBUNDLE_LOADER='/__pocketharness_loader_required__')
    run('proot-build', ['make', '-C', str(source['proot'] / 'src'), '-j4', 'GIT=false', 'HAS_LOADER_32BIT='], work)
    native_dir = work / 'native' / android_abi
    native_dir.mkdir(parents=True)
    for name, path in zip(OUTPUTS, (source['proot'] / 'src/proot', source['proot'] / 'src/loader/loader',
                                   stage / 'lib/libtalloc.so', stage / 'lib/libandroid-shmem.so')):
        shutil.copyfile(path, native_dir / name)
        (native_dir / name).chmod(0o755)
    payloads = check_bundle(native_dir, abi)
    adapters = {path.name: native.sha256_file(path) for path in sorted(ADAPTERS.iterdir()) if path.is_file()}
    compiler_version = subprocess.check_output([str(cc), '--version'], text=True).splitlines()[0]
    report = dict(schemaVersion=1, abi=abi, androidApi=API, sourceBuild=True, deviceValidation='not-run',
        ndkRevision=NDK_REVISION, compilerVersion=compiler_version, hostAwk=awk,
        compilerExecutableSha256=native.sha256_file((toolbin / 'clang').resolve()),
        ndkPropertiesSha256=native.sha256_file(ndk / 'source.properties'), sources=records, sourcePatches=changes,
        adapterSha256=adapters, buildScriptSha256=native.sha256_file(Path(__file__)),
        sourceLockSha256=native.sha256_file(HERE / 'linux-backend-packages.json'),
        buildVersion=version, commands=commands, environment={key: env[key] for key in (
            'CC', 'AR', 'RANLIB', 'PYTHONHASHSEED', 'PKG_CONFIG_LIBDIR', 'CPPFLAGS', 'CFLAGS', 'LDFLAGS',
            'LOADER_LDFLAGS', 'PROOT_WITH_LIBANDROID_SHMEM', 'PROOT_UNBUNDLE_LOADER')},
        nativeLibraries=payloads, workDirectory=str(work))
    parent.mkdir(exist_ok=True)
    native_dir.rename(final)
    with receipt.open('x') as stream:
        json.dump(report, stream, indent=2)
        stream.write('\n')
    print(f'PASS source-built {abi} PRoot closure; device validation NOT RUN; {receipt}', flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sources', nargs='?')
    parser.add_argument('ndk', nargs='?')
    parser.add_argument('output', nargs='?')
    parser.add_argument('--abi', choices=ABIS)
    parser.add_argument('--download-sources')
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        import unittest
        suite = unittest.defaultTestLoader.discover(str(HERE), pattern='test_proot_source_build.py')
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        if result.testsRun == 0 or result.skipped or not result.wasSuccessful():
            raise SystemExit(1)
    elif args.download_sources:
        fetch_sources(args.download_sources)
    elif all((args.sources, args.ndk, args.output, args.abi)):
        build(args.sources, args.ndk, args.output, args.abi)
    else:
        parser.error('sources, ndk, output and --abi are required')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, tarfile.TarError, zipfile.BadZipFile) as error:
        print(f'PRoot source build: {error}', file=sys.stderr)
        raise SystemExit(1)
