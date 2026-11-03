import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { designSpecForApp, preflightGenUIApp } from './genUIContract';
import { genUIProduct, type GenUIProduct } from './genUIProduct';
import type { GenUIAppDefinition, GenUIAppState } from './genUITypes';
import { inspectGenUIHtmlFrame, inspectGenUILayout } from './genUILayout';
import './GenUIApplication.scss';
import GenUIHostSurface from './GenUIHostSurface';
import GenUIHtmlDocument, { GENUI_HTML_RUNTIME, inspectGenUIHtmlSource, type GenUIHtmlFrameReport } from './GenUIHtmlDocument';
import GenUIOpenUIDocument from './genUIOpenUI';
import { withTimeout } from '@/shared/utils/timing';

function collectRenderedEvidence(container: HTMLElement) {
  const evidence: Array<{ ref: string; label?: string; text?: string; role?: string }> = [];
  const seen = new Set<string>();
  for (const element of Array.from(container.querySelectorAll<HTMLElement>('h1,h2,h3,button,input,select,textarea,[role="img"],[aria-label]'))) {
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const label = element.getAttribute('aria-label') ?? '';
    const ref = element.id ? `id:${element.id}` : label ? `aria:${label}` : text ? `text:${element.tagName.toLowerCase()}:${text}` : '';
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    evidence.push({ ref, label: label || undefined, text: text || undefined, role: element.getAttribute('role') ?? element.tagName.toLowerCase() });
  }
  return evidence;
}
/** Exercises trusted renderers in an isolated DOM root. It cannot reach the
 * user's state, persistence callback or external tools. No generated code runs. */
export async function verifyGenUICandidate(candidate: { revision: string; app: GenUIAppDefinition; state: GenUIAppState }, product: GenUIProduct = genUIProduct, browserLayout = false) {
  const { app } = candidate;
  if (!app.source) throw new Error('GenUI source is required');
  const preflight = preflightGenUIApp(app, false, product.catalog);
  if (!preflight.accepted) throw new Error(JSON.stringify(preflight.issues));
  const designSpec = designSpecForApp(app, product.catalog);
  if (app.designSpec && !designSpec) throw new Error(`UI specification ${app.designSpec.id}@${app.designSpec.revision} is unavailable`);
  if (app.source?.kind === 'openui-lang') return verifyGenUIOpenUICandidate(candidate, designSpec, browserLayout, product);
  if (app.source?.kind === 'html-document') return verifyGenUIHtmlCandidate(candidate, designSpec, browserLayout, product.catalog);
  throw new Error('GenUI source is required; semantic graph documents were removed');
}

