import { RemoteFileDownloadController } from '../../services/RemoteFileDownloadController';
import { WorkspaceFileUploadClient } from '../../services/WorkspaceFileUploadClient';
import { Encoding } from '../../services/Encoding';
import { RemoteSessionManager } from '../../services/RemoteSessionManager';
import { HostSessionStream } from '../../services/HostSessionStream';
import { WorkspaceToolsState, WorkspaceToolsIntent, WorkspaceFileEntry, WorkspaceTerminalEntry, WorkspaceToolLocation } from '../state/WorkspaceToolsState';
import { RuntimeFileLocation } from '../../model/RemoteModels';

interface RuntimeSystemInfo { homeDir?: string; }
interface DirectoryPage { children: WorkspaceFileEntry[]; hasMore: boolean; }
interface TerminalPage { data: string; nextOffset: number; cursor: number; truncated: boolean; }
interface TerminalCreated { id: string; }
interface FileRequest { sortBy?: string; sortOrder?: string; expectedHash?: string; path?: string; filePath?: string; oldPath?: string; newPath?: string; content?: string; workspacePath?: string; remoteConnectionId?: string; offset?: number; limit?: number; recursive?: boolean; }
interface FileArgs { request: FileRequest; }
interface TerminalRequest { sessionId?: string; workingDirectory?: string; connectionId?: string; cols?: number; rows?: number; source?: string; data?: string; immediate?: boolean; }
interface TerminalArgs { request: TerminalRequest; }
interface TerminalHistoryArgs { sessionId: string; afterOffset: number; }

