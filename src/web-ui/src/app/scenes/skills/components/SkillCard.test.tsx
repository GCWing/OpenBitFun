// @vitest-environment jsdom

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import SkillCard from './SkillCard';

vi.mock('@/infrastructure/i18n/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('SkillCard Appearance contract', () => {
  it('uses the same compact card for market skills while preserving disabled installation actions', () => {
    const html = renderToStaticMarkup(
      <SkillCard
        name="Canvas"
        description="Create a canvas"
        iconKind="market"
        onOpenDetails={() => undefined}
        action={{
          icon: <span>Download</span>,
          label: 'Download',
          disabled: true,
          onClick: () => undefined,
        }}
      />,
    );

    expect(html).toContain('data-openbitfun-variant="market"');
    expect(html).toContain('data-openbitfun-name="book-open"');
    expect(html).toContain('class="skills-card"');
    expect(html).toContain('role="listitem"');
    expect(html).toContain('Create a canvas');
    expect(html).toContain('data-openbitfun-part="action"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('data-openbitfun-part="footer"');
  });

  it('keeps the details action and a description line for installed skills without a description', () => {
    const html = renderToStaticMarkup(<SkillCard name="Review" onOpenDetails={() => undefined} />);
    expect(html).toContain('data-openbitfun-variant="skill"');
    expect(html).toContain('market.item.noDescription');
    expect(html).toContain('data-openbitfun-name="arrow-right"');
    expect(html).toContain('aria-label="Review"');
  });
});
