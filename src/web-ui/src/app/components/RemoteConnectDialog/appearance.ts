import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const remoteConnectDialogAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'remote-connect-dialog',
  parts: [
    { id: 'root' },
    { id: 'sidebar' },
    { id: 'sidebarBrand' },
    { id: 'main' },
    { id: 'overview' },
    { id: 'overviewSection' },
    { id: 'overviewAction' },
    { id: 'sectionMarker' },
    { id: 'viewHeader' },
    { id: 'subtabs' },
    { id: 'panel' },
    { id: 'body' },
    { id: 'pairingCard' },
    { id: 'connections' },
    { id: 'botCard' },
    { id: 'status' },
    { id: 'stateMark' },
    { id: 'error' },
  ],
  facets: [
    { id: 'view', attribute: 'data-openbitfun-view', values: ['overview', 'network', 'bot', 'account'] },
    { id: 'group', attribute: 'data-openbitfun-group', values: ['network', 'bot', 'account'] },
  ],
  states: [
    { id: 'authenticated', selector: { kind: 'self', suffix: '[data-openbitfun-state~="authenticated"]' } },
    { id: 'connected', selector: { kind: 'self', suffix: '[data-openbitfun-state~="connected"]' } },
    { id: 'disabled', selector: { kind: 'self', suffix: '[data-openbitfun-state~="disabled"]' } },
  ],
};

export const remoteAccountPanelAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'remote-account-panel',
  parts: [
    { id: 'root' },
    { id: 'error' },
    { id: 'loading' },
    { id: 'scroll' },
    { id: 'form' },
    { id: 'actions' },
    { id: 'deviceList' },
    { id: 'deviceCard' },
  ],
  facets: [
    { id: 'view', attribute: 'data-openbitfun-view', values: ['login', 'devices'] },
  ],
  states: [
    { id: 'offline', selector: { kind: 'self', suffix: '[data-openbitfun-state~="offline"]' } },
    { id: 'current', selector: { kind: 'self', suffix: '[data-openbitfun-state~="current"]' } },
    { id: 'syncing', selector: { kind: 'self', suffix: '[data-openbitfun-state~="syncing"]' } },
  ],
};