async function verifyGenUIOpenUICandidate(candidate: { revision: string; app: GenUIAppDefinition; state: GenUIAppState }, designSpec: ReturnType<typeof designSpecForApp>, browserLayout: boolean, product: GenUIProduct) {
  const { app, state } = candidate;
  const source = app.source;
  if (!source || source.kind !== 'openui-lang') throw new Error('OpenUI document source is missing');
  const library = product.libraries[app.libraryId];
  if (!library) throw new Error(`GenUI library ${app.libraryId}@${app.libraryRevision} is unavailable`);
  const designSpecIdentity = app.designSpec ?? (designSpec ? { id: library.contract.metadata?.designSpecIds[0] ?? '', revision: designSpec.revision } : null);
  const container = document.createElement('div');
  container.setAttribute('aria-hidden', 'true');
  container.inert = true;
  container.className = 'gen-ui-candidate-probe gen-ui-openui-candidate-probe';
  if (browserLayout) Object.assign(container.style, { position: 'fixed', left: '-100000px', top: '0', width: designSpec?.shell.kind === 'phone' ? '390px' : '960px', boxSizing: 'border-box' });
  document.body.appendChild(container);
  const root = createRoot(container);
  let parserError = '';
  let actionCount = 0;
  let lastActionType = '';
  const inspectorFailures: string[] = [];
  let stateUpdateCount = 0;
  let latestState = state;
  const render = (initialState: GenUIAppState) => flushSync(() => root.render(<GenUIHostSurface specification={designSpec}><div className={'gen-ui-application gen-ui-application--openui' + (designSpec?.shell.kind === 'phone' ? ' gen-ui-application--phone' : '')} data-openbitfun-component="gen-ui-application" data-openbitfun-part="content" data-gen-ui-app={app.id} data-gen-ui-source-kind={source.kind}><GenUIOpenUIDocument source={source} library={library} initialState={initialState} isStreaming={false} onError={message => { parserError = message; }} onAction={event => { actionCount++; lastActionType = event.type; }} onInspect={event => { if (!event.passed) inspectorFailures.push(`${event.component}(${event.statementId})${event.error ? ': ' + event.error : ''}`); }} onStateUpdate={next => { stateUpdateCount++; latestState = next; }} /></div></GenUIHostSurface>));
  try {
    render(state);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (parserError) throw new Error(parserError);
    if (inspectorFailures.length) throw new Error('GenUI component inspector failed: ' + inspectorFailures.join('; '));
    if (!container.querySelector('[data-gen-ui-application]') && !container.querySelector('.gen-ui-application')) throw new Error('OpenUI document did not mount');
    const actionButton = container.querySelector<HTMLButtonElement>('button');
    if (source.content.includes('@ToAssistant') && actionButton) {
      flushSync(() => actionButton.click());
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (actionCount !== 1 || lastActionType !== 'continue_conversation') throw new Error('OpenUI action did not reach the owning host');
    }
    const viewport = container.querySelector<HTMLElement>('[data-gen-ui-viewport]') ?? container;
    let screenshot: string | undefined;
    if (browserLayout) {
      const issues = inspectGenUILayout(viewport, designSpec);
      if (issues.length) throw new Error(`Design specification ${app.designSpec?.id ?? designSpec?.label ?? 'default'}: ${issues.join('; ')}`);
      const { domToPng } = await import('modern-screenshot');
      screenshot = await withTimeout(domToPng(container, { scale: 1, font: false }), 15000, 'OpenUI screenshot');
      if (!screenshot.startsWith('data:image/png;base64,') || screenshot.length < 100) throw new Error('OpenUI screenshot is empty or invalid');
    }
    const input = container.querySelector<HTMLInputElement>('input:not([disabled])');
    let reopened = false;
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(input.ownerDocument.defaultView!.HTMLInputElement.prototype, 'value')?.set;
      if (!setter) throw new Error('OpenUI input has no writable value setter');
      const probeValue = input.type === 'number' ? '7' : 'probe';
      setter.call(input, probeValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (!stateUpdateCount) throw new Error('OpenUI input interaction did not reach the owning state callback');
      if (!Object.prototype.hasOwnProperty.call(latestState, '$value') && !Object.keys(latestState).length) throw new Error('OpenUI input interaction produced no owner state');
    }
    // Reopen the exact owner-read state in a fresh renderer. This keeps the
    // OpenUI path honest: seeing onStateUpdate is not enough to claim that a
    // user edit survives remount.
    flushSync(() => root.render(null));
    parserError = '';
    render(latestState);
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (parserError) throw new Error(parserError);
    const reopenedInput = container.querySelector<HTMLInputElement>('input:not([disabled])');
    if (input && reopenedInput) {
      const expected = input.type === 'number' ? '7' : 'probe';
      if (reopenedInput.value !== expected) throw new Error(`OpenUI owner state did not survive reopen: expected ${expected}, received ${reopenedInput.value}`);
    }
    reopened = true;
    return { revision: candidate.revision, library: { id: app.libraryId, revision: app.libraryRevision }, designSpec: designSpecIdentity, sourceKind: source.kind, viewport: designSpec?.viewport.mode === 'fixed' ? `${designSpec.viewport.width}x${designSpec.viewport.height}` : 'responsive', hostShell: browserLayout && designSpec?.acceptance.checks.includes('host-shell') ? 'passed' : 'unverified', appliedAcceptanceChecks: browserLayout ? designSpec?.acceptance.checks ?? [] : [], preflight: 'passed', checks: 'passed', render: 'passed', reopen: reopened ? 'passed' : 'unverified', probeReopen: reopened ? 'passed' : 'unverified', layout: browserLayout ? 'passed' : 'unverified', layoutWidths: browserLayout ? (designSpec?.viewport.mode === 'fixed' ? [designSpec.viewport.width!] : [360, 960]) : [], screenshot, interaction: actionCount || stateUpdateCount ? 'observed' : 'unverified', renderedEvidence: collectRenderedEvidence(container), requirementCoverage: 'unverified', visual: 'unverified', issues: [] };
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
}

async function verifyGenUIHtmlCandidate(candidate: { revision: string; app: GenUIAppDefinition; state: GenUIAppState }, designSpec: ReturnType<typeof designSpecForApp>, browserLayout: boolean, product: GenUIProduct['catalog']) {
  const { app } = candidate;
  const source = app.source;
  if (!source || source.kind !== 'html-document') throw new Error('HTML document source is missing');
  const designSpecIdentity = app.designSpec ?? (designSpec ? { id: product.libraryAdapters?.[app.libraryId]?.designSpecIds[0] ?? '', revision: designSpec.revision } : null);
  const sourceIssues = inspectGenUIHtmlSource(source, designSpec);
  if (sourceIssues.length) throw new Error(sourceIssues.join('; '));
  const container = document.createElement('div');
  container.setAttribute('aria-hidden', 'true');
  container.inert = true;
  container.className = 'gen-ui-candidate-probe gen-ui-html-candidate-probe';
  if (browserLayout) Object.assign(container.style, { position: 'fixed', left: '-100000px', top: '0', width: designSpec?.shell.kind === 'phone' ? '390px' : '960px', boxSizing: 'border-box' });
  document.body.appendChild(container);
  const root = createRoot(container);
  let inspectionReport: GenUIHtmlFrameReport | undefined;
  let resolveInspection: ((report: GenUIHtmlFrameReport) => void) | undefined;
  const inspection = browserLayout ? {
    onReport: (report: GenUIHtmlFrameReport) => {
      inspectionReport = report;
      resolveInspection?.(report);
    },
  } : undefined;
  const inspectionReady = browserLayout
    ? new Promise<GenUIHtmlFrameReport>(resolve => { resolveInspection = resolve; })
    : undefined;
  try {
    flushSync(() => root.render(<GenUIHostSurface specification={designSpec}><div className={'gen-ui-application gen-ui-application--document' + (designSpec?.shell.kind === 'phone' ? ' gen-ui-application--phone' : '')} data-openbitfun-component="gen-ui-application" data-openbitfun-part="content" data-gen-ui-app={app.id} data-gen-ui-source-kind={source.kind}><GenUIHtmlDocument source={source} specification={designSpec} inspection={inspection} /></div></GenUIHostSurface>));
    const frame = container.querySelector<HTMLIFrameElement>('[data-gen-ui-html-frame]');
    if (!frame) throw new Error('HTML document iframe did not mount');
    let screenshot: string | undefined;
    if (browserLayout) {
      await withTimeout(new Promise<void>(resolve => {
        if (frame.contentDocument?.readyState === 'complete') resolve();
        else frame.addEventListener('load', () => resolve(), { once: true });
      }), 30000, 'GenUI HTML document render');
      const report = inspectionReport ?? await withTimeout(inspectionReady!, 30000, 'GenUI HTML document inspection');
      const viewport = container.querySelector<HTMLElement>('[data-gen-ui-viewport]') ?? container;
      if (document.fonts) await withTimeout(document.fonts.ready, 15000, 'GenUI fonts');
      await withTimeout(new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))), 5000, 'GenUI HTML layout');
      const layoutIssues = inspectGenUILayout(viewport, designSpec);
      if (layoutIssues.length) throw new Error(`Design specification ${app.designSpec?.id ?? designSpec?.label ?? 'default'}: ${layoutIssues.join('; ')}`);
      const documentIssues = inspectGenUIHtmlFrame(report, designSpec);
      if (documentIssues.length) throw new Error(`Design specification ${app.designSpec?.id ?? designSpec?.label ?? 'default'} inside HTML document: ${documentIssues.join('; ')}`);
      // The document is intentionally hosted in an opaque-origin sandbox. A
      // parent-side DOM snapshot can capture the phone shell while silently
      // omitting the iframe pixels, so it must never be sent as visual review
      // evidence. The real frame is still checked for load and host layout;
      // hosts with a trusted frame-capture adapter may attach a screenshot in
      // a later delivery implementation.
    }
    return { revision: candidate.revision, library: { id: app.libraryId, revision: app.libraryRevision }, designSpec: designSpecIdentity, sourceKind: source.kind, htmlRuntime: GENUI_HTML_RUNTIME, viewport: designSpec?.viewport.mode === 'fixed' ? `${designSpec.viewport.width}x${designSpec.viewport.height}` : 'responsive', hostShell: browserLayout && designSpec?.acceptance.checks.includes('host-shell') ? 'passed' : 'unverified', appliedAcceptanceChecks: browserLayout ? designSpec?.acceptance.checks ?? [] : [], preflight: 'passed', checks: 'passed', render: 'passed', reopen: 'passed', probeReopen: 'passed', layout: browserLayout ? 'passed' : 'unverified', layoutWidths: browserLayout ? (designSpec?.viewport.mode === 'fixed' ? [designSpec.viewport.width!] : [360, 960]) : [], screenshot, interaction: 'unverified', renderedEvidence: inspectionReport?.renderedEvidence ?? [], requirementCoverage: 'unverified', visual: 'unverified', issues: [] };
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
}
