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
import { harmonyPresentation } from './harmonyPresentation';
import { HARMONY_STYLE_RESOURCE_CSS } from './components/vendor/harmonyStyles';

type GenUIEvidenceItem = { ref: string; label?: string; text?: string; role?: string; state?: string };

function collectRenderedEvidence(container: HTMLElement): GenUIEvidenceItem[] {
  const evidence: GenUIEvidenceItem[] = [];
  const seenRefs = new Set<string>();
  const seenText = new Set<string>();
  const add = (item: GenUIEvidenceItem) => {
    if (!item.ref || seenRefs.has(item.ref)) return;
    seenRefs.add(item.ref);
    evidence.push(item);
  };
  const stateFor = (element: HTMLElement) => {
    const state = [
      element.getAttribute('aria-checked') && `checked=${element.getAttribute('aria-checked')}`,
      element.getAttribute('aria-selected') && `selected=${element.getAttribute('aria-selected')}`,
      element.getAttribute('aria-pressed') && `pressed=${element.getAttribute('aria-pressed')}`,
      element.getAttribute('aria-valuetext') && `value=${element.getAttribute('aria-valuetext')}`,
      element.getAttribute('data-state') && `state=${element.getAttribute('data-state')}`,
      element instanceof HTMLInputElement && element.type === 'checkbox' && `checked=${element.checked}`,
      element instanceof HTMLInputElement && element.type === 'radio' && `checked=${element.checked}`,
      (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) && `value=${element.value}`,
    ].filter(Boolean);
    return state.length ? state.join(', ') : undefined;
  };

  const appRoot = container.querySelector<HTMLElement>('[data-gen-ui-app]');
  if (appRoot) {
    add({ ref: 'rendered:app-root', label: appRoot.dataset.genUiApp, text: (appRoot.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 240), role: 'application' });
  }

  let elementIndex = 0;
  for (const element of Array.from(container.querySelectorAll<HTMLElement>('h1,h2,h3,button,input,select,textarea,[role],[aria-label],[data-gen-ui-node],[data-openbitfun-component],[data-openbitfun-part]'))) {
    const index = elementIndex++;
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const label = element.getAttribute('aria-label') ?? '';
    const nodeId = element.getAttribute('data-gen-ui-node');
    const part = element.getAttribute('data-openbitfun-part');
    const component = element.getAttribute('data-openbitfun-component');
    const ref = element.id ? `id:${element.id}` : label ? `aria:${label}` : nodeId ? `node:${nodeId}` : text ? `text:${element.tagName.toLowerCase()}:${text}` : component || part ? `component:${component ?? 'unknown'}:${part ?? index}` : `element:${index}`;
    add({ ref, label: label || undefined, text: text || undefined, role: element.getAttribute('role') ?? component ?? element.tagName.toLowerCase(), state: stateFor(element) });
  }

  const textWalker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let textIndex = 0;
  for (let node = textWalker.nextNode(); node; node = textWalker.nextNode()) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!text || seenText.has(text)) continue;
    seenText.add(text);
    const parent = node.parentElement;
    if (!parent) continue;
    add({ ref: `rendered:text:${textIndex++}`, text, role: parent.getAttribute('role') ?? parent.getAttribute('data-openbitfun-component') ?? parent.tagName.toLowerCase() });
  }
  return evidence;
}

function collectCandidateEvidence(app: GenUIAppDefinition) {
  const designSpec = app.designSpec ? `${app.designSpec.id}@${app.designSpec.revision}` : '';
  return [
    { ref: 'candidate:identity', text: app.id, role: 'application-id' },
    { ref: 'candidate:title', text: app.title, role: 'application-title' },
    { ref: 'candidate:source-kind', text: app.source?.kind, role: 'source-kind' },
    { ref: 'candidate:library', text: `${app.libraryId}@${app.libraryRevision}`, role: 'component-library' },
    ...(designSpec ? [{ ref: 'candidate:design-spec', text: designSpec, role: 'design-spec' }] : []),
  ].filter((item): item is { ref: string; text: string; role: string } => typeof item.text === 'string' && item.text.length > 0);
}

