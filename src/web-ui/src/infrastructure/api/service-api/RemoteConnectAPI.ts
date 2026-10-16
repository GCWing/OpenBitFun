/**
 * Remote Connect API — calls Tauri commands for remote connection management.
 */

import { getTransportAdapter } from '../adapters';
import { api } from './ApiClient';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('RemoteConnectAPI');

export interface DeviceDirectoryMetadata {
  device_alias?: string | null;
  device_model?: string | null;
  device_os?: string | null;
  device_os_version?: string | null;
  /**
   * Kind the device reported to the Relay (`desktop`, `cli`, `mobile`,
   * `watch`). Absent for a device that never reported one and for older Relays;
   * absent means unknown, which is not the same as "not a host".
   */
  device_kind?: string | null;
  /**
   * Client build the device reported to the Relay. The host projection emits
   * `device_client_version`; the Relay's own snake_case spelling is
   * `client_version`. Both are read, exactly like the Relay/backend tolerance,
   * so an older or newer host projection is never misjudged. Absent on older
   * Relays.
   */
  device_client_version?: string | null;
  client_version?: string | null;
  /**
   * Client wire protocol the device reported, using the same two spellings as
   * the build string. Absent on older Relays.
   */
  device_client_protocol?: number | null;
  client_protocol?: number | null;
  /**
   * Relay-computed mutual-control compatibility of this device with this one.
   *
   * `false` means confirmed incompatible: either a client build/protocol
   * mismatch or a peer that reported no version information (an older client).
   * Absent only on an older Relay that does not gate at all, which must be
   * treated as "unknown but usable", never as incompatible.
   */
  compatible?: boolean;
}

export function deviceDisplayName(device: DeviceDirectoryMetadata & { device_id: string; device_name?: string | null }): string {
  return device.device_alias ?? device.device_name ?? device.device_id;
}

