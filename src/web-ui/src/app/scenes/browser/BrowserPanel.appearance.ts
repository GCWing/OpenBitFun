import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';
export const browserPanelAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'browser-panel',
  parts: [
    { id: 'root', propertyProfile: 'layout', visualRole: 'continuous-surface', continuityGroup: 'browser-panel' },
    { id: 'toolbar', visualRole: 'toolbar', continuityGroup: 'browser-panel' },
    { id: 'address', propertyProfile: 'control', visualRole: 'control' },
    { id: 'error', visualRole: 'content' },
    { id: 'content', propertyProfile: 'layout', visualRole: 'continuous-surface', continuityGroup: 'browser-panel' },
    { id: 'iframe', propertyProfile: 'layout', visualRole: 'content' },
    { id: 'webviewHost', propertyProfile: 'layout', visualRole: 'content' },
    { id: 'offscreenSurface', propertyProfile: 'layout', visualRole: 'content' },
    { id: 'offscreenFrame', propertyProfile: 'layout', visualRole: 'content' },
    { id: 'offscreenPopup', propertyProfile: 'layout', visualRole: 'content' },
    { id: 'offscreenKeyboard', propertyProfile: 'control', visualRole: 'control' },
    { id: 'placeholder', visualRole: 'content' },
  ],
  states: [{ id: 'loading', selector: { kind: 'self', suffix: '[data-openbitfun-state~="loading"]' } }],
};
