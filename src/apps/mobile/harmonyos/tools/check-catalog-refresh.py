#!/usr/bin/env python3
"""Exercise the installed debug HAP's isolated catalog fixture on a real device.

Runs in the current screen posture. Always returns to the normal App afterward.
No account, remote workspace, or session is changed by the fixture.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

BUNDLE_CONTRACT = (Path(__file__).resolve().parent.parent
                   / 'entry/src/main/ets/services/HarmonyUpgradeIdentityContract.ets')


def app_bundle():
    """Read the retained install identity from its single declared boundary."""
    match = re.search(r"APP_BUNDLE:\s*string\s*=\s*'([^']+)'", BUNDLE_CONTRACT.read_text(encoding='utf-8'))
    if match is None:
        raise SystemExit(f'App bundle id not found in {BUNDLE_CONTRACT}')
    return match.group(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hdc', default=os.environ.get('HDC', 'hdc'))
    parser.add_argument('--device', help='HDC target when multiple devices are attached')
    parser.add_argument('--dark', action='store_true')
    args = parser.parse_args()
    command = [args.hdc] + (['-t', args.device] if args.device else [])
    output = Path(tempfile.mkdtemp(prefix='openbitfun-catalog-'))
    print(f'Evidence: {output}', flush=True)

    def run(*parts):
        return subprocess.check_output(command + list(parts), text=True, timeout=30)

    def start(preview=False):
        bundle = app_bundle()
        run('shell', 'aa', 'force-stop', bundle)
        params = ['shell', 'aa', 'start', '-a', 'EntryAbility', '-b', bundle]
        if preview:
            params += ['--ps', 'openbitfunDesignPreview',
                       'catalog-refresh-dark' if args.dark else 'catalog-refresh']
        run(*params)

    def layout(label):
        remote = run('shell', 'uitest', 'dumpLayout').strip().split('saved to:')[-1]
        local = output / f'{label}.json'
        run('file', 'recv', remote, str(local))
        nodes = []

        def walk(node):
            nodes.append(node.get('attributes', {}))
            for child in node.get('children', []):
                walk(child)

        walk(json.loads(local.read_text()))
        return nodes

    def click(nodes, field, value):
        node = next(node for node in nodes if node.get(field) == value)
        left, top, right, bottom = map(int, re.findall(r'-?\d+', node['bounds']))
        run('shell', 'uitest', 'uiInput', 'click', str((left + right) // 2), str((top + bottom) // 2))
        time.sleep(0.4)

    try:
        for mode in ['sidebar', 'recent', 'all', 'projects', 'picker']:
            start(preview=True)
            initial = []
            for _ in range(8):
                time.sleep(0.5)
                initial = layout(f'{mode}-initial')
                if any(node.get('id') == f'catalog-{mode}' for node in initial):
                    break
            click(initial, 'id', f'catalog-{mode}')
            before = layout(f'{mode}-before')
            expected_before = 'Workspace before' if mode == 'picker' else 'Session before'
            assert any(node.get('text') == expected_before for node in before), mode
            click(before, 'id', 'catalog-replace')
            after = layout(f'{mode}-after')
            texts = [node.get('text') for node in after]
            assert 'Source: Session after' in texts, 'Fixture replacement did not run'
            assert 'Session before' not in texts and 'Workspace before' not in texts, mode
            expected = 'Workspace after' if mode == 'picker' else 'Session after'
            assert expected in texts, (mode, texts)
            if mode in ['sidebar', 'projects', 'picker']:
                assert 'Workspace after' in texts, mode
            if mode == 'all':
                assert 'completed' in texts and 'idle' not in texts, 'Session status did not refresh'
            click(after, 'text', expected)
            selected = next(node.get('text') for node in layout(f'{mode}-tap')
                            if node.get('id') == 'catalog-selected')
            assert selected == ('/preview-after' if mode == 'picker' else 'Session after'), (mode, selected)
            print(f'PASS {mode}: same-ID content and click use the current snapshot', flush=True)
        remote_image = '/data/local/tmp/openbitfun-catalog-refresh.jpeg'
        run('shell', 'snapshot_display', '-f', remote_image)
        run('file', 'recv', remote_image, str(output / 'catalog-refresh.jpeg'))
    finally:
        start()


if __name__ == '__main__':
    main()
