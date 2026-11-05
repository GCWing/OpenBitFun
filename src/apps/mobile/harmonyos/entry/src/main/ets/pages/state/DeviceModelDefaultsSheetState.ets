import { RemoteDefaultModels, RemoteModelCatalog } from '../../model/RemoteModels';
import { RemoteUiState } from '../../services/RemoteUiState';
import {
  RemoteModelDefaultsClient,
  RemoteModelDefaultsController,
  RemoteModelDefaultsGate,
  RemoteModelDefaultsRole,
  RemoteModelDefaultsState
} from '../../services/RemoteModelDefaultsController';
import { ModelRoleCandidatesPolicy } from '../policy/ModelRoleCandidatesPolicy';

/** How long the confirmed-write line stays on screen. */
export const MODEL_DEFAULTS_FEEDBACK_MS: number = 2000;

/**
 * The state a page shows before anything has been read or bound.
 *
 * It is the same shape `RemoteModelDefaultsController` publishes for a closed
 * gate, so a page mounted before its client is bound renders an empty page
 * instead of nothing at all. The controller's own snapshot is what a page
 * normally sees; `model-role-pages.test.cjs` pins the two together so this copy
 * cannot drift away from it.
 */
export function emptyModelDefaultsState(): RemoteModelDefaultsState {
  return {
    available: false,
    loading: false,
    busy: false,
    catalog: RemoteUiState.emptyModelCatalog(),
    roles: { primary: null, fast: null, image_understanding: null },
    error: '',
    failure: '',
    statusText: '',
    loaded: false
  };
}

/**
 * The request path the sheet hands to the pages: the same two calls
 * `RemoteModelDefaultsClient` describes, declared as properties.
 *
 * ArkTS only accepts an object literal against a type whose members are
 * properties, and the sheet binds its two request events as a literal, because
 * the desktop they go to is chosen by the sheet and not by either page. The
 * shape is the same one the controller calls, so this is a spelling of that
 * interface rather than a second protocol.
 */
export interface DeviceModelDefaultsRequestPath {
  getModelCatalog: (sessionId?: string) => Promise<RemoteModelCatalog>;
  setModelDefaults: (
    primary: string | null,
    fast: string | null,
    imageUnderstanding: string | null
  ) => Promise<RemoteDefaultModels>;
}

/**
 * Device model role defaults for the connected desktop, owned by the settings
 * sheet.
 *
 * The sheet's two model pages (`deviceModels` and the `modelPick` level above
 * it) are one workflow over one controller: the picker writes, the settings page
 * shows the read-back, and swapping between them must not re-read the device or
 * lose a write in flight. So the controller lives here, on the sheet state the
 * two pages are both handed, rather than inside either page.
 *
 * It is also the client the controller calls: `bind` decides which desktop the
 * pages are talking to, and the sheet rebinds the same object when it opens on
 * another one. Everything else — gating, the write, the read-back, the stale
 * result fence — belongs to the controller.
 */
@ObservedV2
export class DeviceModelDefaultsSheetState implements RemoteModelDefaultsClient {
  /** The controller's latest snapshot; the only thing the pages render. */
  @Trace state: RemoteModelDefaultsState = emptyModelDefaultsState();
  /** The role a write is running for, or the one that just failed. */
  @Trace pendingRole: RemoteModelDefaultsRole | '' = '';
  /** The value that write carries; `null` is a value, not an absence. */
  @Trace pendingModelId: string | null = null;
  /** True while a confirmed write's result line is on screen. */
  @Trace feedbackVisible: boolean = false;

  private readonly feedbackDurationMs: number;
  private readonly controller: RemoteModelDefaultsController;
  private target?: DeviceModelDefaultsRequestPath;
  private feedbackTimer: number = 0;

