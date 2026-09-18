 

import { api } from './ApiClient';
import { createTauriCommandError } from '../errors/TauriCommandError';
import { copyTextToClipboard } from '@/shared/utils/textSelection';
import { openUrl } from '@tauri-apps/plugin-opener';
import { createLogger } from '@/shared/utils/logger';
import { productControlAPI } from './ProductControlAPI';


const log = createLogger('SystemAPI');

/** Matches `check_for_updates` / `CheckForUpdatesResponse` from desktop `system_api.rs` (camelCase). */
export interface CheckForUpdatesResponse {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  releaseNotes: string | null;
  releaseDate: string | null;
}

export interface PendingUpdateResponse {
  version: string;
}

/** Matches `toggle_main_window_fullscreen` / desktop `ToggleMainWindowFullscreenResponse`. */
export interface ToggleMainWindowFullscreenResponse {
  isFullscreen: boolean;
  isMaximized: boolean;
}

/** Close-button behavior values (matches `app.close_button_behavior` config key). */
/** Emitted by the tray menu; the web UI owns the actual read receipts. */
const TRAY_MARK_ALL_READ_EVENT = 'tray://mark-all-read';

export type CloseBehavior = 'quit' | 'minimize_to_tray' | 'ask';

export interface SystemInfo {
  platform: string;
  arch: string;
  osVersion?: string | null;
  /** Absent on older peers. Always belongs to the host serving the request. */
  homeDir?: string | null;
}

export class SystemAPI {
   
  async getSystemInfo(): Promise<SystemInfo> {
    try {
      return await api.invoke('get_system_info', { 
        request: {} 
      });
    } catch (error) {
      throw createTauriCommandError('get_system_info', error);
    }
  }

   
  async getAppVersion(): Promise<string> {
    try {
      return await api.invoke('get_app_version', { 
        request: {} 
      });
    } catch (error) {
      throw createTauriCommandError('get_app_version', error);
    }
  }

   
  async checkForUpdates(): Promise<CheckForUpdatesResponse> {
    if (import.meta.env.DEV) {
      throw new Error('Update checks are disabled in development mode');
    }
    try {
      return await api.invoke('check_for_updates', { 
        request: {} 
      });
    } catch (error) {
      throw createTauriCommandError('check_for_updates', error);
    }
  }

  /** Desktop only: download and install update after user confirms (calls updater again). */
  async installUpdate(): Promise<void> {
    try {
      await api.invoke('install_update', {
        request: {}
      });
    } catch (error) {
      throw createTauriCommandError('install_update', error);
    }
  }

  /** Download and verify without starting the installer. */
  async downloadUpdate(): Promise<PendingUpdateResponse> {
    try {
      return await api.invoke('download_update', { request: {} }, {
        timeout: 60 * 60 * 1000,
        retries: 0,
      });
    } catch (error) {
      throw createTauriCommandError('download_update', error);
    }
  }

  async getPendingUpdate(): Promise<PendingUpdateResponse | null> {
    try {
      return await api.invoke('get_pending_update', { request: {} });
    } catch (error) {
      throw createTauriCommandError('get_pending_update', error);
    }
  }

  async installPendingUpdate(version: string): Promise<void> {
    try {
      await api.invoke('install_pending_update', { request: { version } }, {
        timeout: 120000,
        retries: 0,
      });
    } catch (error) {
      throw createTauriCommandError('install_pending_update', error);
    }
  }

  /** Desktop only: restart the app after an update has been installed. */
  async restartApp(): Promise<void> {
    try {
      await api.invoke('restart_app', {
        request: {}
      });
    } catch (error) {
      throw createTauriCommandError('restart_app', error);
    }
  }

   
  async openExternal(url: string): Promise<void> {
    try {
      await openUrl(url);
    } catch (error) {
      log.error('Failed to open external URL', { url, error });
      throw new Error(`Failed to open external URL: ${error}`);
    }
  }

  async openHtmlFileInBrowser(path: string): Promise<void> {
    try {
      await api.invoke('open_html_file_in_browser', {
        request: { path }
      });
    } catch (error) {
      throw createTauriCommandError('open_html_file_in_browser', error, { path });
    }
  }

   
  async showInFolder(path: string): Promise<void> {
    try {
      await api.invoke('show_in_folder', { 
        request: { path } 
      });
    } catch (error) {
      throw createTauriCommandError('show_in_folder', error, { path });
    }
  }

   
  async checkPathExists(path: string): Promise<boolean> {
    try {
      return await api.invoke('check_path_exists', {
        request: { path }
      });
    } catch (error) {
      throw createTauriCommandError('check_path_exists', error, { path });
    }
  }

   
  async getClipboard(): Promise<string> {
    try {
      return await api.invoke('get_clipboard', { 
        request: {} 
      });
    } catch (error) {
      throw createTauriCommandError('get_clipboard', error);
    }
  }

   
  async setClipboard(text: string): Promise<void> {
    try {
      const copied = await copyTextToClipboard(text);
      if (!copied) {
        throw new Error('Clipboard write failed');
      }
    } catch (error) {
      throw createTauriCommandError('set_clipboard', error);
    }
  }

   
  async checkCommandExists(command: string): Promise<{ exists: boolean; path: string | null }> {
    try {
      return await api.invoke('check_command_exists', { command });
    } catch (error) {
      throw createTauriCommandError('check_command_exists', error, { command });
    }
  }

   
  async checkCommandsExist(commands: string[]): Promise<Array<[string, { exists: boolean; path: string | null }]>> {
    try {
      return await api.invoke('check_commands_exist', { commands });
    } catch (error) {
      throw createTauriCommandError('check_commands_exist', error, { commands });
    }
  }

