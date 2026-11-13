#!/usr/bin/env python3
"""Factory Linux home privacy and profile contracts; never read live user data."""
import json
from pathlib import Path
import re
import sys


def check(home):
    home = Path(home)
    if home.is_symlink() or not home.is_dir():
        raise ValueError('factory home must be a real directory')
    for path in home.rglob('*'):
        relative = path.relative_to(home).as_posix()
        if re.search(r'(^|/)(?:\.credentials|sessions|storages|\.anonymous-user-id|\.npmrc|settings\.yaml\.imported)(/|$)', relative, re.I):
            raise ValueError('private runtime data in factory home: ' + relative)
        if '@dsh-android' in relative and relative.endswith('.js.map'):
            raise ValueError('private source map in factory home')
    settings = home / '.dsh/settings.yaml'
    if not settings.is_file() or settings.is_symlink() or not settings.read_text().strip():
        raise ValueError('missing regular factory settings')
    if re.search(r'sk-|apiKey\s*:\s*\S|api[_-]?key\s*=\s*\S|BEGIN (?:RSA|OPENSSH|PRIVATE)', settings.read_text(), re.I):
        raise ValueError('secret in factory settings')
    for name in ('web', 'headless'):
        profile = home / '.dsh/profiles' / name
        bundles = json.loads((profile / 'package.json').read_text()).get('dsh', {}).get('profile', {}).get('bundles')
        if not isinstance(bundles, list) or not bundles or len(bundles) != len(set(bundles)):
            raise ValueError('invalid factory profile bundles: ' + name)
        patch = (profile / 'cordis.patch.yml').read_text()
        for expected in ('bashPath: /usr/bin/bash', 'prefix: /usr', 'home: /home', 'cwd: /home'):
            if expected not in patch:
                raise ValueError('missing guest path: ' + expected)
        if '/data/data/' in patch or '/data/user/0/' in patch:
            raise ValueError('host path in guest profile')
    return True


if __name__ == '__main__':
    check(sys.argv[1])
    print('Linux factory home privacy and profiles verified')
