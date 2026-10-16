#!/usr/bin/env python3
"""Check reused rollback panes at compact/wide widths over the isolated mock host.

Install the debug HAP first. Run on a wide device/emulator to cover both widths.
The fixture and its resize control retain the production ConversationView.
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
    args = parser.parse_args()
    command = [args.hdc] + (['-t', args.device] if args.device else [])
    output = Path(tempfile.mkdtemp(prefix='openbitfun-rollback-isolation-'))
    contract = Path(__file__).resolve().parent.parent / 'entry/src/main/ets/services/HarmonyUpgradeIdentityContract.ets'
    bundle = re.search(r"APP_BUNDLE:\s*string\s*=\s*'([^']+)'", contract.read_text()).group(1)
    print(f'Evidence: {output}', flush=True)

    def run(*parts):
        return subprocess.check_output(command + list(parts), text=True, timeout=30)

    def start(scenario=None):
        run('shell', 'aa', 'force-stop', bundle)
        time.sleep(0.4)
        parts = ['shell', 'aa', 'start', '-a', 'EntryAbility', '-b', bundle]
        if scenario:
            parts += ['--ps', 'openbitfunDesignPreview', scenario]
        run(*parts)
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

    def node_id(nodes, identity):
        return next(n for n in nodes if n.get('id') == identity)

    def click(node, long=False):
        left, top, right, bottom = map(int, re.findall(r'-?\d+', node['bounds']))
        run('shell', 'uitest', 'uiInput', 'longClick' if long else 'click',
            str((left + right) // 2), str((top + bottom) // 2))
        time.sleep(0.4)

    def capture(label):
        remote = f'/data/local/tmp/{label}.jpeg'
        run('shell', 'snapshot_display', '-f', remote)
        run('file', 'recv', remote, str(output / f'{label}.jpeg'))

    def staged(nodes):
        return any(n.get('text') in ['回滚到', 'Roll back to'] for n in nodes)

    try:
        for dark in [False, True]:
            for compact in [False, True]:
                label = f'{"dark" if dark else "light"}-{"compact" if compact else "wide"}'
                start('copy-rollback-dark' if dark else 'copy-rollback')
                nodes = []
                for attempt in range(8):
                    nodes = layout(f'{label}-initial-{attempt}')
                    if any(n.get('id') == 'rollback-preview-scenario' for n in nodes):
                        break
                    time.sleep(0.5)
                if compact:
                    click(node_id(nodes, 'rollback-preview-resize'))
                    nodes = layout(f'{label}-compact')
                geometry = node_id(nodes, 'rollback-preview-scenario')['text']
                width = int(re.search(r'\bw=(\d+)', geometry).group(1))
                if compact:
                    assert width == 360, geometry
                else:
                    assert width >= 840, geometry
                prompt = next(n for n in nodes if n.get('text', '').startswith('请按下面的清单'))
                click(prompt, long=True)
                nodes = layout(f'{label}-menu')
                entry = next(n for n in nodes if n.get('text') in ['回滚到此消息', 'Roll back to this message'])
                click(entry)
                nodes = layout(f'{label}-staged')
                assert staged(nodes), f'{label}: rollback was not staged'
                capture(f'{label}-staged')
                # Preserve staging while the same component changes posture.
                click(node_id(nodes, 'rollback-preview-resize'))
                nodes = layout(f'{label}-resized')
                assert staged(nodes), f'{label}: resize lost staging'
                click(node_id(nodes, 'rollback-preview-switch-session'))
                nodes = layout(f'{label}-session-b')
                assert not staged(nodes), f'{label}: A staging leaked into B'
                assert node_id(nodes, 'conversation-composer-input').get('text') == 'SESSION-B-DRAFT'
                assert node_id(nodes, 'rollback-preview-notice').get('text') == 'notice=(none)'
                assert node_id(nodes, 'rollback-preview-host')['text'].startswith('host=(none)')
                capture(f'{label}-session-b')
                print(f'{label}: resize retained staging; switch cleared it and kept B draft', flush=True)
    finally:
        start()


if __name__ == '__main__':
    main()
