import { RemoteDefaultModels, RemoteModelCatalog } from '../model/RemoteModels';
import { RemoteI18n } from '../i18n/RemoteI18n';
import { RemoteUiState } from './RemoteUiState';

/**
 * The three model slots a phone may write on the controlled desktop.
 *
 * `null` is a value: the fast model then follows the primary model, and the
 * other two are left unconfigured. The slots the phone does not manage
 * (`search`, `image_generation`, `speech_recognition`) are never sent.
 */
export interface RemoteModelDefaultsRoles {
  primary: string | null;
  fast: string | null;
  image_understanding: string | null;
}

/** Roles the sheet can edit, in sheet order. */
export type RemoteModelDefaultsRole = 'primary' | 'fast' | 'image_understanding';

/**
 * Device-level model client.
 *
 * `getModelCatalog()` is called without a session id on purpose: the defaults
 * belong to the desktop, not to whichever session happens to be open.
 */
export interface RemoteModelDefaultsClient {
  getModelCatalog(sessionId?: string): Promise<RemoteModelCatalog>;
  setModelDefaults(
    primary: string | null,
    fast: string | null,
    imageUnderstanding: string | null
  ): Promise<RemoteDefaultModels>;
}

/** Which operation failed, so a retry can offer the matching one. */
export type RemoteModelDefaultsFailure = '' | 'load' | 'write';

/**
 * Everything that has to hold before the device page is answerable: the host
 * advertises `device_model_defaults_v1`, the link is up, and the desktop it
 * points at is the one the values belong to.
 */
export interface RemoteModelDefaultsGate {
  supported: boolean;
  connected: boolean;
  deviceId: string;
}

/** Everything the device model settings pages render. */
export interface RemoteModelDefaultsState {
  /** The gate allows a read and a write. */
  available: boolean;
  /** A device catalog read is in flight. */
  loading: boolean;
  /** A write is in flight; the sheet is locked while it is true. */
  busy: boolean;
  /** Device catalog: models with their `capabilities`, in host order. */
  catalog: RemoteModelCatalog;
  /** Current values. Only ever replaced by a read, never by a write's intent. */
  roles: RemoteModelDefaultsRoles;
  /** Raw failure text; empty when the last operation succeeded. */
  error: string;
  /** Which operation produced `error`. */
  failure: RemoteModelDefaultsFailure;
  /** Transient i18n status line: reading, saving, updated. */
  statusText: string;
  /** True once a read has applied values for the current gate. */
  loaded: boolean;
}

export interface RemoteModelDefaultsCallbacks {
  onStateChanged: (state: RemoteModelDefaultsState) => void;
}

/**
 * Device model role defaults for the connected desktop.
 *
 * Reads and writes go to the desktop's own catalog, so this controller never
 * guesses: a write is followed by an explicit re-read and the values on screen
 * change only when that read returns. The host repairs an impossible selection
 * while persisting it, and showing the intent instead of the result would
 * report a configuration that was never stored.
 */
export class RemoteModelDefaultsController {
  /** The reason an older desktop cannot serve the device model settings page. */
  private static readonly UNSUPPORTED_REASON_KEY: string = 'settings.model.unsupported';

  private readonly client: RemoteModelDefaultsClient;
  private readonly callbacks: RemoteModelDefaultsCallbacks;
  private state: RemoteModelDefaultsState = RemoteModelDefaultsController.unavailableState();
  private gate: RemoteModelDefaultsGate = RemoteModelDefaultsController.closedGate();
  /**
   * Bumped when the gate changes or the controller is reset. A result that
   * lands after that belongs to a desktop the sheet no longer shows.
   */
  private generation: number = 0;

  constructor(client: RemoteModelDefaultsClient, callbacks: RemoteModelDefaultsCallbacks) {
    this.client = client;
    this.callbacks = callbacks;
  }

  getState(): RemoteModelDefaultsState {
    return this.state;
  }

  /**
   * Re-gates the page. Any change of capability, link or desktop drops what is
   * on screen (values from one desktop must never render against another) and
   * returns true, so the caller knows it has to read again.
   */
  setGate(gate: RemoteModelDefaultsGate): boolean {
    if (RemoteModelDefaultsController.sameGate(this.gate, gate)) {
      return false;
    }
    this.generation += 1;
    this.gate = gate;
    const available = gate.supported && gate.connected;
    const next: RemoteModelDefaultsState = RemoteModelDefaultsController.unavailableState();
    next.available = available;
    if (available) {
      next.statusText = RemoteI18n.t('status.loadingModelDefaults');
    } else {
      next.error = gate.supported ?
        RemoteI18n.t('status.remoteUnavailable') :
        RemoteI18n.t(RemoteModelDefaultsController.UNSUPPORTED_REASON_KEY);
    }
    this.publish(next);
    return true;
  }

