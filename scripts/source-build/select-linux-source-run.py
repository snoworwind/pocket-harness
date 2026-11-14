#!/usr/bin/env python3
"""Accept only a successful maintained dual-ABI draft workflow as a test-runtime source."""
import json
import re
import sys
from pathlib import Path


def select(run, repository):
    if (run.get('repository', {}).get('full_name') != repository
            or run.get('head_repository', {}).get('full_name') != repository
            or run.get('path') != '.github/workflows/release-source-draft.yml'
            or run.get('head_branch') != 'main' or run.get('status') != 'completed'
            or run.get('conclusion') != 'success'
            or run.get('event') not in ('workflow_dispatch', 'workflow_call')
            or not re.fullmatch(r'[a-f0-9]{40}', run.get('head_sha', ''))):
        raise ValueError('source must be a successful main release-source-draft run in this repository')
    return run['head_sha']


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        import unittest
        tests = unittest.defaultTestLoader.discover(str(Path(__file__).parent), pattern='test_linux_source_run.py')
        result = unittest.TextTestRunner().run(tests)
        raise SystemExit(0 if result.wasSuccessful() and result.testsRun else 1)
    print('commit=' + select(json.loads(open(sys.argv[1]).read()), sys.argv[2]))