function controlLabel(element: HTMLElement) {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 120);
  const fieldLabel = element.closest('label')?.textContent?.replace(/\s+/g, ' ').trim();
  return fieldLabel?.slice(0, 120) || element.getAttribute('name') || element.tagName.toLowerCase();
}

function controlRef(element: HTMLElement, index: number) {
  const nodeId = element.closest<HTMLElement>('[data-gen-ui-node]')?.dataset.genUiNode;
  const kind = element instanceof HTMLInputElement ? `input:${element.type}` : element.tagName.toLowerCase();
  return nodeId ? `control:${nodeId}:${kind}:${index}` : `control:${kind}:${index}`;
}

function changedStateKeys(before: GenUIAppState, after: GenUIAppState) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort();
}

function changedEvidence(before: GenUIEvidenceItem[], after: GenUIEvidenceItem[]) {
  const beforeByRef = new Map(before.map(item => [item.ref, item]));
  const afterByRef = new Map(after.map(item => [item.ref, item]));
  const refs = new Set([...beforeByRef.keys(), ...afterByRef.keys()]);
  return [...refs].flatMap(ref => {
    const previous = beforeByRef.get(ref);
    const next = afterByRef.get(ref);
    if (JSON.stringify(previous) === JSON.stringify(next)) return [];
    return [{ ref, before: previous ? { text: previous.text, state: previous.state } : null, after: next ? { text: next.text, state: next.state } : null }];
  });
}

function probeValueForInput(input: HTMLInputElement): string {
  const type = input.type.toLowerCase();
  if (!['range', 'number'].includes(type)) {
    if (type === 'email') return 'probe@example.invalid';
    if (type === 'url') return 'https://example.invalid';
    if (type === 'date') return '2030-01-02';
    if (type === 'time') return '12:34';
    return input.value === 'probe' ? 'probe-value' : 'probe';
  }

  const min = Number(input.min);
  const max = Number(input.max);
  const step = Number(input.step);
  const current = Number(input.value);
  const validStep = Number.isFinite(step) && step > 0 ? step : 1;
  const lower = Number.isFinite(min) ? min : undefined;
  const upper = Number.isFinite(max) ? max : undefined;
  let next = type === 'number' && !(lower !== undefined && upper !== undefined && (7 < lower || 7 > upper))
    ? 7
    : (Number.isFinite(current) ? current + validStep : lower ?? 0);
  if (upper !== undefined && next > upper) next = Number.isFinite(current) ? current - validStep : upper;
  if (lower !== undefined && next < lower) next = lower;
  if (upper !== undefined && next > upper) next = upper;
  if (!Number.isFinite(next)) next = lower ?? 0;
  return String(Number(next.toFixed(6)));
}

