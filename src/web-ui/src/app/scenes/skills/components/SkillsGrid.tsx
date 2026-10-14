import { forwardRef, type CSSProperties, type HTMLAttributes } from 'react';

interface SkillsGridProps extends HTMLAttributes<HTMLDivElement> {
  rows: number;
  paginated: boolean;
}

export const SkillsGrid = forwardRef<HTMLDivElement, SkillsGridProps>(function SkillsGrid({
  rows, paginated, className, style, ...props
}, ref) {
  return (
    <div
      {...props}
      ref={ref}
      className={['skills-main__grid', paginated && 'skills-main__grid--paginated', className].filter(Boolean).join(' ')}
      style={{ ...style, '--skills-page-rows': rows } as CSSProperties}
      role="list"
      tabIndex={-1}
      data-testid="skill-list"
      data-openbitfun-scene="skills"
      data-openbitfun-part="list"
    />
  );
});
