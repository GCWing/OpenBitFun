// @vitest-environment jsdom

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import SkillCard from './SkillCard';

describe('SkillCard Appearance contract', () => {
  it('exposes variant, meta, action tone, and disabled state', () => {
    const html = renderToStaticMarkup(
      <SkillCard
        name="Canvas"
        iconKind="market"
        meta={<span>12</span>}
        actions={[{
          id: 'download',
          icon: <span>Download</span>,
          ariaLabel: 'Download',
          tone: 'primary',
          disabled: true,
          onClick: () => undefined,
        }]}
      />,
    );

    expect(html).toContain('data-openbitfun-variant="market"');
    expect(html).toContain('data-openbitfun-name="book-open"');
    expect(html).toContain('data-openbitfun-part="meta"');
    expect(html).toContain('data-openbitfun-part="action"');
    expect(html).toContain('data-openbitfun-tone="primary"');
    expect(html).toContain('data-openbitfun-state="disabled"');
  });
});
