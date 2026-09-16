export interface WorkspaceToolLocation { id: string; name: string; }
export interface WorkspaceFileEntry { path: string; name: string; isDirectory: boolean; size?: number; modifiedTime?: number; }
export interface WorkspaceTerminalEntry { id: string; name?: string; initialCwd?: string; cwd?: string; connectionId?: string; }
export interface WorkspaceToolsIntent { type: string; path?: string; text?: string; deviceId?: string; connectionId?: string; tab?: number; }
@ObservedV2
export class WorkspaceToolsState {
  @Trace fileAction: string = '';
  @Trace fileActionPath: string = '';
  @Trace fileActionName: string = '';
  @Trace browsePath: string = '';
  @Trace browseEntries: WorkspaceFileEntry[] = [];
  @Trace browseHasMore: boolean = false;
  @Trace browseBusy: boolean = false;
  @Trace browseError: string = '';
  @Trace visible: boolean = false;
  @Trace deviceScope: boolean = false;
  @Trace connectionId: string = '';
  @Trace locations: WorkspaceToolLocation[] = [];
  @Trace busy: boolean = false;
  @Trace error: string = '';
  get saveConflict(): boolean {
    return this.error.startsWith('FILE_CONFLICT:') || this.error.startsWith('Error: FILE_CONFLICT:');
  }
  @Trace downloadStatus: string = '';
  @Trace uploadPending: boolean = false;
  @Trace uploadProgress: number = 0;
  @Trace directory: string = '';
  @Trace entries: WorkspaceFileEntry[] = [];
  @Trace hasMore: boolean = false;
  @Trace initialTab: number = 0;
  @Trace sort: number = 0;
  @Trace editorVisible: boolean = false;
  @Trace editing: boolean = false;
  @Trace dirty: boolean = false;
  @Trace confirmDiscard: boolean = false;
  @Trace lineNumbers: boolean = true;
  @Trace selectedFile: string = '';
  @Trace content: string = '';
  @Trace terminals: WorkspaceTerminalEntry[] = [];
  @Trace terminalId: string = '';
  @Trace output: string = '';
}
