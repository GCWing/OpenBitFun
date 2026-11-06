// CEF invokes this in the workbench document with a compositor-backed bitmap.
// The IOSurface handle and its release fence stay in Chromium.
type TextureArgs = [
  popup: boolean, bitmap: ImageBitmap | null | undefined,
  x: number, y: number, width: number, height: number,
  left: number, top: number, scale: number, background: number,
];

type TextureDispatch = (label: string, ...args: TextureArgs) => void;
type TextureListener = (...args: TextureArgs) => void;
type TextureWindow = Window & { __openbitfunPresentOsrTexture?: TextureDispatch };
const listeners = new Map<string, TextureListener>();

export interface BrowserTextureUi {
  cursor: number;
  caret: [x: number, y: number] | null;
}

export async function listenForBrowserTextureUi(label: string, receive: (ui: BrowserTextureUi) => void) {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<BrowserTextureUi>(`browser-osr-ui-${label}`, ({ payload }) => receive(payload));
}

export function listenForBrowserTextures(label: string, receive: TextureListener) {
  const target: TextureWindow = window;
  if (!listeners.size) {
    target.__openbitfunPresentOsrTexture = (targetLabel, ...args) => {
      try {
        listeners.get(targetLabel)?.(...args);
      } finally {
        args[1]?.close();
      }
    };
  }
  listeners.set(label, receive);
  return () => {
    if (listeners.get(label) === receive) listeners.delete(label);
    if (!listeners.size) delete target.__openbitfunPresentOsrTexture;
  };
}