function setFormControlProbe(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
  if (control instanceof HTMLInputElement && control.type === 'file') return false;
  if (control instanceof HTMLSelectElement) {
    const option = Array.from(control.options).find(candidate => !candidate.disabled && candidate.value !== control.value);
    if (!option) return false;
    const setter = Object.getOwnPropertyDescriptor(control.ownerDocument.defaultView!.HTMLSelectElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(control, option.value);
  } else if (control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type)) {
    if (control.type === 'radio' && control.checked) return false;
    const setter = Object.getOwnPropertyDescriptor(control.ownerDocument.defaultView!.HTMLInputElement.prototype, 'checked')?.set;
    if (!setter) return false;
    setter.call(control, control.type === 'checkbox' ? !control.checked : true);
  } else {
    const prototype = control instanceof HTMLInputElement
      ? control.ownerDocument.defaultView!.HTMLInputElement.prototype
      : control instanceof HTMLTextAreaElement
        ? control.ownerDocument.defaultView!.HTMLTextAreaElement.prototype
        : null;
    const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(control, control instanceof HTMLInputElement ? probeValueForInput(control) : 'probe');
  }
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function settleCandidateRender() {
  return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
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
  if (app.source?.kind === 'html-document') return verifyGenUIHtmlCandidate(candidate, designSpec, browserLayout, product);
  throw new Error('GenUI source is required; semantic graph documents were removed');
}

async function verifyGenUIOpenUICandidate(candidate: { revision: string; app: GenUIAppDefinition; state: GenUIAppState }, designSpec: ReturnType<typeof designSpecForApp>, browserLayout: boolean, product: GenUIProduct) {
  const { app, state } = candidate;
  const source = app.source;
  if (!source || source.kind !== 'openui-lang') throw new Error('OpenUI document source is missing');
  const library = product.libraries[app.libraryId];
  if (!library) throw new Error(`GenUI library ${app.libraryId}@${app.libraryRevision} is unavailable`);
  const harmony = product.adapters[app.libraryId]?.adapterKind === 'harmony-genui';
  const harmonyStyle = harmonyPresentation(app);
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
  let lastActionTarget = '';
  let activeControl: { ref: string; label: string; role: string } | undefined;
  const inspectorFailures: string[] = [];
  let latestState = state;
  const interactionEvidence: Array<Record<string, unknown>> = [];
  const render = (initialState: GenUIAppState) => flushSync(() => root.render(
    <GenUIHostSurface specification={designSpec} harmony={harmony} harmonyTheme={harmonyStyle.theme} harmonyFont={harmonyStyle.font} harmonyScheme={harmonyStyle.scheme}>
      <div className={'gen-ui-application gen-ui-application--' + (harmony ? 'harmony-genui' : 'openui') + (designSpec?.shell.kind === 'phone' ? ' gen-ui-application--phone' : '')} data-openbitfun-component="gen-ui-application" data-openbitfun-part="content" data-gen-ui-app={app.id} data-gen-ui-source-kind={source.kind} data-hm-theme={harmony ? harmonyStyle.theme : undefined} data-hm-font={harmony ? harmonyStyle.font : undefined} data-hm-scheme={harmony ? harmonyStyle.scheme : undefined}>
        {harmony ? <style data-gen-ui-harmony-style dangerouslySetInnerHTML={{ __html: HARMONY_STYLE_RESOURCE_CSS }} /> : null}
        <GenUIOpenUIDocument
          source={source}
          library={library}
          initialState={initialState}
          isStreaming={false}
          executeActions={false}
          onError={message => { parserError = message; }}
          onAction={event => { actionCount++; lastActionType = event.type; lastActionTarget = activeControl?.label ?? ''; }}
          onInspect={event => { if (!event.passed) inspectorFailures.push(`${event.component}(${event.statementId})${event.error ? ': ' + event.error : ''}`); }}
          onStateUpdate={next => { latestState = next; }}
        />
      </div>
    </GenUIHostSurface>,
  ));
  try {
    render(state);
    await settleCandidateRender();
    if (parserError) throw new Error(parserError);
    if (inspectorFailures.length) throw new Error('GenUI component inspector failed: ' + inspectorFailures.join('; '));
    if (!container.querySelector('[data-gen-ui-application]') && !container.querySelector('.gen-ui-application')) throw new Error('OpenUI document did not mount');
    const viewport = container.querySelector<HTMLElement>('[data-gen-ui-viewport]') ?? container;
    let screenshot: string | undefined;
    if (browserLayout) {
      const issues = inspectGenUILayout(viewport, designSpec);
      if (issues.length) throw new Error(`Design specification ${app.designSpec?.id ?? designSpec?.label ?? 'default'}: ${issues.join('; ')}`);
      const { domToPng } = await import('modern-screenshot');
      screenshot = await withTimeout(domToPng(container, { scale: 1, font: false }), 15000, 'OpenUI screenshot');
      if (!screenshot.startsWith('data:image/png;base64,') || screenshot.length < 100) throw new Error('OpenUI screenshot is empty or invalid');
    }

    const initialRenderedEvidence = collectRenderedEvidence(container);
    const controlSelector = 'button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled])';
    const getControls = () => Array.from(container.querySelectorAll<HTMLElement>(controlSelector)).filter(element => !(element instanceof HTMLInputElement && element.type === 'radio' && element.checked));
    const controlTargets = getControls().map((element, index) => ({
      index,
      ref: controlRef(element, index),
      label: controlLabel(element),
      role: element.getAttribute('role') ?? (element instanceof HTMLInputElement ? `input:${element.type}` : element.tagName.toLowerCase()),
      isButton: element instanceof HTMLButtonElement,
    }));
    const resetProbe = async () => {
      flushSync(() => root.render(null));
      parserError = '';
      actionCount = 0;
      lastActionType = '';
      lastActionTarget = '';
      latestState = structuredClone(state);
      activeControl = undefined;
      inspectorFailures.length = 0;
      render(latestState);
      await settleCandidateRender();
      if (parserError) throw new Error(parserError);
      if (inspectorFailures.length) throw new Error('GenUI component inspector failed: ' + inspectorFailures.join('; '));
    };
    for (const target of controlTargets) {
      await resetProbe();
      const control = getControls()[target.index];
      if (!control) continue;
      const beforeEvidence = collectRenderedEvidence(container);
      const beforeState = structuredClone(latestState);
      activeControl = target;
      const exercised = control instanceof HTMLButtonElement
        ? (flushSync(() => control.click()), true)
        : control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement
          ? setFormControlProbe(control)
          : false;
      if (!exercised) continue;
      await settleCandidateRender();
      const stateKeys = changedStateKeys(beforeState, latestState);
      const outputChanges = changedEvidence(beforeEvidence, collectRenderedEvidence(container));
      interactionEvidence.push({
        ref: `interaction:${target.index}`,
        targetRef: target.ref,
        target: target.label,
        control: target.role,
        operation: target.isButton ? 'click' : 'change',
        actionDelivered: actionCount > 0,
        actionType: lastActionType || undefined,
        actionTarget: lastActionTarget || undefined,
        stateChanged: stateKeys.length > 0,
        changedStateKeys: stateKeys,
        outputChanged: outputChanges.length > 0,
        outputChanges,
      });
    }
    if (source.content.includes('@ToAssistant') && !interactionEvidence.some(probe => probe.actionDelivered && probe.actionType === 'continue_conversation')) {
      throw new Error('OpenUI action did not reach the owning host');
    }

    await resetProbe();
    const input = container.querySelector<HTMLInputElement>('input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])');
    let reopened = false;
    let expectedProbeValue: string | undefined;
    if (input) {
      expectedProbeValue = probeValueForInput(input);
      const previousState = structuredClone(latestState);
      if (!setFormControlProbe(input)) throw new Error('OpenUI input has no writable probe value');
      await settleCandidateRender();
      if (changedStateKeys(previousState, latestState).length === 0) throw new Error('OpenUI input interaction did not reach the owning state callback');
      expectedProbeValue = input.value;
    }
    // Reopen the exact owner-read state in a fresh renderer. This keeps the
    // OpenUI path honest: seeing onStateUpdate is not enough to claim that a
    // user edit survives remount.
    flushSync(() => root.render(null));
    parserError = '';
    render(latestState);
    await settleCandidateRender();
    if (parserError) throw new Error(parserError);
    const reopenedInput = container.querySelector<HTMLInputElement>('input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])');
    if (input && reopenedInput) {
      if (reopenedInput.value !== expectedProbeValue) throw new Error(`OpenUI owner state did not survive reopen: control=${input.type}, expected ${expectedProbeValue}, received ${reopenedInput.value}`);
    }
    reopened = true;
    return { revision: candidate.revision, library: { id: app.libraryId, revision: app.libraryRevision }, designSpec: designSpecIdentity, sourceKind: source.kind, viewport: designSpec?.viewport.mode === 'fixed' ? `${designSpec.viewport.width}x${designSpec.viewport.height}` : 'responsive', hostShell: browserLayout && designSpec?.acceptance.checks.includes('host-shell') ? 'passed' : 'unverified', appliedAcceptanceChecks: browserLayout ? designSpec?.acceptance.checks ?? [] : [], preflight: 'passed', checks: 'passed', render: 'passed', reopen: reopened ? 'passed' : 'unverified', probeReopen: reopened ? 'passed' : 'unverified', layout: browserLayout ? 'passed' : 'unverified', layoutWidths: browserLayout ? (designSpec?.viewport.mode === 'fixed' ? [designSpec.viewport.width!] : [360, 960]) : [], screenshot, interaction: interactionEvidence.some(probe => probe.actionDelivered || probe.stateChanged) ? 'observed' : 'unverified', candidateEvidence: collectCandidateEvidence(app), renderedEvidence: initialRenderedEvidence, interactionEvidence, requirementCoverage: 'unverified', visual: 'unverified', issues: [] };
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
}

async function verifyGenUIHtmlCandidate(candidate: { revision: string; app: GenUIAppDefinition; state: GenUIAppState }, designSpec: ReturnType<typeof designSpecForApp>, browserLayout: boolean, product: GenUIProduct) {
  const { app } = candidate;
  const source = app.source;
  if (!source || source.kind !== 'html-document') throw new Error('HTML document source is missing');
  const harmony = product.adapters[app.libraryId]?.adapterKind === 'harmony-genui';
  const harmonyStyle = harmonyPresentation(app);
  const designSpecIdentity = app.designSpec ?? (designSpec ? { id: product.adapters[app.libraryId]?.designSpecIds[0] ?? '', revision: designSpec.revision } : null);
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
    flushSync(() => root.render(<GenUIHostSurface specification={designSpec} harmony={harmony} harmonyTheme={harmonyStyle.theme} harmonyFont={harmonyStyle.font} harmonyScheme={harmonyStyle.scheme}><div className={'gen-ui-application gen-ui-application--' + (harmony ? 'harmony-genui' : 'document') + (designSpec?.shell.kind === 'phone' ? ' gen-ui-application--phone' : '')} data-openbitfun-component="gen-ui-application" data-openbitfun-part="content" data-gen-ui-app={app.id} data-gen-ui-source-kind={source.kind} data-hm-theme={harmony ? harmonyStyle.theme : undefined} data-hm-font={harmony ? harmonyStyle.font : undefined} data-hm-scheme={harmony ? harmonyStyle.scheme : undefined}>{harmony ? <style data-gen-ui-harmony-style dangerouslySetInnerHTML={{ __html: HARMONY_STYLE_RESOURCE_CSS }} /> : null}<GenUIHtmlDocument source={source} specification={designSpec} inspection={inspection} /></div></GenUIHostSurface>));
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
    return { revision: candidate.revision, library: { id: app.libraryId, revision: app.libraryRevision }, designSpec: designSpecIdentity, sourceKind: source.kind, htmlRuntime: GENUI_HTML_RUNTIME, viewport: designSpec?.viewport.mode === 'fixed' ? `${designSpec.viewport.width}x${designSpec.viewport.height}` : 'responsive', hostShell: browserLayout && designSpec?.acceptance.checks.includes('host-shell') ? 'passed' : 'unverified', appliedAcceptanceChecks: browserLayout ? designSpec?.acceptance.checks ?? [] : [], preflight: 'passed', checks: 'passed', render: 'passed', reopen: 'passed', probeReopen: 'passed', layout: browserLayout ? 'passed' : 'unverified', layoutWidths: browserLayout ? (designSpec?.viewport.mode === 'fixed' ? [designSpec.viewport.width!] : [360, 960]) : [], screenshot, interaction: 'unverified', candidateEvidence: collectCandidateEvidence(app), renderedEvidence: inspectionReport?.renderedEvidence ?? [], interactionEvidence: [], requirementCoverage: 'unverified', visual: 'unverified', issues: [] };
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
}
