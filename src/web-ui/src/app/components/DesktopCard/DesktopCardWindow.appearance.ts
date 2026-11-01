import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const desktopCardAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'desktop-card',
  parts: [
    { id: 'root' }, { id: 'header' }, { id: 'icon' }, { id: 'title' }, { id: 'subtitle' },
    { id: 'actions' }, { id: 'body' }, { id: 'footer' }, { id: 'resizeHandle' },
    { id: 'countdown' }, { id: 'checklist' }, { id: 'note' }, { id: 'progress' }, { id: 'metrics' }, { id: 'chart' }, { id: 'cron' },
  ],
  states: [
    { id: 'loading', selector: { kind: 'self', suffix: '[data-openbitfun-state~="loading"]' } },
    { id: 'error', selector: { kind: 'self', suffix: '[data-openbitfun-state~="error"]' } },
    { id: 'warning', selector: { kind: 'self', suffix: '[data-openbitfun-state~="warning"]' } },
  ],
};
