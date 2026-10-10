import {
  RemoteCommandCatalog,
  RemoteSessionUsageReport
} from '../model/RemoteModels';
import { CommandPaletteNoticeKind, CommandPalettePolicy } from './CommandPalettePolicy';
import { ConnectionErrorPolicy } from './ConnectionErrorPolicy';
import { RemoteLogger } from './RemoteLogger';

/**
 * The wire side of the composer command palette.
 *
 * Four desktop verbs — one read (the skill catalog) and three actions (compact,
 * init, usage) — travel as `host_invoke` calls over the connection the phone
 * already has. Nothing here needs a capability handshake: the first catalog read
 * *is* the probe, and its answer decides whether the row may run anything. A
 * host that predates one of these commands refuses it with its own error text,
 * which the row shows instead of pretending the tap did nothing.
 *
 * The catalog is cached per session; it is read on entry, never on render.
 */
export interface RemoteCommandPaletteScope {
  sessionId: string;
  /** Owning workspace record ID; the paths below are its IO projection. */
  workspaceId?: string;
  workspacePath?: string;
  remoteConnectionId?: string;
  remoteSshHost?: string;
}

export interface RemoteSkillCatalogQuery extends RemoteCommandPaletteScope {
  /** The active session's agent type, which is the host's mode id. */
  modeId: string;
  forceRefresh: boolean;
}

export interface RemoteCommandPaletteClient {
  /** Resolves with the host's answer; rejects when the host cannot serve it. */
  skillCatalog(query: RemoteSkillCatalogQuery): Promise<RemoteCommandCatalog>;
  compactSession(query: RemoteCommandPaletteScope): Promise<string>;
  runInitAgentsMd(query: RemoteCommandPaletteScope): Promise<string>;
  sessionUsageReport(query: RemoteCommandPaletteScope): Promise<RemoteSessionUsageReport | undefined>;
}

export interface RemoteCommandPaletteCallbacks {
  onCatalogLoading: (sessionId: string) => void;
  onCatalogReady: (sessionId: string, catalog: RemoteCommandCatalog) => void;
  /**
   * The read failed. This is the probe's negative answer — the row degrades and
   * the sheet offers 「重新检查」, which replays it.
   */
  onCatalogFailed: (sessionId: string, errorText: string) => void;
  onCommandStarted: (sessionId: string, wireAction: string) => void;
  /** A settled verb. `errorText` is empty on success, and the host's message is. */
  onCommandSettled: (sessionId: string, wireAction: string, errorText: string, message: string) => void;
  /** The completion line has been up for its dwell time and may fade out. */
  onCommandNoticeExpired: (sessionId: string, wireAction: string) => void;
  onUsageLoading: (sessionId: string) => void;
  onUsageReady: (sessionId: string, report: RemoteSessionUsageReport | undefined) => void;
  onUsageFailed: (sessionId: string, errorText: string) => void;
}

/**
 * How far the palette's behavior probe has got for the active session.
 *
 * There is no capability handshake to consult, so the row reads this instead:
 * `Probed` is the only state whose chips may reach the host, `Unprobed` is where
 * every session starts (and reads like a busy row for one round trip), and
 * `Failed` is a desktop that refused the read and needs a re-check or an update.
 */
export enum CommandPaletteProbe {
  Unprobed = 'unprobed',
  Probed = 'probed',
  Failed = 'failed'
}

export class RemoteCommandPaletteController {
  private readonly client: RemoteCommandPaletteClient;
  private readonly callbacks: RemoteCommandPaletteCallbacks;
  private catalogSessionId: string = '';
  private catalog?: RemoteCommandCatalog;
  /** The probe's answer for `catalogSessionId`. */
  private catalogProbe: string = CommandPaletteProbe.Unprobed;
  /** The host's own text for a failed probe, shown where the row explains itself. */
  private catalogErrorText: string = '';
  /** Wire id of the palette verb in flight, or '' when the row is idle. */
  private runningAction: string = '';
  private noticeTimerId: number = -1;

  constructor(client: RemoteCommandPaletteClient, callbacks: RemoteCommandPaletteCallbacks) {
    this.client = client;
    this.callbacks = callbacks;
  }

  runningCommand(): string {
    return this.runningAction;
  }

  isRunning(): boolean {
    return this.runningAction.length > 0;
  }

  catalogFor(sessionId: string): RemoteCommandCatalog | undefined {
    return this.catalogSessionId === sessionId ? this.catalog : undefined;
  }

  /** Whether a read for this session has already answered for this session. */
  catalogProbeFor(sessionId: string): string {
    return this.catalogSessionId === sessionId ? this.catalogProbe : CommandPaletteProbe.Unprobed;
  }

  /** The host's refusal text for this session's failed probe, or ''. */
  catalogErrorFor(sessionId: string): string {
    return this.catalogSessionId === sessionId ? this.catalogErrorText : '';
  }

  /** Drops the cached catalog and pending notice when the conversation ends. */
  reset(): void {
    this.cancelNoticeTimer();
    this.catalogSessionId = '';
    this.catalog = undefined;
    this.catalogProbe = CommandPaletteProbe.Unprobed;
    this.catalogErrorText = '';
    this.runningAction = '';
  }

  private static shortSessionId(sessionId: string): string {
    return sessionId.length <= 8 ? sessionId :
      `${sessionId.slice(0, 4)}...${sessionId.slice(sessionId.length - 4)}`;
  }

