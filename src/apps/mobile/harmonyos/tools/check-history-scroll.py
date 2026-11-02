#!/usr/bin/env python3
"""Check history/jump interaction using native rows and a held mock response.

Install the debug HAP first. Runs compact/wide widths and a live resize, then
returns to the normal app without changing account or remote session data.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hdc', default=os.environ.get('HDC', 'hdc'))
    parser.add_argument('--device')
    parser.add_argument('--expect-bug', action='store_true')
    args = parser.parse_args()
    command = [args.hdc] + (['-t', args.device] if args.device else [])
    output = Path(tempfile.mkdtemp(prefix='openbitfun-history-scroll-'))
    print(f'Evidence: {output}', flush=True)
    contract = (Path(__file__).resolve().parent.parent /
                'entry/src/main/ets/services/HarmonyUpgradeIdentityContract.ets')
    bundle = re.search(r"APP_BUNDLE:\s*string\s*=\s*'([^']+)'", contract.read_text()).group(1)

    def run(*parts):
        return subprocess.check_output(command + list(parts), text=True, timeout=30)

    def start(preview=False):
        run('shell', 'aa', 'force-stop', bundle)
        params = ['shell', 'aa', 'start', '-a', 'EntryAbility', '-b', bundle]
        if preview:
            params += ['--ps', 'openbitfunDesignPreview', 'history-scroll']
        run(*params)
        time.sleep(1)

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
        node = next(n for n in nodes if n.get(field) == value)
        left, top, right, bottom = map(int, re.findall(r'-?\d+', node['bounds']))
        run('shell', 'uitest', 'uiInput', 'click', str((left + right) // 2), str((top + bottom) // 2))
        time.sleep(0.3)

    def capture(label):
        remote = f'/data/local/tmp/{label}.jpeg'
        run('shell', 'snapshot_display', '-f', remote)
        run('file', 'recv', remote, str(output / f'{label}.jpeg'))

    try:
        for compact in [False, True]:
            for failure in [False, True]:
                label = f'{"compact" if compact else "wide"}-{"failure" if failure else "success"}'
                start(True)
                nodes = layout(f'{label}-initial')
                if compact:
                    click(nodes, 'id', 'history-resize')
                    nodes = layout(f'{label}-resized')
                # The fixture opens at the start, exposing the real paging entry.
                header = next(n for n in nodes if n.get('text') in ['加载更早消息', 'Load older messages'])
                click(nodes, 'text', header['text'])
                nodes = layout(f'{label}-loading')
                assert any('loading=true' in n.get('text', '') for n in nodes)
                click(nodes, 'id', 'chat-timeline-jump')
                nodes = layout(f'{label}-jump')
                click(nodes, 'id', 'history-fail' if failure else 'history-complete')
                time.sleep(1)
                nodes = layout(f'{label}-settled')
                tail = any(n.get('text') == 'History probe page-0-row-19' for n in nodes)
                jump = any(n.get('id') == 'chat-timeline-jump' for n in nodes)
                capture(label)
                print(f'{label}: tail_visible={tail} jump_visible={jump}', flush=True)
                assert tail != args.expect_bug, f'{label}: unexpected tail visibility'
                if not args.expect_bug:
                    assert not jump, f'{label}: jump should hide at the tail'
    finally:
        start()


if __name__ == '__main__':
    main()
