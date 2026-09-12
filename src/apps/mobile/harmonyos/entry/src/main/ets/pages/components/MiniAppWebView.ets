import { webview } from '@kit.ArkWeb';

// A synthetic origin for in-memory HTML; no document is fetched from this URL.
const MINIAPP_DOCUMENT_URL: string = 'https://miniapp.invalid/';

/** Platform leaf. ArkWeb exposes proxies to frames; the ViewModel treats every request as untrusted. */
class MiniAppNativeBridge {
  private readonly dispatch: (raw: string) => void;
  constructor(dispatch: (raw: string) => void) { this.dispatch = dispatch; }
  request(raw: string): void { this.dispatch(raw); }
}

@ComponentV2
export struct MiniAppWebView {
  @Param document: string = '';
  @Param revision: number = 0;
  @Param request: (raw: string, revision: number) => Promise<string> = async (_raw: string, _revision: number): Promise<string> => '';
  private controller: webview.WebviewController = new webview.WebviewController();
  private active: boolean = true;
  private bridge: MiniAppNativeBridge = new MiniAppNativeBridge((raw: string): void => {
    void this.reply(raw);
  });

  private async reply(raw: string): Promise<void> {
    if (!this.active) return;
    const revision = this.revision;
    const response = await this.request(raw, revision);
    if (!this.active || revision !== this.revision || !response) return;
    try {
      await this.controller.runJavaScript(`window.__miniappReply(JSON.parse(${JSON.stringify(response)}))`);
    } catch (_error) {
      // Navigation/close invalidates replies; never replay a host mutation.
    }
  }

  aboutToDisappear(): void { this.active = false; }

  build() {
    // A nonempty initial src can overwrite loadData after controller attachment.
    Web({ src: '', controller: this.controller })
      .javaScriptAccess(true)
      .darkMode(WebDarkMode.Auto)
      .forceDarkAccess(false)
      .domStorageAccess(false)
      .fileAccess(false)
      .javaScriptProxy({ object: this.bridge, name: 'miniappNative', methodList: ['request'], controller: this.controller })
      .onControllerAttached(() => {
        this.active = true;
        // Without an HTTP(S) base, ArkWeb interprets raw HTML as a data URL:
        // CSS hashes become URL fragments and truncate the page before its script.
        this.controller.loadData(this.document, 'text/html', 'UTF-8', MINIAPP_DOCUMENT_URL);
      })
      .onOverrideUrlLoading((request: WebResourceRequest) => {
        // Only the wrapper and its sandboxed blob child may navigate here.
        const url = request.getRequestUrl();
        return request.isMainFrame() ? url !== 'about:blank' && url !== MINIAPP_DOCUMENT_URL : !url.startsWith('blob:');
      })
      .width('100%')
      .height('100%')
  }
}
