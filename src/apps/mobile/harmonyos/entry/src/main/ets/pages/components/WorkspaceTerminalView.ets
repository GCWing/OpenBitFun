import { webview } from '@kit.ArkWeb';
import { WorkspaceToolsIntent } from '../state/WorkspaceToolsState';

interface TerminalBridgeEvent { type: string; data?: string; cols?: number; rows?: number; }
interface TerminalTheme { background: string; foreground: string; cursor: string; }
interface TerminalFrame { epoch: string; revision: number; reset: boolean; data: string; theme: TerminalTheme; }
class TerminalNativeBridge {
  private dispatch: (raw: string) => void;
  constructor(dispatch: (raw: string) => void) { this.dispatch = dispatch; }
  postMessage(raw: string): void { this.dispatch(raw); }
}

/** Platform renderer only: authenticated transport and PTY ownership remain in the ViewModel. */
@ComponentV2
export struct WorkspaceTerminalView {
  @Param terminalId: string = '';
  @Param output: string = '';
  @Event onIntent: (intent: WorkspaceToolsIntent) => void = (_intent: WorkspaceToolsIntent) => {};
  private controller: webview.WebviewController = new webview.WebviewController();
  private ready: boolean = false;
  private active: boolean = true;
  private sending: boolean = false;
  private dirty: boolean = false;
  private reset: boolean = true;
  private sentEpoch: string = '';
  private sentOutput: string = '';
  private revision: number = 0;
  private bridge: TerminalNativeBridge = new TerminalNativeBridge((raw: string): void => this.receive(raw));

  @Monitor('terminalId', 'output')
  private changed(): void { this.dirty = true; void this.flush(); }
  private receive(raw: string): void {
    if (!this.active) return;
    try {
      const event = JSON.parse(raw) as TerminalBridgeEvent;
      if (event.type === 'ready' || event.type === 'resync') {
        this.ready = true; this.reset = true; this.dirty = true; void this.flush();
      } else if (event.type === 'input' && typeof event.data === 'string') {
        this.onIntent({ type: 'terminal-write', text: event.data });
      } else if (event.type === 'resize' && event.cols && event.rows) {
        this.onIntent({ type: 'terminal-resize', text: `${event.cols}x${event.rows}` });
      }
    } catch (_error) { /* Invalid renderer messages cannot invoke host operations. */ }
  }
  private color(id: number): string {
    const value = this.getUIContext().getHostContext()?.resourceManager.getColorSync(id) || 0;
    return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
  }
  private async flush(): Promise<void> {
    if (!this.ready || !this.active || this.sending) return;
    this.sending = true;
    try {
      while (this.dirty && this.ready && this.active) {
        this.dirty = false;
        const epoch = this.terminalId; const output = this.output;
        const reset = this.reset || epoch !== this.sentEpoch || !output.startsWith(this.sentOutput);
        this.reset = false;
        const foreground = this.color($r('app.color.ink').id);
        const frame: TerminalFrame = { epoch: epoch, revision: ++this.revision, reset: reset,
          data: reset ? output : output.slice(this.sentOutput.length),
          theme: { background: this.color($r('app.color.page_bg').id), foreground: foreground, cursor: foreground } };
        await this.controller.runJavaScript(`window.OpenBitFunTerminal.accept(${JSON.stringify(frame)})`);
        this.sentEpoch = epoch; this.sentOutput = output;
      }
    } catch (_error) { this.reset = true; this.dirty = true; }
    finally { this.sending = false; }
  }
  onWillApplyTheme(_theme: Theme): void {
    this.dirty = true;
    void this.flush();
  }
  aboutToDisappear(): void { this.active = false; this.ready = false; }
  build() {
    Web({ src: $rawfile('terminal/index.html'), controller: this.controller })
      .javaScriptAccess(true).domStorageAccess(false).fileAccess(false)
      .darkMode(WebDarkMode.Auto).forceDarkAccess(false)
      .javaScriptProxy({ object: this.bridge, name: 'OpenBitFunTerminalHost', methodList: ['postMessage'], controller: this.controller })
      .onControllerAttached(() => { this.active = true; })
      .onPageEnd(() => { void this.controller.runJavaScript('window.OpenBitFunTerminal.connect()').catch((error: Error) => this.onIntent({ type: 'terminal-renderer-error', text: error.message })); })
      .onErrorReceive((event: OnErrorReceiveEvent) => this.onIntent({ type: 'terminal-renderer-error', text: event.error.getErrorInfo() }))
      .onOverrideUrlLoading((request: WebResourceRequest): boolean => !request.getRequestUrl().startsWith('resource://rawfile/terminal/'))
      .width('100%').height('100%')
  }
}