export function deviceMetadataLabel(device: DeviceDirectoryMetadata): string {
  return [device.device_model, [device.device_os, device.device_os_version].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
}

export interface DeviceInfo extends DeviceDirectoryMetadata {
  device_id: string;
  device_name: string;
  mac_address: string;
}

export interface ConnectionMethodInfo {
  id: string;
  name: string;
  available: boolean;
  description: string;
}

export type RemotePairingState =
  | 'idle'
  | 'waiting_for_scan'
  | 'handshaking'
  | 'verifying'
  | 'connected'
  | 'disconnected'
  | { failed: { reason: string } };

export function remotePairingStateName(
  state: RemotePairingState | null | undefined,
): Exclude<RemotePairingState, { failed: { reason: string } }> | 'failed' {
  if (state === null || state === undefined) return 'idle';
  return typeof state === 'string' ? state : 'failed';
}

export function remotePairingFailureReason(
  state: RemotePairingState | null | undefined,
): string | null {
  return typeof state === 'object' && state !== null
    ? state.failed.reason
    : null;
}

export type RemoteConnectionMethod =
  | 'openbitfun_server' | 'bot_feishu' | 'bot_telegram' | 'bot_weixin'
  | { lan: { ip: string | null } };

export interface ConnectionResult {
  method: RemoteConnectionMethod;
  qr_data: string | null;
  qr_svg: string | null;
  qr_url: string | null;
  bot_pairing_code: string | null;
  bot_link: string | null;
  pairing_state: RemotePairingState;
}

export interface RemoteConnectStatus {
  /** Present only when the host supports independently managed Relay routes. */
  connections?: Array<{
    method: 'lan' | 'openbitfun_server';
    relay_connected: boolean;
    relay_url: string | null;
    clients: Array<{ id: string; name: string }>;
  }>;
  relay_connected: boolean;
  relay_url: string | null;
  active_method: RemoteConnectionMethod | null;
  clients: Array<{ id: string; name: string }>;
  bot_connected: string | null;
  bot_verbose_mode: boolean;
}

export interface LanNetworkInterface {
  interface_name: string;
  ip: string;
  gateway_ip: string | null;
}

export interface LanNetworkInfo {
  local_ip: string;
  gateway_ip: string | null;
  available_ips: LanNetworkInterface[];
}

export interface RemoteConnectFormState {
  telegram_bot_token: string;
  feishu_app_id: string;
  feishu_app_secret: string;
  weixin_ilink_token?: string;
  weixin_base_url?: string;
  weixin_bot_account_id?: string;
}

export interface WeixinQrStartResponse {
  session_key: string;
  qr_image_url: string;
  message: string;
}

export type WeixinQrPollStatus =
  | 'wait'
  | 'scanned'
  | 'need_verify_code'
  | 'confirmed'
  | 'expired'
  | 'error';

export interface WeixinQrPollResponse {
  status: WeixinQrPollStatus;
  message: string;
  qr_image_url: string | null;
  ilink_token: string | null;
  bot_account_id: string | null;
  base_url: string | null;
}

export interface AccountLoginResult {
  user_id: string;
}

export interface AccountHint {
  username: string;
  relay_url: string;
}

export interface AccountStatus {
  logged_in: boolean;
  user_id: string | null;
}

export interface OnlineDeviceInfo extends DeviceDirectoryMetadata {
  device_id: string;
  device_name: string;
}

export interface AccountDeviceInfo extends DeviceDirectoryMetadata {
  device_id: string;
  device_name: string;
  online: boolean;
  last_seen_at: number | null;
}

class RemoteConnectAPIService {
  private get adapter() {
    return getTransportAdapter();
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    try {
      return await this.adapter.request<DeviceInfo>('remote_connect_get_device_info');
    } catch (e) {
      log.error('getDeviceInfo failed', e);
      throw e;
    }
  }

  async getLanIp(): Promise<string | null> {
    try {
      return await this.adapter.request<string>('remote_connect_get_lan_ip');
    } catch (e) {
      log.warn('getLanIp failed', e);
      return null;
    }
  }

  async getLanNetworkInfo(): Promise<LanNetworkInfo | null> {
    try {
      return await this.adapter.request<LanNetworkInfo>('remote_connect_get_lan_network_info');
    } catch (e) {
      log.warn('getLanNetworkInfo failed', e);
      return null;
    }
  }

  async getConnectionMethods(): Promise<ConnectionMethodInfo[]> {
    try {
      return await this.adapter.request<ConnectionMethodInfo[]>('remote_connect_get_methods');
    } catch (e) {
      log.error('getConnectionMethods failed', e);
      throw e;
    }
  }

  async startConnection(method: string, lanIp?: string): Promise<ConnectionResult> {
    try {
      return await this.adapter.request<ConnectionResult>('remote_connect_start', {
        request: { method, lan_ip: lanIp ?? null },
      });
    } catch (e) {
      log.error('startConnection failed', e);
      throw e;
    }
  }

  async stopConnection(method?: 'lan' | 'openbitfun_server'): Promise<void> {
    try {
      await this.adapter.request<void>('remote_connect_stop', method ? { request: { method } } : undefined);
    } catch (e) {
      log.error('stopConnection failed', e);
      throw e;
    }
  }

  async getStatus(): Promise<RemoteConnectStatus> {
    try {
      return await this.adapter.request<RemoteConnectStatus>('remote_connect_status');
    } catch (e) {
      log.error('getStatus failed', e);
      throw e;
    }
  }

  async getFormState(): Promise<RemoteConnectFormState> {
    try {
      return await this.adapter.request<RemoteConnectFormState>('remote_connect_get_form_state');
    } catch (e) {
      log.error('getFormState failed', e);
      throw e;
    }
  }

  async setFormState(formState: RemoteConnectFormState): Promise<void> {
    try {
      await this.adapter.request<void>('remote_connect_set_form_state', { request: formState });
    } catch (e) {
      log.error('setFormState failed', e);
      throw e;
    }
  }

  async stopBot(): Promise<void> {
    try {
      await this.adapter.request<void>('remote_connect_stop_bot');
    } catch (e) {
      log.error('stopBot failed', e);
      throw e;
    }
  }

  async configureBot(params: {
    botType: string;
    appId?: string;
    appSecret?: string;
    botToken?: string;
    weixinIlinkToken?: string;
    weixinBaseUrl?: string;
    weixinBotAccountId?: string;
  }): Promise<void> {
    try {
      await this.adapter.request<void>('remote_connect_configure_bot', {
        request: {
          bot_type: params.botType,
          app_id: params.appId ?? null,
          app_secret: params.appSecret ?? null,
          bot_token: params.botToken ?? null,
          weixin_ilink_token: params.weixinIlinkToken ?? null,
          weixin_base_url: params.weixinBaseUrl ?? null,
          weixin_bot_account_id: params.weixinBotAccountId ?? null,
        },
      });
    } catch (e) {
      log.error('configureBot failed', e);
      throw e;
    }
  }

  async weixinQrStart(
    baseUrl?: string | null,
    existingIlinkToken?: string | null,
    existingBotAccountId?: string | null,
  ): Promise<WeixinQrStartResponse> {
    return await this.adapter.request<WeixinQrStartResponse>('remote_connect_weixin_qr_start', {
      request: {
        base_url: baseUrl ?? null,
        existing_ilink_token: existingIlinkToken ?? null,
        existing_bot_account_id: existingBotAccountId ?? null,
      },
    });
  }

  async weixinQrPoll(
    sessionKey: string,
    baseUrl?: string | null,
    verifyCode?: string | null,
  ): Promise<WeixinQrPollResponse> {
    return await this.adapter.request<WeixinQrPollResponse>('remote_connect_weixin_qr_poll', {
      request: {
        session_key: sessionKey,
        base_url: baseUrl ?? null,
        verify_code: verifyCode ?? null,
      },
    });
  }

  async getBotVerboseMode(): Promise<boolean> {
    try {
      return await this.adapter.request<boolean>('remote_connect_get_bot_verbose_mode');
    } catch (e) {
      log.error('getBotVerboseMode failed', e);
      return false;
    }
  }

  async setBotVerboseMode(verbose: boolean): Promise<void> {
    try {
      await this.adapter.request<void>('remote_connect_set_bot_verbose_mode', { verbose });
    } catch (e) {
      log.error('setBotVerboseMode failed', e);
      throw e;
    }
  }

  async accountLogin(): Promise<AccountLoginResult> {
    try {
      return await this.adapter.request<AccountLoginResult>('account_login', {
        request: {},
      });
    } catch (e) {
      log.error('accountLogin failed', e);
      throw e;
    }
  }

  async accountStatus(): Promise<AccountStatus> {
    try {
      return await this.adapter.request<AccountStatus>('account_status');
    } catch (e) {
      log.warn('accountStatus failed', e);
      // A transport failure says nothing about authentication state. Keep it
      // observable so callers can preserve their last confirmed account owner
      // instead of turning a transient IPC failure into a synthetic logout.
      throw e;
    }
  }

  async accountGetCredentialHint(): Promise<AccountHint | null> {
    try {
      return await this.adapter.request<AccountHint | null>('account_get_credential_hint');
    } catch (e) {
      log.warn('accountGetCredentialHint failed', e);
      return null;
    }
  }

  async accountTokenExpired(): Promise<boolean> {
    try {
      return await this.adapter.request<boolean>('account_token_expired');
    } catch (e) {
      log.warn('accountTokenExpired failed', e);
      return false;
    }
  }

  async accountLogout(): Promise<void> {
    try {
      await this.adapter.request<void>('account_logout');
    } catch (e) {
      log.error('accountLogout failed', e);
      throw e;
    }
  }

  // ── P2: Device routing ──────────────────────────────────────────────────

  async accountConnectDevices(): Promise<OnlineDeviceInfo[]> {
    try {
      return await this.adapter.request<OnlineDeviceInfo[]>('account_connect_devices');
    } catch (e) {
      log.error('accountConnectDevices failed', e);
      throw e;
    }
  }

  async accountOnlineDevices(): Promise<OnlineDeviceInfo[]> {
    try {
      return await this.adapter.request<OnlineDeviceInfo[]>('account_online_devices');
    } catch (e) {
      log.warn('accountOnlineDevices failed', e);
      return [];
    }
  }


  async accountExecuteOnDevice(
    targetDeviceId: string,
    content: string,
    sessionId?: string,
    agentType?: string,
    workspacePath?: string,
  ): Promise<void> {
    try {
      await this.adapter.request<void>('account_execute_on_device', {
        targetDeviceId,
        sessionId: sessionId ?? null,
        content,
        agentType: agentType ?? null,
        workspacePath: workspacePath ?? null,
      });
    } catch (e) {
      log.error('accountExecuteOnDevice failed', e);
      throw e;
    }
  }

  async accountListDevices(): Promise<AccountDeviceInfo[]> {
    try {
      return await this.adapter.request<AccountDeviceInfo[]>('account_list_devices');
    } catch (e) {
      log.error('accountListDevices failed', e);
      throw e;
    }
  }

  async accountRelayCapabilities(): Promise<string[]> {
    return this.adapter.request<string[]>('account_relay_capabilities');
  }

  async accountUpdateDevice(deviceId: string, deviceAlias: string | null): Promise<void> {
    try {
      await this.adapter.request<void>('account_update_device_alias', {
        request: { device_id: deviceId, device_alias: deviceAlias },
      });
    } catch (e) {
      log.error('accountUpdateDevice failed', e);
      throw e;
    }
  }

  async accountDeleteDevice(targetDeviceId: string): Promise<void> {
    try {
      await this.adapter.request<void>('account_delete_device', { targetDeviceId });
    } catch (e) {
      log.error('accountDeleteDevice failed', e);
      throw e;
    }
  }

  onSessionGap(callback: (event: { sessionId: string; reason: string }) => void): () => void {
    return api.listen('relay://session-gap', callback);
  }

  onSessionRecord(callback: (event: unknown) => void): () => void {
    return api.listen('session-record', callback);
  }

  onSessionInteractionChanged(callback: (event: { sessionId: string; userQuestionsRevision: number }) => void): () => void {
    return api.listen('session-interaction-changed', callback);
  }

  onSessionReady(callback: (event: { sessionId: string; hasMore: boolean; oldestSeq: number; cursor: number }) => void): () => void {
    return api.listen('relay://session-ready', callback);
  }

  onSessionSyncError(callback: (event: { sessionId: string; targetDeviceId: string; message: string }) => void): () => void {
    return api.listen('account://session-sync-error', callback);
  }

  async loadOlderSession(subscriptionId: string): Promise<void> {
    return this.adapter.request<void>('account_load_older_session', { request: { subscription_id: subscriptionId } });
  }

  async subscribeSession(targetDeviceId: string, sessionId: string): Promise<string> {
    return this.adapter.request<string>('account_subscribe_session', { request: { target_device_id: targetDeviceId, session_id: sessionId } });
  }
  async unsubscribeSession(subscriptionId: string): Promise<void> {
    return this.adapter.request<void>('account_unsubscribe_session', { request: { subscription_id: subscriptionId } });
  }

  async accountDeviceRpc(
    targetDeviceId: string,
    commandJson: string,
    timeoutMs?: number,
  ): Promise<string> {
    try {
      return await this.adapter.request<string>('account_device_rpc', {
        targetDeviceId,
        commandJson,
        timeoutMs: timeoutMs ?? null,
      });
    } catch (e) {
      log.error('accountDeviceRpc failed', e);
      throw e;
    }
  }


}

export const remoteConnectAPI = new RemoteConnectAPIService();
