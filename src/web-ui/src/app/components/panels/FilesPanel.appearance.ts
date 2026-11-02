import type { AppearanceSurfaceDescriptor } from '@/infrastructure/appearance';

export const filesPanelAppearanceDescriptor: AppearanceSurfaceDescriptor = {
  id: 'files-panel',
  parts: [
    { id: 'root' },
    { id: 'content' },
    { id: 'watchNotice' },
    { id: 'search' },
    { id: 'searchToolbar' },
    { id: 'main' },
    { id: 'placeholder' },
    { id: 'error' },
    { id: 'transfers' },
    { id: 'transfer' },
    { id: 'transferTrack' },
    { id: 'transferFill' },
  ],
  facets: [
    { id: 'searchMode', attribute: 'data-openbitfun-search-mode', values: ['content', 'filenames'] },
  ],
};
