import { ConcurrentWorkloadPage } from './ConcurrentWorkloadPage.mjs';
import { LayoutReadDiagnosticPage } from './LayoutReadDiagnosticPage.mjs';

/** Diagnostic probes stay separate from ordinary concurrent-workload acceptance. */
export class ConcurrentDiagnosticPage extends ConcurrentWorkloadPage {
  startLayoutReads(options) { return LayoutReadDiagnosticPage.prototype.startLayoutReads.call(this, options); }
  stopLayoutReads() { return LayoutReadDiagnosticPage.prototype.stopLayoutReads.call(this); }
}
