import { abilityAccessCtrl, common, Context, Permissions } from '@kit.AbilityKit';
import { RemoteI18n } from '../i18n/RemoteI18n';
import { RemoteLogger } from './RemoteLogger';
import { WatchHandoffStore } from './WatchHandoffStore';
import { WatchProvisionCrypto } from './WatchProvisionCrypto';
import {
  WatchProvisionCredential,
  WatchProvisionProtocol,
  WatchProvisionRequest
} from './WatchProvisionProtocol';
import { WatchProvisionDisplay } from './WatchProvisionDisplay';
import { CloudAccountRequestError } from './CloudAccountClient';

const DATASYNC_PERMISSION: Permissions = 'ohos.permission.DISTRIBUTED_DATASYNC';

/**
 * A minting attempt's result, whoever performed it.
 *
 * `relayUrl` travels with the credential rather than being asked for
 * separately, because the two are only valid together: a token minted by this
 * phone's own account authenticates against the account's relay, one minted by
 * a paired desktop against the room's. Reporting them from two places is how
 * they would come to disagree.
 */
export interface WatchProvisionOutcome {
  ok: boolean;
  /** The relay requires the account's normal login path for this device. */
  passwordRequired: boolean;
  relayUrl: string;
  token: string;
  userId: string;
  masterKeyBase64: string;
  deviceId: string;
  failure: string;
  /** True when a desktop answered and refused, so `failure` is worth showing. */
  desktopReported: boolean;
}

/** What the controller needs from the remote stack, kept narrow for testing. */
export interface WatchProvisionPort {
  /** True when some path to a credential exists — account or paired desktop. */
  readonly canProvision: () => boolean;
  readonly provision: (
    deviceId: string,
    deviceName: string,
    requestId: string,
    password: string
  ) => Promise<WatchProvisionOutcome>;
}

/**
 * Phone side of watch onboarding: watch asks, owner confirms here, desktop
 * mints, phone seals the credential to the watch's public key.
 *
 * The confirmation is not a formality. The watch's request travels over a
 * store shared by every install of this app on the account, so the only thing
 * standing between "a device claims to be your watch" and a 30-day account
 * credential is a person looking at this phone. Approval is therefore never
 * implicit and never remembered.
 */
export class WatchProvisionController {
  private readonly state: WatchProvisionDisplay;
  private readonly port: WatchProvisionPort;
  private store?: WatchHandoffStore;
  private starting: boolean = false;
  private started: boolean = false;
  private pending?: WatchProvisionRequest;
  private inFlight: boolean = false;
  /**
   * Requests already answered in this process. The watch clears its own
   * request key once it consumes the response, so this only has to cover the
   * window before that lands — and the TTL covers everything after a restart.
   */
  private readonly answered: Set<string> = new Set<string>();

  constructor(state: WatchProvisionDisplay, port: WatchProvisionPort) {
    this.state = state;
    this.port = port;
  }

