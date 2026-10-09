export class RemoteConnectEntryKind {
  static readonly EnterSurface: string = 'enter_surface';
  static readonly OpenConnect: string = 'open_connect';
}

/**
 * Switching to Remote is a change of context. Opening the connect sheet is a
 * command to pick a desktop. Those two must not share an entry point.
 */
export class RemoteSurfaceEntryPolicy {
  static shouldOpenConnectSheet(kind: string): boolean {
    return kind === RemoteConnectEntryKind.OpenConnect;
  }
}
