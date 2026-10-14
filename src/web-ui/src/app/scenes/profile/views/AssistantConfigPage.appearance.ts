import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const assistantConfigPageAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'assistant-config-page',
  parts: [
    { id: 'root' }, { id: 'toolbar' }, { id: 'back' }, { id: 'layout' },
    { id: 'identity' }, { id: 'sessions' }, { id: 'personaList' },
    { id: 'persona' }, { id: 'editor' }, { id: 'editorHeader' }, { id: 'editorBody' },
    { id: 'frontmatter' }, { id: 'bodyEditor' }, { id: 'loading' }, { id: 'error' },
  ],
  states: [
    { id: 'selected', selector: { kind: 'self', suffix: '[data-openbitfun-state~="selected"]' } },
  ],
};
