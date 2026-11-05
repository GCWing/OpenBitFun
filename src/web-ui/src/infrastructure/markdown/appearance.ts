import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance/types';

export const markdownAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'markdown',
  parts: [
    { id: 'root', visualRole: 'content' }, { id: 'fallback', visualRole: 'content' },
    { id: 'imageFallback', visualRole: 'content' },
    { id: 'codeBlock', visualRole: 'card' },
    { id: 'codeToolbar', propertyProfile: 'control', visualRole: 'toolbar' },
    { id: 'codeBody', visualRole: 'content' },
    { id: 'codePre', propertyProfile: 'paint', visualRole: 'content' },
    { id: 'codeContent', propertyProfile: 'paint', visualRole: 'content' },
    { id: 'fileLink' }, { id: 'visualizationLink' }, { id: 'tabLink' },
    { id: 'table' }, { id: 'blockquote' }, { id: 'math' },
  ],
  states: [
    { id: 'fallback', selector: { kind: 'self', suffix: '[data-openbitfun-state~="fallback"]' } },
    { id: 'streaming', selector: { kind: 'self', suffix: '[data-openbitfun-state~="streaming"]' } },
    { id: 'error', selector: { kind: 'self', suffix: '[data-openbitfun-state~="error"]' } },
    { id: 'expanded', selector: { kind: 'self', suffix: '[data-openbitfun-state~="expanded"]' } },
  ],
};
