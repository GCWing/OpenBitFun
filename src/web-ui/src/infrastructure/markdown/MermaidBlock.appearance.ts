import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';
export const mermaidBlockAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'mermaid-block',
  parts: [
    { id: 'root' }, { id: 'streaming' }, { id: 'codePreview' }, { id: 'code' },
    { id: 'loading' }, { id: 'rendered' }, { id: 'diagram' },
    { id: 'actions' }, { id: 'action' }, { id: 'source' }, { id: 'error' },
  ],
  states: [
    { id: 'streaming', selector: { kind: 'self', suffix: '[data-openbitfun-state~="streaming"]' } },
    { id: 'loading', selector: { kind: 'self', suffix: '[data-openbitfun-state~="loading"]' } },
    { id: 'error', selector: { kind: 'self', suffix: '[data-openbitfun-state~="error"]' } },
    { id: 'copied', selector: { kind: 'self', suffix: '[data-openbitfun-state~="copied"]' } },
  ],
};
