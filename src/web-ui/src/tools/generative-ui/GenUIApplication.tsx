import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { OpenUIError } from '@openuidev/lang-core';
import { isFatalGenUIError } from './genUIRenderDiagnostics';
import type { GenUIAppDefinition, GenUIAppEnvelope, GenUIAppState } from './genUITypes';
import { designSpecForApp, libraryFor, preflightGenUIApp } from './genUIContract';
import { GenUIStateStore, genUIContentKey, validateGenUIState } from './genUIState';
import type { GenUIVerification } from './genUIVerification';
import './GenUIApplication.scss';
import GenUIHostSurface from './GenUIHostSurface';
import GenUISourceDocument from './GenUISourceDocument';
import { inspectGenUIHtmlSource } from './GenUIHtmlDocument';
import type { GenUIOpenUIActionEvent, GenUIOpenUIToolProvider } from './genUIOpenUI';
import type { GenUIHtmlBridge } from './GenUIHtmlDocument';
import { GenUIStream } from './genUIStream';
import { genUIProduct, type GenUIProduct } from './genUIProduct';
import type { GenUIAsyncRuntime, GenUIProviderInput, GenUITargetEvent } from './genUIAsyncCapabilities';
import { createGenUIAsyncRuntime } from './genUIAsyncCapabilities';

export interface GenUIApplicationProps {
  product?: GenUIProduct;
  definition: GenUIAppEnvelope;
  initialState?: GenUIAppState;
  readOnly?: boolean;
  streaming?: boolean;
  restoredFromStorage?: boolean;
  preview?: boolean;
  onStateChange?: (state: GenUIAppState) => void | Promise<void>;
  /** Persist only after the owning surface has accepted the source. */
  persistState?: boolean;
  onAction?: (event: GenUIOpenUIActionEvent) => void | Promise<void>;
  toolProvider?: GenUIOpenUIToolProvider;
  asyncProvider?: GenUIProviderInput;
  asyncPermissions?: readonly string[];
  asyncTarget?: 'local' | 'workspace' | 'peer' | 'unsupported';
  asyncTargetId?: string;
  onTargetEvent?: (event: GenUITargetEvent) => void | Promise<void>;
  htmlBridge?: GenUIHtmlBridge;
  onVerification?: (report: GenUIVerification) => void;
}

export default function GenUIApplication(props: GenUIApplicationProps) {
  return <Application key={props.definition.id} {...props} />;
}

