import type { ProductControlInspectResult } from '../service-api/ProductControlAPI';

/** Update preferences belong to this installation even while a peer is rendered. */
export async function getControllerAppVersion(): Promise<string> {
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
}

export async function getControllerAutoUpdateEnabled(): Promise<boolean> {
  const { invoke } = await import('@tauri-apps/api/core');
  const result = await invoke<ProductControlInspectResult>('product_control_invoke', {
    request: { action: 'get', capabilityId: 'setting.application.general' },
  });
  const enabled = result.currentOptionValues['auto-update'];
  if (typeof enabled !== 'boolean') throw new Error('Application update preference is unavailable');
  return enabled;
}

export async function setControllerAutoUpdateEnabled(enabled: boolean): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('product_control_invoke', {
    request: { action: 'configure', capabilityId: 'setting.application.general', optionId: 'auto-update', value: enabled },
  });
}