  constructor(feedbackDurationMs: number = MODEL_DEFAULTS_FEEDBACK_MS) {
    this.feedbackDurationMs = feedbackDurationMs;
    this.controller = new RemoteModelDefaultsController(this, {
      onStateChanged: (state: RemoteModelDefaultsState): void => {
        this.state = state;
      }
    });
    this.state = this.controller.getState();
  }

  /** Points the pages at one desktop's request path. */
  bind(target: DeviceModelDefaultsRequestPath): void {
    this.target = target;
  }

  /** Re-gates the pages; true when what is on screen has to be read again. */
  setGate(gate: RemoteModelDefaultsGate): boolean {
    return this.controller.setGate(gate);
  }

  /** Reads once per gate: a page that opens twice does not read twice. */
  async ensureLoaded(): Promise<void> {
    if (this.state.loaded || this.state.loading) {
      return;
    }
    await this.controller.load();
  }

  async load(): Promise<void> {
    await this.controller.load();
  }

  /**
   * Sets one role and waits for the controller's read-back.
   *
   * The feedback line is raised only after that read returns, and only when a
   * write really happened: selecting the value a role already holds writes
   * nothing, and an unavailable gate writes nothing either, so neither may claim
   * the device was updated. What the line says is derived from the read-back
   * value at render time — the desktop may have repaired the selection, and the
   * intent is not the result.
   */
  async selectRole(role: RemoteModelDefaultsRole, modelId: string | null): Promise<void> {
    // One write at a time, and none while the read that answers the page is still
    // out: either one would leave the intent recorded here describing a value no
    // request ever carried.
    if (this.state.busy || this.state.loading) {
      return;
    }
    const requested = modelId === null ? '' : modelId;
    const current = ModelRoleCandidatesPolicy.selectedValue(this.state.roles, role);
    this.pendingRole = role;
    this.pendingModelId = modelId;
    this.clearFeedback();
    if (current === requested) {
      return;
    }
    await this.controller.applyRoleSelection(role, modelId);
    if (this.state.available && this.state.error.length === 0) {
      this.showFeedback();
    }
  }

  /**
   * Repeats whatever failed: the write that was rejected, or the read that failed
   * after an accepted write. The failure the controller reported decides which,
   * because a retry of the wrong one would ask the user to re-answer a question
   * they already answered.
   */
  async retry(): Promise<void> {
    const role = this.pendingRole;
    if (this.state.failure === 'write' && role !== '') {
      const modelId = this.pendingModelId;
      await this.controller.applyRoleSelection(role, modelId);
      if (this.state.available && this.state.error.length === 0) {
        this.showFeedback();
      }
      return;
    }
    this.clearFeedback();
    await this.controller.load();
  }

  /** Clears the pages while the sheet is closed. */
  reset(): void {
    this.clearFeedback();
    this.pendingRole = '';
    this.pendingModelId = null;
    this.controller.reset();
  }

  getModelCatalog(sessionId?: string): Promise<RemoteModelCatalog> {
    const target = this.target;
    if (!target) {
      return Promise.reject(new Error('The device model pages have no client bound.'));
    }
    return target.getModelCatalog(sessionId);
  }

  setModelDefaults(
    primary: string | null,
    fast: string | null,
    imageUnderstanding: string | null
  ): Promise<RemoteDefaultModels> {
    const target = this.target;
    if (!target) {
      return Promise.reject(new Error('The device model pages have no client bound.'));
    }
    return target.setModelDefaults(primary, fast, imageUnderstanding);
  }

  private showFeedback(): void {
    this.feedbackVisible = true;
    this.cancelTimer();
    this.feedbackTimer = setTimeout(() => {
      this.feedbackTimer = 0;
      this.feedbackVisible = false;
    }, this.feedbackDurationMs);
  }

  private clearFeedback(): void {
    this.cancelTimer();
    this.feedbackVisible = false;
  }

  private cancelTimer(): void {
    if (this.feedbackTimer !== 0) {
      clearTimeout(this.feedbackTimer);
      this.feedbackTimer = 0;
    }
  }
}