  /**
   * Reads the skill catalog for one session — the palette's behavior probe.
   *
   * `force` is the user's 「重新检查」: it replays a read that failed, so a
   * desktop upgraded since the last attempt is picked up without restarting the
   * app. A non-forced call with an answer already in hand does nothing, which is
   * what keeps this off the render path.
   */
  async loadCatalog(
    sessionId: string,
    modeId: string,
    force: boolean,
    canApply: (sessionId: string) => boolean
  ): Promise<void> {
    if (sessionId.length === 0 || !canApply(sessionId)) {
      return;
    }
    if (!force && this.catalogSessionId === sessionId &&
      this.catalogProbe !== CommandPaletteProbe.Unprobed) {
      return;
    }
    this.catalogSessionId = sessionId;
    this.catalogProbe = CommandPaletteProbe.Unprobed;
    this.catalogErrorText = '';
    if (force) {
      this.catalog = undefined;
    }
    this.callbacks.onCatalogLoading(sessionId);
    try {
      const catalog = await this.client.skillCatalog({
        sessionId,
        modeId,
        forceRefresh: force
      });
      if (!canApply(sessionId)) {
        return;
      }
      this.catalog = catalog;
      this.catalogProbe = CommandPaletteProbe.Probed;
      this.callbacks.onCatalogReady(sessionId, catalog);
      RemoteLogger.info(
        `command catalog loaded session=${RemoteCommandPaletteController.shortSessionId(sessionId)} ` +
          `mode=${modeId} skills=${catalog.skills.length} refreshed=${force ? '1' : '0'}`);
    } catch (err) {
      if (!canApply(sessionId)) {
        return;
      }
      // A host that does not serve the read is a degraded palette, not a hidden
      // one: the row greys itself and the sheet says why, with a way to re-check.
      this.catalog = undefined;
      this.catalogProbe = CommandPaletteProbe.Failed;
      this.catalogErrorText = ConnectionErrorPolicy.errorText(err);
      RemoteLogger.warn(
        `command catalog failed session=${RemoteCommandPaletteController.shortSessionId(sessionId)}: ${String(err)}`);
      this.callbacks.onCatalogFailed(sessionId, this.catalogErrorText);
    }
  }

  /**
   * Runs one of the two verbs that execute immediately.
   *
   * Single-shot: a second tap while the first is still out is dropped rather
   * than queued, because the host would either refuse it or act on a context the
   * user has not seen the result of yet.
   */
  async runCommand(
    sessionId: string,
    wireAction: string,
    query: RemoteCommandPaletteScope,
    canApply: (sessionId: string) => boolean
  ): Promise<void> {
    if (sessionId.length === 0 || wireAction.length === 0 || this.isRunning() || !canApply(sessionId)) {
      return;
    }
    this.cancelNoticeTimer();
    this.runningAction = wireAction;
    this.callbacks.onCommandStarted(sessionId, wireAction);
    const startedAt = Date.now();
    try {
      const message = wireAction === CommandPalettePolicy.initWireAction ?
        await this.client.runInitAgentsMd(query) :
        await this.client.compactSession(query);
      if (!canApply(sessionId)) {
        this.runningAction = '';
        return;
      }
      this.runningAction = '';
      RemoteLogger.info(
        `command palette accepted session=${RemoteCommandPaletteController.shortSessionId(sessionId)} ` +
          `action=${wireAction} ms=${Date.now() - startedAt}`);
      this.callbacks.onCommandSettled(sessionId, wireAction, '', message);
      this.scheduleNoticeExpiry(sessionId, wireAction);
    } catch (err) {
      this.runningAction = '';
      if (!canApply(sessionId)) {
        return;
      }
      const errorText = ConnectionErrorPolicy.errorText(err);
      RemoteLogger.warn(
        `command palette failed session=${RemoteCommandPaletteController.shortSessionId(sessionId)} ` +
          `action=${wireAction}: ${String(err)}`);
      this.callbacks.onCommandSettled(sessionId, wireAction, errorText, '');
    }
  }

  /**
   * The session usage report, read on every open.
   *
   * Usage is a snapshot by nature, so unlike the catalog it is never served from
   * a cache: the numbers the user asked for are the ones measured when they
   * asked.
   */
  async loadUsageReport(
    sessionId: string,
    query: RemoteCommandPaletteScope,
    canApply: (sessionId: string) => boolean
  ): Promise<void> {
    if (sessionId.length === 0 || !canApply(sessionId)) {
      return;
    }
    this.callbacks.onUsageLoading(sessionId);
    const startedAt = Date.now();
    try {
      const report = await this.client.sessionUsageReport(query);
      if (!canApply(sessionId)) {
        return;
      }
      RemoteLogger.info(
        `session usage report loaded session=${RemoteCommandPaletteController.shortSessionId(sessionId)} ` +
          `present=${report ? '1' : '0'} ms=${Date.now() - startedAt}`);
      this.callbacks.onUsageReady(sessionId, report);
    } catch (err) {
      if (!canApply(sessionId)) {
        return;
      }
      RemoteLogger.warn(
        `session usage report failed session=${RemoteCommandPaletteController.shortSessionId(sessionId)}: ${String(err)}`);
      this.callbacks.onUsageFailed(sessionId, ConnectionErrorPolicy.errorText(err));
    }
  }

  private scheduleNoticeExpiry(sessionId: string, wireAction: string): void {
    const dwell = CommandPalettePolicy.noticeDwellMs(CommandPaletteNoticeKind.Done);
    if (dwell <= 0) {
      return;
    }
    this.cancelNoticeTimer();
    this.noticeTimerId = setTimeout((): void => {
      this.noticeTimerId = -1;
      this.callbacks.onCommandNoticeExpired(sessionId, wireAction);
    }, dwell);
  }

  private cancelNoticeTimer(): void {
    if (this.noticeTimerId !== -1) {
      clearTimeout(this.noticeTimerId);
      this.noticeTimerId = -1;
    }
  }
}