/** Files and PTYs always belong to the selected runtime, including saved SSH targets. */
export class WorkspaceToolsViewModel {
  private browseGeneration: number = 0;
  private state: WorkspaceToolsState;
  private manager: RemoteSessionManager;
  private target: () => string;
  private location?: RuntimeFileLocation;
  private deviceScope: boolean = false;
  private download?: RemoteFileDownloadController;
  private upload: WorkspaceFileUploadClient;
  private owner: string = '';
  private originalContent: string = '';
  private pendingNavigation?: WorkspaceToolsIntent;
  private expectedHash: string = ''; 
  private epoch: number = 0;
  private stream?: HostSessionStream;
  private terminalCursor: number = 0;
  private terminalGeneration: number = 0;
  private readingTerminal: boolean = false;
  private terminalDirty: boolean = false;
  private terminalHistoryError: string = '';
  private inputBuffer: string = '';
  private inputTimer: number = -1;
  private inputSending: boolean = false;
  private resizeTimer: number = -1;
  constructor(state: WorkspaceToolsState, manager: RemoteSessionManager, target: () => string) {
    this.state = state; this.manager = manager; this.target = target;
    this.upload = new WorkspaceFileUploadClient(manager, target);
  }
  dispatch(intent: WorkspaceToolsIntent): void {
    if (intent.type === 'file-action-cancel') { if (!this.state.busy) this.state.fileAction = ''; return; }
    if (intent.type === 'file-action-name') { if (!this.state.busy) this.state.fileActionName = intent.text || ''; return; }
    if (intent.type === 'file-action') {
      if (this.state.busy) return;
      this.state.fileAction = intent.text || ''; this.state.fileActionPath = intent.path || '';
      this.state.fileActionName = this.state.entries.find((entry: WorkspaceFileEntry): boolean => entry.path === intent.path)?.name || '';
      this.state.error = ''; return;
    }
    if (intent.type === 'panel') { this.state.initialTab = intent.tab || 0; return; }
    if (intent.type === 'browse-workspace' || intent.type === 'browse-more') { void this.browseWorkspace(intent); return; }
    if (intent.type === 'discard-cancel') { this.pendingNavigation = undefined; this.state.confirmDiscard = false; return; }
    if (intent.type === 'discard-confirm') {
      const next = this.pendingNavigation; this.pendingNavigation = undefined; this.state.confirmDiscard = false;
      this.state.content = this.originalContent; this.state.dirty = false;
      if (next) this.dispatch(next); return;
    }
    if (this.state.dirty && ['close', 'editor-back', 'read', 'read-new', 'directory', 'open', 'open-device'].includes(intent.type)) {
      this.pendingNavigation = intent; this.state.confirmDiscard = true;
      if (intent.type === 'open' || intent.type === 'open-device') this.state.visible = true;
      return;
    }
    if (intent.type === 'editor-back') { this.state.editorVisible = false; this.state.editing = false; return; }
    if (intent.type === 'editor-edit') { this.state.editing = true; return; }
    if (intent.type === 'line-numbers') { this.state.lineNumbers = !this.state.lineNumbers; return; }
    if (intent.type === 'sort') { this.state.sort = Number(intent.text || '0'); void this.run({ type: 'directory' }); return; }

    if (intent.type === 'terminal-renderer-error' || intent.type === 'file-renderer-error') { this.state.error = intent.text || ''; return; }
    if (intent.type === 'terminal-write') { this.queueInput(intent.text || ''); return; }
    if (intent.type === 'terminal-resize') { this.queueResize(intent.text || ''); return; }
    if (intent.type === 'edit') { this.state.content = intent.text || ''; this.state.dirty = this.state.content !== this.originalContent; return; }
    if (intent.type === 'read-new') { this.state.selectedFile = intent.path || ''; this.state.content = ''; this.originalContent = ''; this.expectedHash = ''; this.state.editorVisible = true; this.state.editing = true; this.state.dirty = false; return; }
    if (intent.type === 'close') { this.close(); return; }
    void this.run(intent);
  }
  private async browseWorkspace(intent: WorkspaceToolsIntent): Promise<void> {
    const generation = ++this.browseGeneration; const target = this.target();
    const path = intent.path || '/'; const append = intent.type === 'browse-more';
    this.state.browseBusy = true; this.state.browseError = '';
    if (!append) { this.state.browseEntries = []; this.state.browseHasMore = false; }
    try {
      const args: FileArgs = { request: { path: path, remoteConnectionId: intent.text || '',
        offset: append ? this.state.browseEntries.length : 0, limit: 100, sortBy: 'name', sortOrder: 'asc' } };
      const page = await this.manager.hostInvoke<DirectoryPage>('get_directory_children_paginated', args);
      if (generation !== this.browseGeneration || target !== this.target()) return;
      this.state.browsePath = path;
      this.state.browseEntries = append ? this.state.browseEntries.concat(page.children) : page.children;
      this.state.browseHasMore = page.hasMore;
    } catch (error) { if (generation === this.browseGeneration && target === this.target()) this.state.browseError = String(error); }
    finally { if (generation === this.browseGeneration) this.state.browseBusy = false; }
  }
  private queueInput(data: string): void {
    if (!this.current(this.epoch) || !this.state.terminalId || (!data && !this.inputBuffer)) return;
    this.inputBuffer += data;
    if (!this.inputSending && this.inputTimer === -1) {
      const epoch = this.epoch; const terminalId = this.state.terminalId;
      this.inputTimer = setTimeout(() => { this.inputTimer = -1; void this.flushInput(terminalId, epoch); }, 8);
    }
  }
  private async flushInput(terminalId: string, epoch: number): Promise<void> {
    if (this.inputSending) return;
    this.inputSending = true;
    try {
      while (this.inputBuffer && this.current(epoch) && terminalId === this.state.terminalId) {
        let end = Math.min(this.inputBuffer.length, 64 * 1024);
        const last = this.inputBuffer.charCodeAt(end - 1);
        if (end < this.inputBuffer.length && last >= 0xd800 && last <= 0xdbff) end--;
        const data = this.inputBuffer.slice(0, end);
        this.inputBuffer = this.inputBuffer.slice(data.length);
        const args: TerminalArgs = { request: { sessionId: terminalId, data: data } };
        await this.manager.hostInvoke<Object>('terminal_write', args);
      }
    } catch (error) {
      // An uncertain write may already have reached the PTY. Never replay it.
      if (this.current(epoch) && terminalId === this.state.terminalId) { this.inputBuffer = ''; this.state.error = String(error); }
    } finally { this.inputSending = false; if (this.inputBuffer) this.queueInput(''); }
  }
  private queueResize(value: string): void {
    if (this.resizeTimer !== -1) clearTimeout(this.resizeTimer);
    const epoch = this.epoch; const terminalId = this.state.terminalId;
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = -1;
      if (!this.current(epoch) || !terminalId || terminalId !== this.state.terminalId) return;
      const values = value.split('x').map((part: string) => Number(part));
      if (values.length !== 2 || values.some((dimension: number) => !Number.isSafeInteger(dimension) || dimension < 1)) return;
      const args: TerminalArgs = { request: { sessionId: terminalId, cols: values[0], rows: values[1] } };
      void this.manager.hostInvoke<Object>('terminal_resize', args).catch((error: Error) => { if (this.current(epoch)) this.state.error = error.message; });
    }, 80);
  }
  private clearInput(): void {
    this.inputBuffer = '';
    if (this.inputTimer !== -1) clearTimeout(this.inputTimer);
    if (this.resizeTimer !== -1) clearTimeout(this.resizeTimer);
    this.inputTimer = -1; this.resizeTimer = -1;
  }
  private close(): void {
    this.clearInput();
    this.download?.cancel(); this.download = undefined;
    this.epoch++; this.terminalGeneration++; this.stream?.close(); this.stream = undefined; this.state.visible = false; this.state.fileAction = '';
  }
  private current(epoch: number): boolean { return epoch === this.epoch && this.owner === this.target() && this.state.visible; }
  private async run(intent: WorkspaceToolsIntent): Promise<void> {
    const opening = intent.type === 'open' || intent.type === 'open-device';
    if (opening) {
      this.close(); this.owner = this.target(); this.state.visible = true;
      this.location = undefined; this.state.entries = []; this.state.directory = ''; this.state.terminals = [];
      this.state.editorVisible = false; this.state.dirty = false; this.state.confirmDiscard = false;
      this.state.selectedFile = ''; this.state.content = ''; this.state.output = ''; this.state.terminalId = ''; this.state.busy = false;
    }
    const epoch = this.epoch;
    if (!this.current(epoch) || this.state.busy) return;
    this.state.busy = true; this.state.error = '';
    try {
      if (!opening && !this.location) throw new Error('Choose a location on the controlled runtime first');
      if (opening) {
        if (intent.deviceId && intent.deviceId !== this.owner) throw new Error('The controlled runtime changed');
        this.deviceScope = intent.type === 'open-device';
        this.state.deviceScope = this.deviceScope;
        this.state.connectionId = intent.connectionId || '';
        if (this.deviceScope) {
          const emptyArgs: Record<string, string> = {};
          const locations = await this.manager.hostInvoke<WorkspaceToolLocation[]>('ssh_list_saved_connections', emptyArgs);
          if (!this.current(epoch)) return;
          this.state.locations = locations;
          if (intent.connectionId && !locations.some((item: WorkspaceToolLocation): boolean => item.id === intent.connectionId)) {
            throw new Error('Saved connection is unavailable on the controlled runtime');
          }
        }
        let path = intent.path || '';
        if (this.deviceScope) {
          if (intent.connectionId) path = '/';
          else {
            const empty: Record<string, string> = {};
            const system = await this.manager.hostInvoke<RuntimeSystemInfo>('get_system_info', empty);
            if (!this.current(epoch)) return;
            path = system.homeDir || '';
          }
        }
        if (!path) throw new Error('The runtime did not provide a default directory');
        const workspace: RuntimeFileLocation = { path: path, remoteConnectionId: intent.connectionId };
        this.state.initialTab = intent.tab || 0;
        this.location = workspace; this.state.directory = workspace.path;
        await this.directory(workspace.path, false, epoch);
        if (!this.current(epoch)) return;
        const emptyArgs: Record<string, string> = {};
        const terminals = await this.manager.hostInvoke<WorkspaceTerminalEntry[]>('terminal_list', emptyArgs);
        if (this.current(epoch)) this.state.terminals = terminals.filter((terminal: WorkspaceTerminalEntry): boolean =>
          (this.deviceScope || (terminal.initialCwd || terminal.cwd) === workspace.path) && (terminal.connectionId || '') === (workspace.remoteConnectionId || ''));
      } else if (intent.type === 'directory' || intent.type === 'more') {
        await this.directory(intent.path || this.state.directory, intent.type === 'more', epoch);
      } else if (intent.type === 'read') {
        const path = intent.path || '';
        const content = await this.file<string>('read_file_content', { filePath: path });
        const hash = await Encoding.sha256(content);
        if (this.current(epoch)) { this.state.selectedFile = path; this.state.content = content; this.originalContent = content; this.expectedHash = hash; this.state.editorVisible = true; this.state.editing = false; this.state.dirty = false; }
      } else if (intent.type === 'download') {
        if (!this.location) throw new Error('Select a runtime location first');
        const location: RuntimeFileLocation = { path: this.state.directory, remoteConnectionId: this.location.remoteConnectionId };
        this.download = new RemoteFileDownloadController(this.manager,
          (_pending: string, _saved: string, status: string): void => { if (this.current(epoch)) this.state.downloadStatus = status; },
          (): void => {}, (): void => {}, (): void => {});
        await this.download.download(intent.path || this.state.selectedFile, '', false, true, location);
      } else if (intent.type === 'save') {
        const savedContent = this.state.content;
        await this.file<Object>('write_file_content', { filePath: intent.path || this.state.selectedFile, content: savedContent, expectedHash: this.expectedHash, workspacePath: this.location?.path });
        const hash = await Encoding.sha256(savedContent);
        if (this.current(epoch)) { this.expectedHash = hash; this.originalContent = savedContent; this.state.dirty = this.state.content !== savedContent; }
        await this.directory(this.state.directory, false, epoch);
      } else if (intent.type === 'upload' || intent.type === 'upload-resume') {
        if (intent.type === 'upload') this.state.uploadProgress = 0;
        if (intent.type === 'upload') await this.upload.select(intent.path || '', this.location?.remoteConnectionId, intent.path === this.state.selectedFile ? this.expectedHash : '', () => this.current(epoch), this.location?.path || '');
        await this.upload.resume(() => this.current(epoch), (offset: number, total: number) => { if (this.current(epoch)) this.state.uploadProgress = total ? Math.floor(offset * 100 / total) : 100; });
        if (this.current(epoch)) this.state.uploadPending = this.upload.hasPending();
        await this.directory(this.state.directory, false, epoch);
      } else if (intent.type === 'upload-cancel') {
        await this.upload.cancel(); if (this.current(epoch)) this.state.uploadPending = false;
      } else if (intent.type === 'file-action-submit') {
        const action = this.state.fileAction;
        const name = this.state.fileActionName;
        const oldPath = this.state.fileActionPath;
        if (action !== 'delete' && !name.trim()) throw new Error('A file name is required');
        const path = name.startsWith('/') ? name : `${this.state.directory.replace(/\/$/, '')}/${name}`;
        const entry = this.state.entries.find((item: WorkspaceFileEntry): boolean => item.path === oldPath);
        if ((action === 'rename' || action === 'delete') && !entry) throw new Error('File entry is no longer available');
        if (action === 'file') await this.file<Object>('write_file_content', { filePath: path, workspacePath: this.location?.path, content: '', expectedHash: '' });
        else if (action === 'folder') await this.file<Object>('create_directory', { path: path });
        else if (action === 'rename') await this.file<Object>('rename_file', { oldPath: oldPath, newPath: path });
        else if (action === 'delete') await this.file<Object>(entry?.isDirectory ? 'delete_directory' : 'delete_file', { path: oldPath, recursive: false });
        else if (action === 'upload') {
          await this.upload.select(path, this.location?.remoteConnectionId, '', () => this.current(epoch), this.location?.path || '');
          await this.upload.resume(() => this.current(epoch), (offset: number, total: number) => { if (this.current(epoch)) this.state.uploadProgress = total ? Math.floor(offset * 100 / total) : 100; });
        } else throw new Error('Unknown file action');
        await this.directory(this.state.directory, false, epoch);
        if (this.current(epoch)) this.state.fileAction = '';
      } else if (intent.type === 'mkdir') {
        await this.file<Object>('create_directory', { path: intent.path });
        await this.directory(this.state.directory, false, epoch);
      } else if (intent.type === 'rename') {
        await this.file<Object>('rename_file', { oldPath: this.state.selectedFile, newPath: intent.path });
        if (this.current(epoch)) this.state.selectedFile = intent.path || '';
        await this.directory(this.state.directory, false, epoch);
      } else if (intent.type === 'delete' || intent.type === 'rmdir') {
        await this.file<Object>(intent.type === 'delete' ? 'delete_file' : 'delete_directory', { path: intent.path || this.state.selectedFile, recursive: false });
        if (this.current(epoch)) { this.state.selectedFile = ''; this.state.content = ''; }
        await this.directory(this.state.directory, false, epoch);
      } else if (intent.type === 'terminal-create') {
        const request: TerminalRequest = { workingDirectory: this.location?.path, connectionId: this.location?.remoteConnectionId || '', cols: 80, rows: 24, source: 'user' };
        const args: TerminalArgs = { request: request };
        const terminal = await this.manager.hostInvoke<TerminalCreated>('terminal_create', args);
        if (this.current(epoch)) { this.attach(terminal.id); this.state.terminals = this.state.terminals.concat([{ id: terminal.id }]); }
      } else if (intent.type === 'terminal-attach') {
        this.attach(intent.path || '');
      } else if (intent.type === 'terminal-write') {
        const args: TerminalArgs = { request: { sessionId: this.state.terminalId, data: intent.text || '' } };
        await this.manager.hostInvoke<Object>('terminal_write', args);
      } else if (intent.type === 'terminal-close') {
        const args: TerminalArgs = { request: { sessionId: this.state.terminalId, immediate: true } };
        await this.manager.hostInvoke<Object>('terminal_close', args);
        if (this.current(epoch)) {
          this.terminalGeneration++; this.stream?.close(); this.stream = undefined;
          this.state.terminals = this.state.terminals.filter((entry: WorkspaceTerminalEntry) => entry.id !== this.state.terminalId);
          this.state.terminalId = ''; this.state.output = '';
        }
      } else if (intent.type === 'terminal-resize') {
        const parts = (intent.text || '').split('x');
        const cols = Number(parts[0]); const rows = Number(parts[1]);
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) throw new Error('Use columns x rows, for example 80x24');
        const args: TerminalArgs = { request: { sessionId: this.state.terminalId, cols: cols, rows: rows } };
        await this.manager.hostInvoke<Object>('terminal_resize', args);
      }
    } catch (error) { if (this.current(epoch)) this.state.error = String(error); }
    finally { if (this.current(epoch)) { this.state.busy = false; this.state.uploadPending = this.upload.hasPending(); } }
  }
  private file<T>(command: string, request: FileRequest): Promise<T> {
    if (this.owner !== this.target()) throw new Error('Controlled runtime changed');
    request.remoteConnectionId = this.location?.remoteConnectionId || '';
    request.workspacePath = this.location?.path;
    const args: FileArgs = { request: request };
    return this.manager.hostInvoke<T>(command, args);
  }
  private async directory(path: string, append: boolean, epoch: number): Promise<void> {
    if (!this.current(epoch)) return;
    const page = await this.file<DirectoryPage>('get_directory_children_paginated', { path: path, offset: append ? this.state.entries.length : 0, limit: 100, sortBy: this.state.sort < 2 ? 'name' : 'modified', sortOrder: this.state.sort % 2 === 0 ? 'asc' : 'desc' });
    if (!this.current(epoch)) return;
    this.state.directory = path;
    if (this.deviceScope && this.location) this.location = { path: path, remoteConnectionId: this.location.remoteConnectionId };
    this.state.entries = append ? this.state.entries.concat(page.children) : page.children;
    this.state.hasMore = page.hasMore;
  }
  private attach(id: string): void {
    this.clearInput();
    const generation = ++this.terminalGeneration;
    this.stream?.close(); this.state.terminalId = id; this.state.output = ''; this.terminalCursor = 0;
    const epoch = this.epoch;
    this.stream = this.manager.subscribeSession(`terminal-${id}`, {
      onEvent: async (): Promise<void> => { if (this.currentTerminal(id, epoch, generation)) this.terminalDirty = true; },
      onCaughtUp: async (): Promise<void> => {
        if (!this.currentTerminal(id, epoch, generation)) return;
        this.terminalDirty = true; await this.readTerminal(id, epoch, generation);
      },
      onError: (error: Error): void => { if (this.currentTerminal(id, epoch, generation)) { this.terminalHistoryError = error.message; this.state.error = error.message; } }
    });
    this.terminalDirty = true;
    void this.readTerminal(id, epoch, generation);
  }
  private currentTerminal(id: string, epoch: number, generation: number): boolean {
    return this.current(epoch) && generation === this.terminalGeneration && id === this.state.terminalId;
  }
  private async readTerminal(id: string, epoch: number, generation: number): Promise<void> {
    if (!this.currentTerminal(id, epoch, generation)) return;
    if (this.readingTerminal) { this.terminalDirty = true; return; }
    this.readingTerminal = true;
    try {
      while (this.terminalDirty && this.currentTerminal(id, epoch, generation)) {
        this.terminalDirty = false;
        const args: TerminalHistoryArgs = { sessionId: id, afterOffset: this.terminalCursor };
        const page = await this.manager.hostInvoke<TerminalPage>('terminal_get_history', args);
        if (!this.currentTerminal(id, epoch, generation)) return;
        if (!Number.isSafeInteger(page.nextOffset) || !Number.isSafeInteger(page.cursor) || page.nextOffset < 0 || page.cursor < page.nextOffset) throw new Error('Invalid terminal history cursor');
        if (page.nextOffset < this.terminalCursor && !page.truncated) throw new Error('Terminal cursor moved backwards');
        if (!(page.nextOffset > this.terminalCursor || (page.truncated && page.nextOffset < this.terminalCursor) || page.nextOffset === page.cursor)) throw new Error('Terminal history made no progress');
        if (this.terminalHistoryError.length > 0 && this.state.error === this.terminalHistoryError) this.state.error = '';
        this.terminalHistoryError = '';
        this.state.output = (page.truncated ? '' : this.state.output) + page.data;
        // Match the runtime's retained display history; the durable stream stores notifications only.
        if (this.state.output.length > 4 * 1024 * 1024) this.state.output = this.state.output.slice(-4 * 1024 * 1024);
        this.terminalCursor = page.nextOffset;
        this.terminalDirty = this.terminalDirty || page.nextOffset < page.cursor;
      }
    } catch (error) { if (this.currentTerminal(id, epoch, generation)) { this.terminalHistoryError = String(error); this.state.error = this.terminalHistoryError; } }
    finally {
      this.readingTerminal = false;
      if (this.terminalDirty && this.state.visible && generation !== this.terminalGeneration) void this.readTerminal(this.state.terminalId, this.epoch, this.terminalGeneration);
    }
  }
}