  async setMacosEditMenuMode(mode: 'system' | 'renderer'): Promise<void> {
    try {
      await api.invoke('set_macos_edit_menu_mode', {
        request: { mode }
      });
    } catch (error) {
      throw createTauriCommandError('set_macos_edit_menu_mode', error, { mode });
    }
  }

  /** Desktop only: whether the app is registered to launch at OS login. */
  async getLaunchAtLoginEnabled(): Promise<boolean> {
    if (typeof window === 'undefined' || !('__TAURI__' in window)) {
      return false;
    }
    try {
      const result = await productControlAPI.get('setting.application.general');
      const enabled = result.currentOptionValues['launch-at-login'];
      if (typeof enabled !== 'boolean') {
        throw new Error('ProductControl returned a non-boolean launch-at-login state');
      }
      return enabled;
    } catch (error) {
      log.error('Failed to read launch-at-login state', error);
      throw error;
    }
  }

  /** Desktop only: send an OS-level desktop notification. */
  async sendSystemNotification(title: string, body?: string): Promise<void> {
    if (typeof window === 'undefined' || !('__TAURI__' in window)) {
      return;
    }
    try {
      await api.invoke('send_system_notification', {
        request: { title, body: body ?? null }
      });
    } catch (error) {
      log.warn('Failed to send system notification', { title, error });
    }
  }

  /** Desktop only: register or unregister launch at OS login. */
  async setLaunchAtLoginEnabled(enabled: boolean): Promise<void> {
    if (typeof window === 'undefined' || !('__TAURI__' in window)) {
      return;
    }
    try {
      await productControlAPI.configure(
        'setting.application.general',
        'launch-at-login',
        enabled,
      );
    } catch (error) {
      log.error('Failed to set launch-at-login', { enabled, error });
      throw error;
    }
  }

  /** Desktop only: whether OpenBitFun should keep the local computer awake. */
  async getPreventSleepEnabled(): Promise<boolean> {
    const result = await productControlAPI.get('setting.application.general');
    const enabled = result.currentOptionValues['prevent-sleep'];
    if (typeof enabled !== 'boolean') {
      throw new Error('ProductControl returned a non-boolean prevent-sleep state');
    }
    return enabled;
  }

  /** Desktop only: apply and persist the app-wide sleep-prevention preference. */
  async setPreventSleepEnabled(enabled: boolean): Promise<void> {
    await productControlAPI.configure(
      'setting.application.general',
      'prevent-sleep',
      enabled,
    );
  }

  // ─── Window / Tray behavior ────────────────────────────────────────────────

  /** Desktop only: immediately quit the application. */
  async quitApp(): Promise<void> {
    try {
      await api.invoke('quit_app', { request: {} });
    } catch (error) {
      throw createTauriCommandError('quit_app', error);
    }
  }

  /** Desktop only: hide the main window to the system tray. */
  async minimizeToTray(): Promise<void> {
    try {
      await api.invoke('minimize_to_tray', { request: {} });
    } catch (error) {
      throw createTauriCommandError('minimize_to_tray', error);
    }
  }

  /** Controller-local menu bar presentation, including when viewing a peer. */
  async setTrayUnreadCount(count: number): Promise<void> {
    await api.invoke('set_tray_unread_count', { request: { count } });
  }

  /** Desktop only: the tray menu's "Mark all as read" entry was picked. */
  onTrayMarkAllRead(callback: () => void): () => void {
    return api.listen(TRAY_MARK_ALL_READ_EVENT, () => callback());
  }

  /** Desktop only: initialize the system tray after the startup shell is visible. */
  async initializeTrayAfterStartup(): Promise<void> {
    try {
      await api.invoke('initialize_tray_after_startup', { request: {} });
    } catch (error) {
      throw createTauriCommandError('initialize_tray_after_startup', error);
    }
  }

  /**
   * Desktop only: protect normal main-window geometry while toolbar mode
   * temporarily resizes the shared native window.
   */
  async setMainWindowTransientGeometry(transient: boolean): Promise<void> {
    try {
      await api.invoke('set_main_window_transient_geometry', {
        request: { transient }
      });
    } catch (error) {
      throw createTauriCommandError('set_main_window_transient_geometry', error, { transient });
    }
  }

  /**
   * Desktop only: toggle OS-window fullscreen for the main window.
   *
   * This is intentionally not maximize and not app panel fullscreen. The
   * desktop host owns the native fullscreen/maximize transition so the web UI
   * does not stitch together multiple window-state calls.
   */
  async toggleMainWindowFullscreen(): Promise<ToggleMainWindowFullscreenResponse> {
    try {
      return await api.invoke('toggle_main_window_fullscreen', { request: {} });
    } catch (error) {
      throw createTauriCommandError('toggle_main_window_fullscreen', error);
    }
  }
}


export const systemAPI = new SystemAPI();
