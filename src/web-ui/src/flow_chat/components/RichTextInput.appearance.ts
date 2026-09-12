import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const richTextInputAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'rich-text-input',
  parts: [
    { id: 'root' },
    { id: 'contextTag' },
    { id: 'tagBadge' },
    { id: 'tagText' },
    { id: 'tagRemove' },
  ],
  facets: [
    {
      id: 'contextType',
      attribute: 'data-openbitfun-context-type',
      values: [
        'file',
        'directory',
        'session-reference',
        'code-snippet',
        'pull-request',
        'mermaid-node',
        'mermaid-diagram',
        'image',
        'terminal-command',
        'git-ref',
        'url',
        'web-element',
        'widget-reference',
        'skill-reference',
        'mcp-reference',
        'additional-mode-reference',
      ],
    },
  ],
  states: [
    { id: 'focused', selector: { kind: 'self', suffix: '[data-openbitfun-state~="focused"]' } },
    { id: 'disabled', selector: { kind: 'self', suffix: '[data-openbitfun-state~="disabled"]' } },
  ],
};
