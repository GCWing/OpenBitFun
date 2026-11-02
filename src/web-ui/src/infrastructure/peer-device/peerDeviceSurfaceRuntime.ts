/** Production composition for the window-wide device-surface controller. */

import type { ITransportAdapter } from '@/infrastructure/api/adapters/base';
import {
  createTransportAdapter,
  getTransportAdapter,
  getTransportSurfaceBinding,
  setTransportAdapter,
} from '@/infrastructure/api/adapters';
import { PeerDeviceTransportAdapter } from '@/infrastructure/api/adapters/peer-device-adapter';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { configAPI } from '@/infrastructure/api/service-api/ConfigAPI';
import { configManager } from '@/infrastructure/config/services/ConfigManager';
import { workspaceManager } from '@/infrastructure/services/business/workspaceManager';
import { FlowChatManager } from '@/flow_chat/services/FlowChatManager';
import { useSceneStore } from '@/app/stores/sceneStore';
import { clearAgentCanvasForPeerSwitch } from '@/app/components/panels/content-canvas/stores';
import { editorManager } from '@/tools/editor/services/EditorManager';
import { TerminalService } from '@/tools/terminal/services/TerminalService';
import { createLogger } from '@/shared/utils/logger';
import {
  activateSurface,
  isSurfaceChangedError,
  type SurfaceScope,
} from './deviceSurface';
import { setActiveSurfaceDeviceId } from './deviceSurfaceRouting';
import { markDeviceSurfaceSwitched } from './deviceSurfaceReconcile';
import { setPeerDeviceModeActiveFlag } from './peerModeFlag';
import { clearDeviceActivity } from './deviceActivity';
import { peerConnectionManager } from './PeerConnectionManager';
import {
  PeerDeviceSurfaceController,
  type PeerDeviceSurfaceControllerDependencies,
} from './PeerDeviceSurfaceController';

const log = createLogger('PeerDeviceSurfaceRuntime');

const SUBMIT_DRAIN_TIMEOUT_MS = 8_000;

async function resetProductSurface(assertCurrent: () => void): Promise<void> {
  assertCurrent();
  try {
    const drained = await FlowChatManager.getInstance()
      .waitForInFlightSubmissions(SUBMIT_DRAIN_TIMEOUT_MS);
    if (!drained) {
      log.warn('Device surface switch proceeded with a submission still in flight');
    }
  } catch (error) {
    if (isSurfaceChangedError(error)) {
      throw error;
    }
    log.warn('Failed to await in-flight submissions before surface switch', { error });
  }
  assertCurrent();

  try {
    FlowChatManager.getInstance().resetForPeerModeSwitch();
  } catch (error) {
    log.warn('Failed to reset FlowChat during device surface switch', { error });
  }

  // Clear before the peer-mode event so session creation cannot reuse a path
  // owned by the device being left.
  try {
    workspaceManager.clearForPeerModeSwitch();
  } catch (error) {
    log.warn('Failed to clear workspace during device surface switch', { error });
  }

  try {
    await TerminalService.getInstance().disconnect();
  } catch (error) {
    log.warn('Failed to disconnect terminal listeners during device surface switch', { error });
  }
  assertCurrent();

  try {
    editorManager.destroy();
  } catch (error) {
    log.warn('Failed to clear editor during device surface switch', { error });
  }

  try {
    clearAgentCanvasForPeerSwitch();
  } catch (error) {
    log.warn('Failed to clear canvas during device surface switch', { error });
  }

  try {
    useSceneStore.getState().resetForPeerSwitch();
  } catch (error) {
    log.warn('Failed to reset scenes during device surface switch', { error });
  }
  assertCurrent();
}

async function reloadConfigFromCurrentTransport(scope: SurfaceScope): Promise<void> {
  try {
    await configAPI.reloadConfig();
    scope.assertCurrent('reload device surface config');
    configManager.clearCache();
    await configManager.reload();
    scope.assertCurrent('reload device surface config');
  } catch (error) {
    if (isSurfaceChangedError(error)) {
      throw error;
    }
    log.warn('Failed to reload config after device surface transport switch', { error });
  }
}

async function setPeerControllerActive(active: boolean, required: boolean): Promise<void> {
  try {
    await api.invoke('peer_controller_set_active', { active });
  } catch (error) {
    log.warn('Failed to update peer controller active flag', { active, error });
    if (required) {
      throw error instanceof Error
        ? error
        : new Error(`peer_controller_set_active(${active}) failed`);
    }
  }
}

function emitPeerModeChanged(detail: { active: boolean; deviceId?: string }): void {
  window.dispatchEvent(new CustomEvent('peer-mode:changed', { detail }));
}

function createDependencies(): PeerDeviceSurfaceControllerDependencies {
  const bootAdapter = getTransportAdapter();
  // Preserve the adapter the application booted with before the first peer
  // commit replaces the registry binding. Otherwise leaving that first peer
  // creates a second local adapter and strands the original listener owner.
  let localAdapter: ITransportAdapter | null = bootAdapter instanceof PeerDeviceTransportAdapter
    ? null
    : bootAdapter;

  return {
    connectionManager: peerConnectionManager,
    getLocalAdapter: async () => {
      if (!localAdapter) {
        const booted = getTransportAdapter();
        localAdapter = booted instanceof PeerDeviceTransportAdapter
          ? createTransportAdapter()
          : booted;
        await localAdapter.connect();
      }
      return localAdapter;
    },
    resetProductSurface,
    reloadConfig: reloadConfigFromCurrentTransport,
    rebootstrapWorkspaces: async (scope) => {
      await workspaceManager.reinitializeForPeerModeSwitch();
      scope.assertCurrent('rebootstrap device surface workspaces');
    },
    setPeerControllerActive,
    commitSurface: target => activateSurface(target.surfaceId, () => {
      setActiveSurfaceDeviceId(target.deviceId);
      setTransportAdapter(target.adapter, target.surfaceId);
      api.reattachTransportAdapter();
    }),
    invalidateCurrentSurface: () => {
      const current = getTransportSurfaceBinding();
      return activateSurface(current.surfaceId, () => {
        setTransportAdapter(current.adapter, current.surfaceId);
      });
    },
    setPeerDeviceModeActiveFlag,
    emitPeerModeChanged,
    markSurfaceSwitched: markDeviceSurfaceSwitched,
    discardSurfaceState: surfaceId => {
      FlowChatManager.getInstance().discardDeviceSurface(surfaceId);
      workspaceManager.discardDeviceSurface(surfaceId);
    },
    clearDeviceActivity,
    listenPresence: listener => api.listen<{
      devices: Array<{ device_id: string }>;
    }>('account://device-presence', payload => {
      listener((payload?.devices ?? []).map(device => device.device_id));
    }),
    listenLoginState: listener => api.listen<{ logged_in: boolean }>(
      'account://login-state',
      payload => listener(payload?.logged_in === true),
    ),
  };
}

/** Window-wide controller: connections and activation state outlive React renders. */
export const peerDeviceSurfaceController = new PeerDeviceSurfaceController(
  createDependencies(),
);
