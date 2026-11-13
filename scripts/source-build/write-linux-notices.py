#!/usr/bin/env python3
"""Generate product notices from Linux build receipts, never the retired Termux inventory."""
import json
from pathlib import Path
import sys


def generate(repository, destination):
    root = Path(repository)
    proof = root / '.deploy-tmp/linux-build/provenance'
    rows = (proof / 'debian-packages.tsv').read_text().splitlines()
    if not rows or any(len(row.split('\t')) != 4 for row in rows):
        raise ValueError('missing complete Debian package source inventory')
    inputs = json.loads((root / 'scripts/source-build/linux-inputs.json').read_text())
    source = json.loads((root / '.deploy-tmp/engine-overlay/source-build-manifest.json').read_text())
    text = ['# Pocket Harness Linux runtime notices', '',
            'This APK includes a Debian ARM64 guest, official Node.js, source-built Harness packages, and Android host libraries.',
            'Debian copyright and license files are retained inside rootfs.tar.xz under usr/share/doc/<package>/copyright.',
            'Node.js and bundled npm notices are retained in node.tar.xz; the installed Node root is /opt/node.',
            'Host PRoot, loader and dependency licenses are included beside this notice in linux-native/.',
            'The matching source archives and build receipts accompany the APK artifact.', '',
            f'Node.js: {inputs["node"]}; pnpm: {inputs["pnpm"]["version"]}.', '',
            '## Debian binary and source packages', '', '| Binary | Version | Source | Source version |', '|---|---|---|---|']
    for row in sorted(rows):
        text.append('| ' + ' | '.join(value.replace('|', '\\|') for value in row.split('\t')) + ' |')
    text += ['', '## Source-built Harness packages', '', f'Source commit: {source["commit"]}', '', '| Package | Version |', '|---|---|']
    for package in sorted(source['packages'], key=lambda package: package['name']):
        text.append(f'| {package["name"]} | {package["version"]} |')
    text += ['', 'npm dependencies retain their upstream package manifests and distributed license files inside engine.tar.xz and home.tar.xz.', '']
    Path(destination).write_text('\n'.join(text))


if __name__ == '__main__':
    generate(*sys.argv[1:])
