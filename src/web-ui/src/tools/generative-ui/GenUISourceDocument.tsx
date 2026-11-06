import type { GenUIDesignSpec } from './genUIContract';
import type { GenUIRenderDiagnostic } from './genUIRenderDiagnostics';
import GenUIHtmlDocument from './GenUIHtmlDocument';
import type { GenUIHtmlBridge } from './GenUIHtmlDocument';
import GenUIOpenUIDocument from './genUIOpenUI';
import type { GenUIOpenUIActionEvent, GenUIOpenUIToolProvider } from './genUIOpenUI';
import type { GenUILibrary } from './genUILibrary';
import type { GenUIAppState, GenUIHtmlDocumentSource, GenUIOpenUIDocumentSource } from './genUITypes';
import type { GenUIAsyncRuntime, GenUIProviderInput, GenUITargetEvent } from './genUIAsyncCapabilities';

export type GenUISourceDocument = GenUIHtmlDocumentSource | GenUIOpenUIDocumentSource;

/**
 * Source rendering is the only GenUI rendering path.
 * Both source kinds receive the same owner state and design specification,
 * while their parsers and isolation rules remain independent.
 */
export default function GenUISourceDocument({
  source,
  library,
  specification,
  designSpecId,
  appId,
  sourceKey,
  htmlBridge,
  htmlScriptEnabled = false,
  initialState,
  isStreaming = false,
  readOnly = false,
  onStateUpdate,
  onError,
  onAction,
  toolProvider,
  asyncProvider,
  asyncRuntime,
  asyncPermissions,
  asyncTarget,
  asyncTargetId,
  onTargetEvent,
}: {
  source: GenUISourceDocument;
  library: GenUILibrary;
  specification?: GenUIDesignSpec;
  designSpecId?: string;
  appId?: string;
  sourceKey?: string;
  htmlBridge?: GenUIHtmlBridge;
  htmlScriptEnabled?: boolean;
  initialState?: GenUIAppState;
  isStreaming?: boolean;
  readOnly?: boolean;
  onStateUpdate?: (state: GenUIAppState) => void;
  onError?: (errors: GenUIRenderDiagnostic[]) => void;
  onAction?: (event: GenUIOpenUIActionEvent) => void | Promise<void>;
  toolProvider?: GenUIOpenUIToolProvider;
  asyncProvider?: GenUIProviderInput;
  asyncRuntime?: GenUIAsyncRuntime;
  asyncPermissions?: readonly string[];
  asyncTarget?: 'local' | 'workspace' | 'peer' | 'unsupported';
  asyncTargetId?: string;
  onTargetEvent?: (event: GenUITargetEvent) => void | Promise<void>;
}) {
  if (source.kind === 'html-document') {
    // Free documents require an owner bridge before any script can run. The
    // OpenUI HtmlView path has a separate local-animation policy below.
    return <GenUIHtmlDocument source={source} specification={specification} designSpecId={designSpecId} appId={appId} sourceKey={sourceKey} bridge={htmlBridge} scriptEnabled={Boolean(htmlBridge && htmlScriptEnabled)} />;
  }
  return <GenUIOpenUIDocument
    source={source}
    library={library}
    specification={specification}
    initialState={initialState}
    isStreaming={isStreaming}
    readOnly={readOnly}
    onStateUpdate={onStateUpdate}
    onError={onError}
    onAction={onAction}
    toolProvider={toolProvider}
    asyncProvider={asyncProvider}
    asyncRuntime={asyncRuntime}
    htmlScriptEnabled={htmlScriptEnabled}
    asyncPermissions={asyncPermissions}
    asyncTarget={asyncTarget}
    asyncTargetId={asyncTargetId}
    onTargetEvent={onTargetEvent}
    appId={appId}
    sourceKey={sourceKey}
  />;
}
