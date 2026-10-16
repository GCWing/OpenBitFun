export interface MiniAppChromeAction {
  id: string;
  label: string;
  icon: 'download' | 'save' | 'search' | 'settings' | 'refresh' | 'plus' | 'play' | 'stop' | 'check' | 'share' | 'help';
  labels?: Record<string, string>;
  enabled?: boolean;
}
export interface MiniAppTitlebar {
  title?: string | null;
  showTitle?: boolean;
  showIcon?: boolean;
  titleAlignment?: 'start' | 'center';
  density?: 'compact' | 'comfortable';
  buttonShape?: 'square' | 'rounded';
  /** Legacy metadata, retained for round trips. Native platform owns placement. */
  controlsPosition?: 'start' | 'end';
  surface?: 'surface-scene' | 'surface-canvas' | 'surface-raised' | 'surface-subtle';
  foreground?: 'content-primary' | 'content-secondary' | 'content-muted';
  border?: 'border-subtle' | 'border-default' | 'border-strong';
  actions?: MiniAppChromeAction[];
}
export interface MiniAppChrome { titlebar?: MiniAppTitlebar }
export const defaultTitlebar: Readonly<Required<MiniAppTitlebar>>;
export function resolveTitlebar(chrome?: MiniAppChrome | null): Required<MiniAppTitlebar>;
export function actionLabel(action: MiniAppChromeAction, locale: string): string;
export function mountTitlebar(element: HTMLElement, options: {
  chrome?: MiniAppChrome | null;
  title: string;
  icon: string;
  icons: Record<string, string>;
  locale: string;
  labels: Record<string, string>;
  platform: 'macos' | 'windows' | 'linux';
  preview?: boolean;
  ready?: boolean;
  onAction?: (action: string) => void;
  onWindowAction?: (action: string) => void;
  onDrag?: () => void;
}): { setMaximized(value: boolean): void; setFullscreen(value: boolean): void; setTransferring(value: boolean): void; setReady(value: boolean): void; destroy(): void };
