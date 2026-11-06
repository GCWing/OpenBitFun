/** Build-only synchronous attribution. Never imported by the ordinary product build. */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../../src/web-ui/package.json', import.meta.url));
const ts = require('typescript');
const prefix = 'src/web-ui/src/flow_chat/';
export const syncWorkTargets = new Map([
  [`${prefix}store/FlowChatStore.ts`, new Set(['setState', 'notifyListeners', 'updateModelRoundItem', 'batchUpdateModelRoundItems', 'addModelRoundItem'])],
  [`${prefix}store/modernFlowChatStore.ts`, '*'],
  [`${prefix}services/storeSync.ts`, '*'],
  [`${prefix}services/flow-chat-manager/ToolEventModule.ts`, '*'],
  [`${prefix}services/flow-chat-manager/EventHandlerModule.ts`, new Set(['handleToolEvent', 'processBatchedEvents', 'handleModelRoundStart'])],
  [`${prefix}components/FlowToolCard.tsx`, '*'],
  [`${prefix}components/modern/ModernFlowChatContainer.tsx`, '*'],
  [`${prefix}components/modern/VirtualMessageList.tsx`, '*'],
  [`${prefix}components/modern/useFlowChatVirtualizer.ts`, '*'],
  [`${prefix}tool-cards/ExecCommandToolCard.tsx`, '*'],
  [`${prefix}tool-cards/ExecProcessToolCardView.tsx`, '*'],
]);

export function instrumentSyncWork(source, filename, selected = '*') {
  if (source.includes('__openbitfunWorkRecorder')) throw new Error('Diagnostic identifier collision');
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true,
    filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const inserts = [], labels = [];
  const visit = node => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node)) && node.body && ts.isBlock(node.body) && !node.asteriskToken
      && !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
      let name = node.name?.getText(tree);
      const parent = node.parent;
      if (!name && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent))) name = parent.name.getText(tree);
      if (!name && ts.isCallExpression(parent)) {
        const call = parent.expression.getText(tree).split('.').at(-1);
        if (ts.isVariableDeclaration(parent.parent)) name = parent.parent.name.getText(tree);
        else if (['useEffect', 'useLayoutEffect', 'useIsomorphicLayoutEffect', 'useClientLayoutEffect'].includes(call)) name = call;
      }
      if (name && (selected === '*' || selected.has(name))) {
        const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
        const label = `${filename}:${line}:${name}`;
        labels.push(label);
        inserts.push({ at: node.body.getStart(tree) + 1, order: 0,
          text: `\nconst __openbitfunWorkRecorder = globalThis.__openbitfunSyncWork; const __openbitfunWorkToken = __openbitfunWorkRecorder?.begin(${JSON.stringify(label)}); try {\n` });
        inserts.push({ at: node.body.end - 1, order: 1,
          text: '\n} finally { __openbitfunWorkRecorder?.end(__openbitfunWorkToken); }\n' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  let code = source;
  // Empty blocks have identical insertion positions. Apply the suffix first
  // so the final source still places the prefix before it.
  for (const insertion of inserts.sort((a, b) => b.at - a.at || b.order - a.order)) {
    code = code.slice(0, insertion.at) + insertion.text + code.slice(insertion.at);
  }
  return { code, labels };
}

/** Scalars only. Inclusive timings overlap; selfMs subtracts instrumented children. */
export function createSyncWorkProbe(now) {
  const stack = [], groups = new Map(), spans = [];
  let mismatchCount = 0, droppedSpans = 0, active = true;
  return {
    begin(label) {
      if (!active) return;
      const token = { label, at: now(), childrenMs: 0 };
      stack.push(token); return token;
    },
    end(token) {
      if (!token) return;
      const endedAt = now(), duration = endedAt - token.at;
      if (stack.pop() !== token) mismatchCount++;
      if (stack.length) stack.at(-1).childrenMs += duration;
      const group = groups.get(token.label) ?? { label: token.label, calls: 0, totalMs: 0, selfMs: 0, maxMs: 0 };
      group.calls++; group.totalMs += duration;
      group.selfMs += Math.max(0, duration - token.childrenMs); group.maxMs = Math.max(group.maxMs, duration);
      groups.set(token.label, group);
      if (duration >= 2) {
        if (spans.length < 2000) spans.push({ label: token.label, at: token.at, endedAt, durationMs: duration });
        else droppedSpans++;
      }
    },
    stop() {
      active = false;
      return { groups: [...groups.values()].sort((a, b) => b.selfMs - a.selfMs), spans,
        mismatchCount, droppedSpans, stackDepth: stack.length };
    },
  };
}

export function syncWorkPlugin() {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const instrumented = [];
  return {
    name: 'openbitfun-e2e-sync-work-diagnostic', enforce: 'pre',
    transform(code, id) {
      const filename = id.split('?')[0].slice(root.length);
      const selected = syncWorkTargets.get(filename);
      if (!selected) return null;
      const result = instrumentSyncWork(code, filename, selected);
      instrumented.push(...result.labels);
      return { code: result.code, map: null };
    },
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { name: 'openbitfun-sync-work-diagnostic', content: '1' }, injectTo: 'head' }];
    },
    generateBundle() {
      if (instrumented.length === 0) throw new Error('No synchronous work was instrumented');
      this.emitFile({ type: 'asset', fileName: 'sync-work-instrumentation.json',
        source: JSON.stringify({ diagnosticOnly: true, labels: instrumented.sort(),
          limitations: ['Synchronous selected functions only; excludes React internals and browser layout outside their calls.',
            'Probes add overhead. Inclusive timings overlap; self timings subtract instrumented descendants.'] }, null, 2) });
    },
  };
}

export async function startSyncWorkProbe(page) {
  return page.execute(source => {
    if (!document.querySelector('meta[name="openbitfun-sync-work-diagnostic"]')) throw new Error('Diagnostic frontend required');
    if (globalThis.__openbitfunSyncWork) throw new Error('Synchronous work probe already active');
    globalThis.__openbitfunSyncWork = (0, eval)(`(${source})`)(() => performance.now());
  }, createSyncWorkProbe.toString());
}

export async function stopSyncWorkProbe(page) {
  return page.execute(() => {
    const result = globalThis.__openbitfunSyncWork?.stop();
    delete globalThis.__openbitfunSyncWork; return result;
  });
}
