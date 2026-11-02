import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, OverflowText, Tooltip } from '@openbitfun/ui';
import './ProjectResourceList.scss';

export interface ProjectResourceListItem {
  id: string;
  name: string;
  icon?: ReactNode;
  meta?: ReactNode;
  title?: string;
  onClick: () => void;
}

export interface ProjectResourceListAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
}

export function ProjectResourceList({ items, label, moreLabel, onShowAll, addAction, bounded = true }: {
  items: ProjectResourceListItem[];
  label: string;
  moreLabel?: string;
  onShowAll?: () => void;
  addAction?: ProjectResourceListAction;
  bounded?: boolean;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const [capacity, setCapacity] = useState(3);
  const hasAddAction = Boolean(addAction);
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = list?.firstElementChild;
    if (!bounded || !list || !row) return;
    const measure = () => {
      const height = list.getBoundingClientRect().height;
      const rowHeight = row.getBoundingClientRect().height;
      const gap = Number.parseFloat(getComputedStyle(list).rowGap) || 0;
      if (height > 0 && rowHeight > 0) setCapacity(Math.max(hasAddAction ? 2 : 1, Math.floor((height + gap) / (rowHeight + gap))));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    observer.observe(row);
    return () => observer.disconnect();
  }, [bounded, items.length, capacity, hasAddAction]);

  const itemCapacity = capacity - Number(hasAddAction);
  const overflowing = bounded && items.length > itemCapacity;
  const visibleItems = bounded ? items.slice(0, Math.max(0, itemCapacity - Number(overflowing))) : items;
  return <ul className={`project-resource-list${bounded ? '' : ' project-resource-list--unbounded'}`} ref={listRef} aria-label={label}
    data-openbitfun-scene="project-resources" data-openbitfun-part="resourceList">
    {visibleItems.map(item => <li className="project-resource-list__item" key={item.id}>
      <button type="button" className="project-resource-list__row" onClick={item.onClick} aria-haspopup="dialog" title={item.title} data-overflow-trigger>
        {item.icon}
        <OverflowText className="project-resource-list__name">{item.name}</OverflowText>
        {item.meta && <span className="project-resource-list__meta">
          {typeof item.meta === 'string' ? <OverflowText>{item.meta}</OverflowText> : item.meta}
        </span>}
      </button>
    </li>)}
    {overflowing && <li className="project-resource-list__item">
      <button type="button" className="project-resource-list__row project-resource-list__more"
        onClick={onShowAll} aria-haspopup="dialog" aria-label={moreLabel} title={moreLabel}>…</button>
    </li>}
    {addAction && <li className="project-resource-list__item">
      <Tooltip content={addAction.disabled ? addAction.disabledReason : undefined}>
        <span tabIndex={addAction.disabled ? 0 : undefined}>
          <button type="button" className="project-resource-list__row project-resource-list__add" onClick={addAction.onClick}
            disabled={addAction.disabled} aria-haspopup="dialog" data-overflow-trigger>
            <Icon name="plus" size="sm" /><OverflowText>{addAction.label}</OverflowText>
          </button>
        </span>
      </Tooltip>
    </li>}
  </ul>;
}