  /**
   * Reads the desktop catalog and the defaults that belong to it.
   *
   * Skips while a read or a write is already running so opening the page during
   * a reconnect cannot queue a second read behind the first.
   */
  async load(): Promise<void> {
    if (!this.state.available || this.state.loading || this.state.busy) {
      return;
    }
    const generation = this.generation;
    this.publish(RemoteModelDefaultsController.workingState(this.state, true, false,
      RemoteI18n.t('status.loadingModelDefaults')));
    try {
      const catalog = await this.readCatalog(generation);
      if (!catalog) {
        return;
      }
      this.publish(RemoteModelDefaultsController.readState(this.state, catalog));
    } catch (err) {
      if (!this.isCurrent(generation)) {
        return;
      }
      this.publish(RemoteModelDefaultsController.failedState(this.state, err, 'load',
        RemoteI18n.t('status.modelDefaultsLoadFailed')));
    }
  }

  /**
   * Writes one role by sending the whole object, then reads the result back.
   *
   * The verb replaces all three slots, so the other two come from a fresh read:
   * the snapshot from when this page opened could revert a newer desktop save.
   *
   * Selecting the value a role already has writes nothing: the host reconciles
   * on every write, and there is no intent to persist.
   */
  async applyRoleSelection(role: RemoteModelDefaultsRole, modelId: string | null): Promise<void> {
    if (!this.state.available || this.state.busy || this.state.loading) {
      return;
    }
    if (RemoteModelDefaultsController.sameRoles(
      RemoteModelDefaultsController.rolesWithSelection(this.state.roles, role, modelId), this.state.roles)) {
      return;
    }
    const generation = this.generation;
    this.publish(RemoteModelDefaultsController.workingState(this.state, false, true,
      RemoteI18n.t('status.updatingModelDefaults')));
    try {
      const latest = await this.readCatalog(generation);
      if (!latest) {
        return;
      }
      const currentRoles = RemoteModelDefaultsController.rolesFromDefaults(latest.default_models);
      const nextRoles = RemoteModelDefaultsController.rolesWithSelection(currentRoles, role, modelId);
      if (RemoteModelDefaultsController.sameRoles(nextRoles, currentRoles)) {
        const unchanged = RemoteModelDefaultsController.readState(this.state, latest);
        unchanged.busy = true;
        this.publish(unchanged);
        return;
      }
      await this.client.setModelDefaults(
        nextRoles.primary,
        nextRoles.fast,
        nextRoles.image_understanding
      );
      if (!this.isCurrent(generation)) {
        return;
      }
      // The acknowledgement says what was written, not what is now stored: the
      // desktop may have repaired the selection, so the read decides.
      try {
        const catalog = await this.readCatalog(generation);
        if (!catalog) {
          return;
        }
        const readState = RemoteModelDefaultsController.readState(this.state, catalog);
        readState.busy = true;
        readState.statusText = RemoteI18n.t('status.modelDefaultsUpdated');
        this.publish(readState);
      } catch (err) {
        if (!this.isCurrent(generation)) {
          return;
        }
        const failed = RemoteModelDefaultsController.failedState(this.state, err, 'load',
          RemoteI18n.t('status.modelDefaultsLoadFailed'));
        failed.busy = true;
        this.publish(failed);
      }
    } catch (err) {
      if (!this.isCurrent(generation)) {
        return;
      }
      this.publish(RemoteModelDefaultsController.failedState(this.state, err, 'write',
        RemoteI18n.t('status.modelDefaultsUpdateFailed')));
    } finally {
      if (this.isCurrent(generation)) {
        const done = RemoteModelDefaultsController.copyState(this.state);
        done.busy = false;
        this.publish(done);
      }
    }
  }

  /** Clears the page while it is closed. */
  reset(): void {
    this.generation += 1;
    this.gate = RemoteModelDefaultsController.closedGate();
    this.publish(RemoteModelDefaultsController.unavailableState());
  }