function Application({ product = genUIProduct, definition, initialState, readOnly = false, preview = false, streaming = false, restoredFromStorage = false, onStateChange, persistState = true, onAction, toolProvider, asyncProvider, asyncPermissions, asyncTarget = 'local', asyncTargetId, onTargetEvent, htmlBridge, onVerification }: GenUIApplicationProps) {
  const stream = useRef(new GenUIStream());
  const sourceKey = genUIContentKey(definition);
  const app = useMemo(() => (streaming ? stream.current.project(definition, product.catalog) : definition as GenUIAppDefinition), [definition, streaming, product]);
  const definitionKey = sourceKey;
  const preflight = useMemo(() => streaming ? { accepted: true, issues: [] } : preflightGenUIApp(app, false, product.catalog), [app, streaming, product]);
  const designSpec = designSpecForApp(app, product.catalog);
  const library = libraryFor(app, product.catalog);
  const source = app.source;
  // Keep one async controller for the mounted FlowChat application. The
  // source key still changes for admission and late-result isolation, but it
  // must not remount every map/image component as OpenUI receives fragments.
  // Keep provider identity stable across OpenUI source fragments. The
  // renderer reconciles completed statements while streaming; using the full
  // source text here would abort an image/route request on every token.
  const runtimeIdentity = `${app.id}:${app.libraryId}:${app.source?.kind ?? 'unknown'}`;
  const asyncRuntime = useMemo<GenUIAsyncRuntime | undefined>(() => createGenUIAsyncRuntime({
    provider: asyncProvider ?? toolProvider,
    appId: app.id,
    sourceKey: runtimeIdentity,
    policy: { permissions: asyncPermissions, target: asyncTarget, targetId: asyncTargetId },
    onTargetEvent,
  }), [asyncProvider, toolProvider, app.id, runtimeIdentity, asyncPermissions, asyncTarget, asyncTargetId, onTargetEvent]);
  const runtimeSourceInitialized = useRef(false);
  useLayoutEffect(() => {
    asyncRuntime?.updateSourceKey?.(runtimeIdentity, runtimeSourceInitialized.current);
    runtimeSourceInitialized.current = true;
  }, [asyncRuntime, runtimeIdentity]);
  useEffect(() => {
    if (!asyncRuntime) return;
    asyncRuntime.setTargetEventHandler?.(onTargetEvent);
  }, [asyncRuntime, onTargetEvent]);
  useEffect(() => () => asyncRuntime?.abortAll('GenUI source was replaced or unmounted'), [asyncRuntime]);
  const sourceIssues = useMemo(() => source?.kind === 'html-document' ? inspectGenUIHtmlSource(source, designSpec) : [], [source, designSpec]);
  const store = useRef(new GenUIStateStore());
  const [state, setState] = useState(() => store.current.initialize(app, initialState));
  const [persistence, setPersistence] = useState<GenUIVerification['persistence']>('unverified');
  const [saveError, setSaveError] = useState('');
  const [openUIReport, setOpenUIReport] = useState<{ key: string; errors: OpenUIError[] }>();
  const receiveOpenUIErrors = useCallback((errors: OpenUIError[]) => {
    setOpenUIReport({ key: definitionKey, errors });
  }, [definitionKey]);
  const openUIErrors = !streaming && openUIReport?.key === definitionKey ? openUIReport.errors : [];
  const fatalErrors = openUIErrors.filter(isFatalGenUIError);
  const [observed, setObserved] = useState(false);
  const baseline = useRef(initialState);
  const dirty = useRef(false);
  const alive = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;
  const lastStateKey = useRef(genUIContentKey(state));
  // Treat verification as an event sink. Hosts commonly update their own
  // state from a report, which gives them a new callback identity on the next
  // render. The report itself is keyed by reportKey; callback identity must
  // not cause the effect to emit the same report again.
  const onVerificationRef = useRef(onVerification);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => { onVerificationRef.current = onVerification; }, [onVerification]);
  useEffect(() => {
    baseline.current = initialState;
    if (!dirty.current) setState(store.current.initialize(app, initialState));
  }, [definitionKey, app, initialState]);
  const stateIssues = preflight.accepted ? validateGenUIState(app, state) : [];
  const renderErrors = !library ? [`GenUI library ${app.libraryId}@${app.libraryRevision} is unavailable`] : !source ? ['GenUI source is required; semantic graph documents were removed'] : sourceIssues.length ? sourceIssues : fatalErrors.map(error => error.message);
  const render: GenUIVerification['render'] = renderErrors.length ? 'failed' : streaming || (source?.kind === 'openui-lang' && openUIReport?.key !== definitionKey) ? 'unverified' : 'passed';
  const checks: GenUIVerification['checks'] = renderErrors.length || stateIssues.length ? 'failed' : source?.kind === 'html-document' ? 'passed' : streaming ? 'unverified' : 'passed';
  const report: GenUIVerification = {
    appId: app.id,
    definitionKey,
    state,
    checks,
    preflight: streaming ? 'unverified' : preflight.accepted && !stateIssues.length ? 'passed' : 'failed',
    render,
    interaction: observed ? 'observed' : 'unverified',
    persistence,
    reopen: restoredFromStorage ? 'restored' : 'unverified',
    issues: [...preflight.issues, ...stateIssues, ...renderErrors.map(message => ({ path: 'source', message, code: 'render', severity: 'error' as const })), ...openUIErrors.filter(error => !isFatalGenUIError(error)).map(error => ({ path: error.path ?? error.statementId ?? 'source', message: error.message, code: error.code, severity: 'warning' as const })), ...(saveError ? [{ path: 'app_state', message: saveError, code: 'persistence', severity: 'error' as const }] : [])],
    diagnostics: openUIErrors,
  };
  const reportKey = JSON.stringify(report);
  useEffect(() => { onVerificationRef.current?.(JSON.parse(reportKey)); }, [reportKey]);
  // Streaming only controls parser mode. It must not disable already mounted
  // local controls; persistence remains explicitly gated by persistState.
  // A streamed source is an interactive transient preview. Only a confirmed
  // render failure (or an explicitly read-only/preview host) locks controls;
  // persistence is still independently gated by `persistState`.
  const locked = readOnly || preview || render === 'failed';
  const save = (next: GenUIAppState) => {
    if (!persistState || locked || !onStateChange) return;
    setPersistence('saving'); setSaveError('');
    Promise.resolve(onStateChange(next)).then(() => { if (alive.current) setPersistence('saved'); }, error => { if (alive.current) { setPersistence('failed'); setSaveError(error instanceof Error ? error.message : String(error)); } });
  };
  if (!source) {
    return <GenUIHostSurface specification={designSpec}><div className="gen-ui-application" data-openbitfun-component="gen-ui-application" data-openbitfun-part="root" data-openbitfun-state="rejected"><div data-openbitfun-component="gen-ui-application" data-openbitfun-part="content">Semantic graph GenUI documents are no longer supported. Generate a complete OpenUI or HTML source document.</div></div></GenUIHostSurface>;
  }
  return <GenUIHostSurface specification={designSpec}>
    <div className={'gen-ui-application gen-ui-application--' + (product.adapters[app.libraryId]?.adapterKind ?? 'unknown') + (designSpec?.shell.kind === 'phone' ? ' gen-ui-application--phone' : '') + (source.kind === 'html-document' ? ' gen-ui-application--document' : '')} data-openbitfun-component="gen-ui-application" data-openbitfun-part="root" data-gen-ui-app={app.id} data-gen-ui-library={app.libraryId} data-gen-ui-library-revision={app.libraryRevision} data-gen-ui-source-kind={source.kind} data-openbitfun-state={render === 'failed' || report.preflight === 'failed' ? 'rejected' : render === 'passed' ? 'rendered' : undefined} data-gen-ui-preflight={report.preflight} data-gen-ui-postcheck={report.render} data-gen-ui-save={persistence}>
      <div data-openbitfun-component="gen-ui-application" data-openbitfun-part="content">{library && <GenUISourceDocument source={source} library={product.libraries[app.libraryId]} specification={designSpec} designSpecId={app.designSpec?.id} appId={app.id} sourceKey={definitionKey} initialState={state} isStreaming={streaming} readOnly={locked} onStateUpdate={next => {
        const nextKey = genUIContentKey(next);
        // OpenUI can report the same snapshot through both its field setter and
        // store subscription. A no-op owner update must stay a no-op or the
        // parent rerenders forever while the document is mounting.
        if (nextKey === lastStateKey.current || nextKey === genUIContentKey(stateRef.current)) return;
        lastStateKey.current = nextKey;
        setObserved(true); dirty.current = true;
        store.current.commit(next); setState(next); save(next);
      }} onError={receiveOpenUIErrors} onAction={event => { setObserved(true); return onAction?.(event); }} toolProvider={toolProvider} asyncProvider={asyncProvider} asyncRuntime={asyncRuntime} asyncPermissions={asyncPermissions} asyncTarget={asyncTarget} asyncTargetId={asyncTargetId} onTargetEvent={onTargetEvent} htmlBridge={htmlBridge} htmlScriptEnabled={Boolean(!preview && !readOnly && !streaming)} />}</div>
    </div>
  </GenUIHostSurface>;
}
