export interface MiniAppSummary {
  id: string;
  name: string;
  description: string;
}

export interface MiniAppBridgeParams {
  key?: string;
  value?: Object | null;
  text?: string;
}

export interface MiniAppBridgeRequest {
  id: string;
  method: string;
  params?: MiniAppBridgeParams;
}

export interface MiniAppBridgeError { message: string; }
export interface MiniAppBridgeReply {
  jsonrpc: string;
  id: string;
  result?: Object | null;
  error?: MiniAppBridgeError;
}

/** Local data source, deliberately independent of any connection/session. */
export interface MiniAppHost {
  list(locale: string): Promise<MiniAppSummary[]>;
  document(appId: string): Promise<string>;
  call(appId: string, method: string, params: MiniAppBridgeParams): Promise<Object | null>;
}

export interface MiniAppActions {
  open: () => void;
  close: () => void;
  back: () => void;
  refresh: () => void;
  select: (id: string) => void;
  request: (raw: string, revision: number) => Promise<string>;
}

export function emptyMiniAppActions(): MiniAppActions {
  return { open: () => {}, close: () => {}, back: () => {}, refresh: () => {}, select: () => {},
    request: async (_raw: string, _revision: number): Promise<string> => '' };
}