  /** The i18n key of the reason an old desktop cannot serve this page. */
  static unsupportedReasonKey(): string {
    return RemoteModelDefaultsController.UNSUPPORTED_REASON_KEY;
  }

  /** The values for one role, mapped from the wire shape (`undefined` = null). */
  static rolesFromDefaults(defaults: RemoteDefaultModels): RemoteModelDefaultsRoles {
    return {
      primary: RemoteModelDefaultsController.slotValue(defaults.primary),
      fast: RemoteModelDefaultsController.slotValue(defaults.fast),
      image_understanding: RemoteModelDefaultsController.slotValue(defaults.image_understanding)
    };
  }

  private async readCatalog(generation: number): Promise<RemoteModelCatalog | undefined> {
    const catalog = await this.client.getModelCatalog();
    return this.isCurrent(generation) ? catalog : undefined;
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  private publish(state: RemoteModelDefaultsState): void {
    this.state = state;
    this.callbacks.onStateChanged(state);
  }

  private static slotValue(value: string | null | undefined): string | null {
    return value === undefined || value === null || value.length === 0 ? null : value;
  }

  private static rolesWithSelection(
    roles: RemoteModelDefaultsRoles,
    role: RemoteModelDefaultsRole,
    modelId: string | null
  ): RemoteModelDefaultsRoles {
    if (role === 'primary') {
      return { primary: modelId, fast: roles.fast, image_understanding: roles.image_understanding };
    }
    if (role === 'fast') {
      return { primary: roles.primary, fast: modelId, image_understanding: roles.image_understanding };
    }
    if (role === 'image_understanding') {
      return { primary: roles.primary, fast: roles.fast, image_understanding: modelId };
    }
    return RemoteModelDefaultsController.copyRoles(roles);
  }

  private static sameRoles(first: RemoteModelDefaultsRoles, second: RemoteModelDefaultsRoles): boolean {
    return first.primary === second.primary &&
      first.fast === second.fast &&
      first.image_understanding === second.image_understanding;
  }

  private static sameGate(first: RemoteModelDefaultsGate, second: RemoteModelDefaultsGate): boolean {
    return first.supported === second.supported &&
      first.connected === second.connected &&
      first.deviceId === second.deviceId;
  }

  private static copyRoles(roles: RemoteModelDefaultsRoles): RemoteModelDefaultsRoles {
    return {
      primary: roles.primary,
      fast: roles.fast,
      image_understanding: roles.image_understanding
    };
  }

  private static copyState(state: RemoteModelDefaultsState): RemoteModelDefaultsState {
    return {
      available: state.available,
      loading: state.loading,
      busy: state.busy,
      catalog: state.catalog,
      roles: RemoteModelDefaultsController.copyRoles(state.roles),
      error: state.error,
      failure: state.failure,
      statusText: state.statusText,
      loaded: state.loaded
    };
  }

  private static workingState(
    state: RemoteModelDefaultsState,
    loading: boolean,
    busy: boolean,
    statusText: string
  ): RemoteModelDefaultsState {
    const next = RemoteModelDefaultsController.copyState(state);
    next.loading = loading;
    next.busy = busy;
    next.error = '';
    next.failure = '';
    next.statusText = statusText;
    return next;
  }

  /** Applies a read: the only path that may change the values on screen. */
  private static readState(state: RemoteModelDefaultsState, catalog: RemoteModelCatalog): RemoteModelDefaultsState {
    const next = RemoteModelDefaultsController.copyState(state);
    next.catalog = catalog;
    next.roles = RemoteModelDefaultsController.rolesFromDefaults(catalog.default_models || {});
    next.loading = false;
    next.error = '';
    next.failure = '';
    next.statusText = '';
    next.loaded = true;
    return next;
  }

  private static failedState(
    state: RemoteModelDefaultsState,
    err: Object,
    failure: RemoteModelDefaultsFailure,
    fallbackText: string
  ): RemoteModelDefaultsState {
    const next = RemoteModelDefaultsController.copyState(state);
    // The host's own rejection (an unknown model id, for example) is kept as it
    // arrived: replacing it with a generic line would hide what to fix.
    next.error = err instanceof Error && err.message.length > 0 ? err.message : fallbackText;
    next.failure = failure;
    next.loading = false;
    next.statusText = '';
    return next;
  }

  private static unavailableState(): RemoteModelDefaultsState {
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

  private static closedGate(): RemoteModelDefaultsGate {
    return { supported: false, connected: false, deviceId: '' };
  }
}