  /**
   * Idempotent: called on every page appear, because the permission may have
   * been granted since the last attempt. A denied permission is not an error
   * worth surfacing — the phone simply cannot hear the watch until it is
   * granted, and the watch's own screen says so.
   */
  async start(context: Context): Promise<void> {
    if (this.started || this.starting) {
      return;
    }
    this.starting = true;
    try {
      const atManager = abilityAccessCtrl.createAtManager();
      const result = await atManager.requestPermissionsFromUser(context, [DATASYNC_PERMISSION]);
      if (result.authResults.length === 0 ||
        result.authResults[0] !== abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
        RemoteLogger.info('watch provisioning idle: distributed data sync permission not granted');
        return;
      }
      const store = new WatchHandoffStore(context as common.UIAbilityContext);
      await store.start((payload: string) => {
        this.onRequestPayload(payload);
      });
      this.store = store;
      this.started = true;
      RemoteLogger.info('watch provisioning listener started');
    } catch (err) {
      RemoteLogger.warn(`watch provisioning listener failed to start: ${WatchProvisionController.errorText(err)}`);
      this.store = undefined;
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    if (this.store) {
      this.store.stop();
    }
    this.store = undefined;
    this.started = false;
  }

  /** Visible for tests and for the KV listener; validates before it prompts. */
  onRequestPayload(payload: string): void {
    const request = WatchProvisionProtocol.parseRequest(payload);
    if (!request) {
      // Nothing usable to answer — a malformed request has no request_id to
      // address a response to, so silence is the only available reply.
      RemoteLogger.warn('watch provisioning request ignored: malformed payload');
      return;
    }
    if (this.answered.has(request.requestId)) {
      return;
    }
    if (WatchProvisionProtocol.isExpired(request, Date.now())) {
      RemoteLogger.info('watch provisioning request ignored: expired');
      return;
    }
    if (this.pending && this.pending.requestId === request.requestId) {
      return;
    }
    if (this.inFlight || (this.pending && this.pending.deviceId !== request.deviceId)) {
      // One at a time: a second watch waiting behind a silent card would look
      // identical to a phone that never heard it.
      this.answered.add(request.requestId);
      void this.writeError(request.requestId, RemoteI18n.t('watchProvision.busy'));
      return;
    }
    if (this.pending) {
      // The same watch asking again: it gave up on the last attempt and started
      // over, and the card still up here is for a request nobody is waiting on.
      // Replace it — telling a watch it is busy with itself is the one answer
      // that cannot be true.
      RemoteLogger.info('watch provisioning request replaced by a newer one from the same watch');
      this.answered.add(this.pending.requestId);
    }
    this.pending = request;
    this.state.ask(request.deviceName, request.deviceId);
  }

  async approve(password: string = ''): Promise<void> {
    const request = this.pending;
    if (!request || this.inFlight) {
      return;
    }
    this.inFlight = true;
    this.state.working();
    let settled = false;
    try {
      settled = await this.runProvisioning(request, password);
    } finally {
      if (settled) {
        this.answered.add(request.requestId);
        this.pending = undefined;
      }
      this.inFlight = false;
    }
  }

  async reject(): Promise<void> {
    const request = this.pending;
    if (!request || this.inFlight) {
      return;
    }
    this.answered.add(request.requestId);
    this.pending = undefined;
    this.state.hide();
    await this.writeError(request.requestId, RemoteI18n.t('watchProvision.rejected'));
  }

  /** Closes the card after a finished attempt. Never cancels one in flight. */
  dismiss(): void {
    if (this.inFlight) {
      return;
    }
    if (this.pending) {
      void this.reject();
      return;
    }
    this.state.hide();
  }

  private async runProvisioning(request: WatchProvisionRequest, password: string): Promise<boolean> {
    if (WatchProvisionProtocol.isExpired(request, Date.now())) {
      await this.failAttempt(request.requestId, RemoteI18n.t('watchProvision.errors.requestExpired'));
      return true;
    }
    if (!this.port.canProvision()) {
      await this.failAttempt(request.requestId, RemoteI18n.t('watchProvision.errors.noDesktop'));
      return true;
    }
    let outcome: WatchProvisionOutcome;
    try {
      outcome = await this.port.provision(request.deviceId, request.deviceName, request.requestId, password);
    } catch (err) {
      RemoteLogger.error(`watch provisioning failed: ${WatchProvisionController.errorText(err)}`);
      if (err instanceof CloudAccountRequestError && err.statusCode === 409) {
        await this.failAttempt(request.requestId, RemoteI18n.t('watchProvision.errors.alreadyRegistered'));
        return true;
      }
      if (password.length > 0) {
        this.state.requirePassword(RemoteI18n.t('watchProvision.errors.passwordFailed'));
        return false;
      }
      await this.failAttempt(request.requestId, RemoteI18n.t('watchProvision.errors.accountUnavailable'));
      return true;
    }
    if (outcome.passwordRequired) {
      this.state.requirePassword('');
      return false;
    }
    if (!outcome.ok) {
      // A desktop that answered and refused knows why; a desktop that never
      // answered is either offline or on a build that does not know this
      // command, and the copy has to cover both because they look the same.
      const message = outcome.desktopReported ?
        RemoteI18n.t('watchProvision.errors.desktopAuthorizationFailed') :
        RemoteI18n.t('watchProvision.errors.desktopUnreachable');
      await this.failAttempt(request.requestId, message);
      return true;
    }

    if (outcome.relayUrl.trim().length === 0) {
      // A credential with no relay to present it at is unusable, and the watch
      // would only discover that after signing in. Stop here instead.
      RemoteLogger.error('watch provisioning produced a credential without a relay url');
      await this.failAttempt(request.requestId, RemoteI18n.t('watchProvision.errors.handoffFailed'));
      return true;
    }
    const credential: WatchProvisionCredential = {
      relay_url: outcome.relayUrl,
      token: outcome.token,
      user_id: outcome.userId,
      master_key: outcome.masterKeyBase64,
      device_id: outcome.deviceId
    };
    try {
      // Fresh key pair per attempt: a credential written to the shared store
      // stays unreadable to anything but the watch that asked for it.
      const crypto = new WatchProvisionCrypto();
      const sealed = await crypto.seal(request.publicKeyBase64, JSON.stringify(credential));
      await this.requireStore().writeResponse(WatchProvisionProtocol.successResponse(
        request.requestId,
        crypto.publicKeyBase64(),
        sealed.encryptedData,
        sealed.nonce
      ));
    } catch (err) {
      // The device is registered on the account either way — the relay call
      // already succeeded — so say so rather than implying nothing happened.
      RemoteLogger.error(`watch provisioning handoff failed: ${WatchProvisionController.errorText(err)}`);
      await this.failAttempt(request.requestId, RemoteI18n.t('watchProvision.errors.handoffFailed'));
      return true;
    }
    RemoteLogger.info('watch provisioning credential handed off');
    this.state.done(RemoteI18n.f('watchProvision.doneBody', request.deviceName));
    return true;
  }

  private async failAttempt(requestId: string, message: string): Promise<void> {
    this.state.fail(message);
    await this.writeError(requestId, message);
  }

  private async writeError(requestId: string, message: string): Promise<void> {
    if (!this.store) {
      return;
    }
    try {
      await this.store.writeResponse(WatchProvisionProtocol.errorResponse(requestId, message));
    } catch (err) {
      // The watch falls back to its own timeout copy when no response lands.
      RemoteLogger.warn(`watch provisioning error reply failed: ${WatchProvisionController.errorText(err)}`);
    }
  }

  private requireStore(): WatchHandoffStore {
    if (!this.store) {
      throw new Error('Watch handoff store is not available.');
    }
    return this.store;
  }

  private static errorText(err: Object): string {
    return err instanceof Error ? err.message : JSON.stringify(err);
  }
}
