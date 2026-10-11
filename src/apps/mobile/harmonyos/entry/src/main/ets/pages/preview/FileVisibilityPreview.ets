import {
  ChatMessage,
  FileInfo,
  ReadFileChunkResult,
  ReadFileResult,
  RuntimeFileLocation,
  SessionSummary
} from '../../model/RemoteModels';
import { ChatTimelineRowStore, ObservableChatTimelineItem } from '../../model/ChatTimelineModels';
import { DurableSessionReducer, SessionRecord } from '../../services/DurableSessionReducer';
import { ChatTimelineStore } from '../../services/ChatTimelineStore';
import { HostSessionEvent } from '../../services/HostSessionStream';
import {
  RemoteFileDownloadClient,
  RemoteFileDownloadController,
  RemoteFileDownloadScheduler,
  RemoteFileSaver
} from '../../services/RemoteFileDownloadController';
import { Encoding } from '../../services/Encoding';
import { FilePreviewRequest } from '../../model/FilePreviewTarget';
import { FilePreviewPhase, FilePreviewState } from '../state/FilePreviewState';
import { FilePreviewController } from '../viewmodel/FilePreviewController';
import { AppRoute } from '../navigation/AppRouteContract';
import { ChatTimeline } from '../components/ChatTimeline';
import { FilePreviewSurface } from '../components/FilePreviewSurface';
import { INK, PAGE_BG } from '../components/Theme';

/** One file the fixture host can serve, in the shape the wire would carry it. */
class PreviewFile {
  readonly path: string;
  readonly name: string;
  readonly mimeType: string;
  readonly contentBase64: string;
  /** Derived from the bytes, so the reported size can never drift from them. */
  readonly size: number;

  constructor(path: string, name: string, mimeType: string, contentBase64: string) {
    this.path = path;
    this.name = name;
    this.mimeType = mimeType;
    this.contentBase64 = contentBase64;
    this.size = Encoding.base64ToBytes(contentBase64).length;
  }

  static text(path: string, mimeType: string, text: string): PreviewFile {
    return new PreviewFile(
      path,
      PreviewFileHost.basename(path),
      mimeType,
      Encoding.bytesToBase64(Encoding.utf8ToBytes(text))
    );
  }
}

/**
 * A tiny real PNG so the image branch decodes on device instead of failing on a
 * placeholder, plus the text files the fixture message links to.
 */
const PREVIEW_PNG_BASE64: string =
  'iVBORw0KGgoAAAANSUhEUgAAAHgAAABICAIAAACyfKYoAAABG0lEQVR42u3XIQ5CQRRD0WocG2BfbInV4pAfhQFDArlvMr3N09PmuMnp+ni7w7xyv13+dfmE1pqD1pqD1pqD1pqDLrf+J/RxHFpD0Fpz0Fpz0Fpz0Fpz0Fpz0Fpz0Fpz0Fpz0Fpz0OXWKHSzNQ1daz0A3Wk9A11oPQbdZj0JXWU9DN1jPQ9dYr0EdIP1KtD+0b9Pfn9Cawhaaw5aaw5aaw5aaw5aaw5aaw5aaw5aaw5aaw5aaw5aaw5aaw5a65BlzdaB+2qtw1d2WmektdA6U8Vt1hnsrrLObH2PdcYXlFhnhREN1llkx/bWWWfK3tZZas3G1llt0K7WWXDTltY5GyRCCy20EVpooSUQWmgjtNBCG6GFNkILLbQh8gRhd1Ue5saG0wAAAABJRU5ErkJggg==';

class PreviewFileHost implements RemoteFileDownloadClient {
  private readonly files: Map<string, PreviewFile> = new Map<string, PreviewFile>();

  constructor() {
    this.add(new PreviewFile('png/openbitfun-wordmark.png', 'openbitfun-wordmark.png', 'image/png',
      PREVIEW_PNG_BASE64));
    this.add(PreviewFile.text('artifacts/REPORT.md', 'text/markdown',
      '# Brand report\n\nThe wordmark and the bundle are ready.\n'));
    this.add(new PreviewFile('artifacts/bundle.zip', 'bundle.zip', 'application/zip', 'UEsDBAoAAAAAAA=='));
    this.add(PreviewFile.text('artifacts/run.log', 'text/plain',
      'brand export ok\nbundled 2 files\n'));
  }

