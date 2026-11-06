import { isTauriRuntime } from '@/infrastructure/runtime';
import { configAPI } from '../service-api/ConfigAPI';
import { createTauriCommandError } from '../errors/TauriCommandError';

const SELECTION_PATH = 'appearance.selection';

/**
 * A theme belongs to the window's installation, including while it renders a
 * peer. Use the existing local config shape/commands so older installs remain
 * readable; never send appearance selection through the selected peer adapter.
 * Server/Web keeps its existing config owner via the web transport.
 */
export const appearanceSelectionPersistence = {
  async read(): Promise<unknown> {
    if (!isTauriRuntime()) {
      return configAPI.getConfig(SELECTION_PATH, { skipRetryOnNotFound: true });
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke('get_config', {
        request: { path: SELECTION_PATH, skipRetryOnNotFound: true },
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
      if (message.includes('not found:') && message.includes('config path')
        && message.includes(`'${SELECTION_PATH}'`)) return undefined;
      throw createTauriCommandError('get_config', error, { path: SELECTION_PATH });
    }
  },

  async write(selection: string): Promise<void> {
    if (!isTauriRuntime()) {
      await configAPI.setConfig(SELECTION_PATH, selection);
      return;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_config', { request: { path: SELECTION_PATH, value: selection } });
    } catch (error) {
      throw createTauriCommandError('set_config', error, { path: SELECTION_PATH });
    }
  },
};
