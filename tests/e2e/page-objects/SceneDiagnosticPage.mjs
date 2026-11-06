import { SceneVisibilityPage } from './SceneVisibilityPage.mjs';
import { LayoutReadDiagnosticPage } from './LayoutReadDiagnosticPage.mjs';

/** The pointer workload with the existing reversible, diagnostic-only probes. */
export class SceneDiagnosticPage extends SceneVisibilityPage {
  startLayoutReads(options) { return LayoutReadDiagnosticPage.prototype.startLayoutReads.call(this, options); }
  stopLayoutReads() { return LayoutReadDiagnosticPage.prototype.stopLayoutReads.call(this); }
}