  private add(file: PreviewFile): void {
    this.files.set(file.path, file);
  }

  static basename(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  }

  async getFileInfo(path: string, _sessionId?: string): Promise<FileInfo> {
    const file = this.files.get(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    return { name: file.name, size: file.size, mimeType: file.mimeType };
  }

  async readFileChunk(path: string, offset: number, limit: number,
    _sessionId?: string): Promise<ReadFileChunkResult> {
    const file = this.files.get(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    const bytes = Encoding.base64ToBytes(file.contentBase64);
    const end = Math.min(bytes.length, offset + limit);
    const slice = bytes.slice(offset, end);
    return {
      revision: '1:1',
      name: file.name,
      contentBase64: Encoding.bytesToBase64(slice),
      offset,
      chunkSize: slice.length,
      totalSize: bytes.length,
      mimeType: file.mimeType
    };
  }

  async streamFile(path: string, sessionId: string | undefined,
    onChunk: (bytes: Uint8Array, info: FileInfo) => Promise<void>,
    onProgress?: (downloaded: number, total: number) => void,
    _location?: RuntimeFileLocation): Promise<FileInfo> {
    const file = this.files.get(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    const bytes = Encoding.base64ToBytes(file.contentBase64);
    const info = await this.getFileInfo(path, sessionId);
    await onChunk(bytes, info);
    if (onProgress) {
      onProgress(bytes.length, bytes.length);
    }
    return info;
  }

  async readFile(path: string, sessionId?: string, onProgress?: (downloaded: number, total: number) => void,
    maxBytes?: number): Promise<ReadFileResult> {
    const file = this.files.get(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    if (maxBytes !== undefined && file.size > maxBytes) {
      throw new Error('File too large for preview.');
    }
    const info = await this.getFileInfo(path, sessionId);
    if (onProgress) {
      onProgress(file.size, file.size);
    }
    return {
      name: info.name,
      mimeType: info.mimeType,
      size: info.size,
      contentBase64: file.contentBase64
    };
  }
}

/**
 * Stands in for the system document picker and the file it would write, so a
 * download can be proved on a device without a destination dialog in the way.
 * The production `RemoteFileDownloadController` owns everything else.
 */
class PreviewFileSaver implements RemoteFileSaver {
  destinationName: string = '';
  bytesWritten: number = 0;
  committed: boolean = false;
  aborted: boolean = false;

  reset(): void {
    this.destinationName = '';
    this.bytesWritten = 0;
    this.committed = false;
    this.aborted = false;
  }

  async begin(name: string): Promise<void> {
    this.destinationName = name;
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.bytesWritten += bytes.length;
  }

  async finish(): Promise<string> {
    this.committed = true;
    return 'file://preview/download';
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }
}

class PreviewDownloadScheduler implements RemoteFileDownloadScheduler {
  setTimeout(_callback: () => void, _delayMs: number): number {
    return 1;
  }

  clearTimeout(_timerId: number): void {}
}

/**
 * The file-visibility chain as the phone walks it, driven by the production
 * components: a durable assistant turn whose prose links workspace files is
 * projected through the real reducer, timeline store and rows, and a tap on a
 * card routes through the real `FilePreviewController` into the real
 * `FilePreviewSurface`.
 *
 * Only the transport is faked. The fixture host answers `get_file_info`,
 * `read_file_chunk` and the streamed read exactly like `remote_connect.rs`
 * does, so the image branch decodes a real PNG and the text branches show real
 * content. **Next shape** swaps the same links between the final-answer body
 * and a composite turn's trailing text, which is the two paths that draw cards.
 */
@ComponentV2
export struct FileVisibilityPreview {
  private reducer: DurableSessionReducer = new DurableSessionReducer();
  private readonly timeline: ChatTimelineStore = new ChatTimelineStore();
  private readonly rowStore: ChatTimelineRowStore = new ChatTimelineRowStore();
  private readonly fileHost: PreviewFileHost = new PreviewFileHost();
  private readonly previewState: FilePreviewState = new FilePreviewState();
  private readonly fileSaver: PreviewFileSaver = new PreviewFileSaver();
  private readonly downloads: RemoteFileDownloadController = new RemoteFileDownloadController(
    this.fileHost,
    (downloadingFilePath: string, downloadedFilePath: string, fileDownloadStatus: string): void => {
      this.downloadingFilePath = downloadingFilePath;
      this.downloadedFilePath = downloadedFilePath;
      this.downloadStatus = fileDownloadStatus;
    },
    (): void => {
      this.downloadingFilePath = '';
    },
    (statusText: string): void => {
      this.downloadStatus = statusText;
      this.savedSummary = this.fileSaver.committed ?
        `${this.fileSaver.destinationName}:${this.fileSaver.bytesWritten}` : '';
    },
    (_isBusy: boolean): void => {},
    2500,
    new PreviewDownloadScheduler(),
    this.fileSaver
  );
  @Local rows: ObservableChatTimelineItem[] = [];
  @Local revision: number = 0;
  @Local shape: number = 0;
  @Local routed: string = '';
  @Local previewVisible: boolean = false;
  @Local downloadingFilePath: string = '';
  @Local downloadedFilePath: string = '';
  @Local downloadStatus: string = '';
  @Local savedSummary: string = '';
  private previewController?: FilePreviewController = undefined;

  aboutToAppear(): void {
    this.previewController = new FilePreviewController(
      this.fileHost,
      this.previewState,
      {
        remoteAvailable: (): boolean => true,
        activeSession: (): SessionSummary => {
          const summary: SessionSummary = {
            sessionId: 'preview-file-session',
            title: 'File visibility',
            workspacePath: '/workspace/project',
            agentType: 'code'
          };
          return summary;
        },
        workspacePath: (): string => '/workspace/project',
        openExternalLink: async (_reference: string): Promise<boolean> => true,
        onGeneralStatus: (_statusText: string): void => {},
        onRemoteStatus: (statusText: string): void => {
          this.routed = statusText;
        }
      }
    );
    this.timeline.reset('preview-file-session');
    this.publishShape();
  }

  aboutToDisappear(): void {
    if (this.previewController) {
      this.previewController.close();
    }
  }

  private finalAnswer(): string {
    return 'Done. The brand export wrote these files:\n\n' +
      '- [openbitfun-wordmark.png](computer://png/openbitfun-wordmark.png)\n' +
      '- [REPORT.md](computer://artifacts/REPORT.md)\n' +
      '- [bundle.zip](computer://artifacts/bundle.zip)\n\n' +
      'The run log is at computer://artifacts/run.log, and the source image is ' +
      'png/openbitfun-wordmark.png.';
  }

  private trailingAnswer(): string {
    return 'Checked the workspace files.\n\n' +
      '- [openbitfun-wordmark.png](computer://png/openbitfun-wordmark.png)\n' +
      '- [REPORT.md](computer://artifacts/REPORT.md)';
  }

  private record(id: string, revision: number, type: string, order: number, content: string,
    toolName: string): HostSessionEvent {
    const payload: SessionRecord = {
      sessionId: 'preview-file-session',
      id: `item/${id}`,
      revision,
      turn: {
        turnId: 'turn-file-preview',
        turnIndex: 0,
        sessionId: 'preview-file-session',
        timestamp: 1,
        userMessage: { id: 'user-file-preview', content: 'Export the brand assets', timestamp: 1 },
        status: 'completed'
      },
      round: { id: 'round-file-preview', turnId: 'turn-file-preview', roundIndex: 0, timestamp: 2,
        status: 'completed' },
      item: {
        type,
        data: { id, orderIndex: order, timestamp: 3, content, toolName, status: 'completed' }
      }
    };
    return { session_id: 'preview-file-session', event: 'session-record', payload };
  }

  /** Rebuilds the transcript for the selected shape and republishes the rows. */
  private publishShape(): void {
    this.reducer = new DurableSessionReducer();
    if (this.shape === 0) {
      this.reducer.apply(this.record('final-text', 1, 'text', 0, this.finalAnswer(), ''));
    } else {
      this.reducer.apply(this.record('think', 1, 'thinking', 0, 'Reading the export output', ''));
      this.reducer.apply(this.record('read', 2, 'tool', 1, '', 'Read'));
      this.reducer.apply(this.record('trailing-text', 3, 'text', 2, this.trailingAnswer(), ''));
    }
    this.publish();
  }

  private publish(): void {
    const messages = this.reducer.messages();
    this.timeline.applySnapshot({
      sessionId: 'preview-file-session',
      cursor: { pollVersion: 0, knownMessageCount: messages.length, knownModelCatalogVersion: 0 },
      changed: true,
      title: '',
      sessionState: 'idle',
      newMessages: [],
      messageSnapshot: messages,
      activeTurn: undefined,
      shouldSyncAfterTurnEnded: false,
      historyRewritten: false,
      completedTurnId: ''
    });
    this.rows = this.rowStore.reconcile(this.timeline.project(false));
    this.revision++;
  }

  private openFilePreview(reference: string, label: string): void {
    if (!this.previewController) {
      return;
    }
    this.routed = reference;
    this.previewController.open(AppRoute.RemoteChat, new FilePreviewRequest(reference, label));
    this.previewVisible = this.previewState.visible;
  }

  private routeSummary(): string {
    const phase = this.previewState.visible ? this.previewState.phase : FilePreviewPhase.Idle;
    const saved = this.savedSummary.length > 0 ? ` saved=${this.savedSummary}` : '';
    return `shape=${this.shape} phase=${phase} kind=${this.previewState.rendererKind} ` +
      `bytes=${this.previewState.loadedBytes} last=${this.routed}${saved}`;
  }

  private downloadFile(reference: string): void {
    this.downloadedFilePath = '';
    this.savedSummary = '';
    this.fileSaver.reset();
    void this.downloads.download(
      reference,
      'preview-file-session',
      false,
      true
    );
  }

  private closePreview(): void {
    if (this.previewController) {
      this.previewController.close();
    }
    this.previewVisible = false;
  }

  build() {
    Stack() {
      Column({ space: 8 }) {
        Row({ space: 8 }) {
          Button('Next shape').id('file-visibility-shape').onClick(() => {
            this.shape = this.shape === 0 ? 1 : 0;
            this.closePreview();
            this.publishShape();
          })
        }
        Text(this.routeSummary()).id('file-visibility-state').fontColor(INK).fontSize(12)
        ChatTimeline({
          timelineItems: this.rows,
          timelineRevision: this.revision,
          connectionState: 'connected',
          isBusy: false,
          downloadingFilePath: this.downloadingFilePath,
          downloadedFilePath: this.downloadedFilePath,
          fileDownloadStatus: this.downloadStatus,
          activeFilePreviewPath: this.previewState.visible ? this.previewState.target.remotePath : '',
          activeFilePreviewLoading: this.previewState.visible &&
            this.previewState.phase === FilePreviewPhase.Loading,
          onOpenFilePreview: (path: string, label: string) => {
            this.openFilePreview(path, label);
          },
          onDownloadFile: (path: string) => {
            this.downloadFile(path);
          }
        })
          .layoutWeight(1)
      }
      .width('100%')
      .height('100%')
      .backgroundColor(PAGE_BG)

      if (this.previewVisible) {
        Column() {
          FilePreviewSurface({
            state: this.previewState,
            remoteAvailable: true,
            downloadPath: this.downloadingFilePath,
            downloadedPath: this.downloadedFilePath,
            downloadStatus: this.downloadStatus,
            onClose: () => {
              this.closePreview();
            },
            onRefresh: () => {
              if (this.previewController) {
                this.previewController.refresh();
              }
            },
            onDownload: (path: string) => {
              this.downloadFile(path);
            },
            onOpenLink: (reference: string, label: string) => {
              this.openFilePreview(reference, label);
            }
          })
        }
        .width('100%')
        .height('100%')
        .backgroundColor(PAGE_BG)
      }
    }
    .width('100%')
    .height('100%')
  }
}