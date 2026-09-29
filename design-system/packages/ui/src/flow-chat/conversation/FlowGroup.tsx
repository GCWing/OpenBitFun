import { Fragment, forwardRef, useCallback, useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { Icon } from '../../components/Icon/Icon';
import { IconButton } from '../../components/IconButton/IconButton';
import { MenuPopover, type MenuEntry } from '../../components/Menu/MenuPopover';
import { SearchField } from '../../components/SearchField/SearchField';
import { ScrollArea } from '../../components/ScrollArea/ScrollArea';
import { StatusPill } from '../../components/StatusPill/StatusPill';
import { Tooltip } from '../../components/Tooltip/Tooltip';
import { OverflowText } from '../../primitives/OverflowText';
import { receiveCapsule, useCapsuleMotion } from '../motion/capsuleMotion';
import { FlowChatCollapse } from './FlowChatCollapse';
import { FileRevisionSummary, type FlowGroupFileRevision } from './FileRevisionSummary';
import fileRevisionStyles from './FileRevisionSummary.module.css';
import './ConversationBlocks.css';

export type { FlowGroupFileRevision } from './FileRevisionSummary';

/** A host-owned, single-use receipt. Counts, hydration and mounting are not arrivals. */
export interface FlowGroupReceiveFeedback {
  claim: () => boolean;
}

export interface FlowGroupFilter {
  label: string;
  value: string;
  options: readonly { value: string; label: string; count?: string }[];
  onValueChange: (value: string) => void;
}

/** Host-controlled browsing; the public component never inspects tool payloads. */
export interface FlowGroupBrowserProps {
  query: string;
  onQueryChange: (query: string) => void;
  searchLabel: string;
  clearSearchLabel: string;
  filterLabel?: string;
  tools: FlowGroupFilter;
  status: FlowGroupFilter;
  resultLabel: string;
  notice?: string;
  filtering: boolean;
  pending?: boolean;
  empty: boolean;
  emptyLabel: string;
  resetLabel: string;
  onReset: () => void;
  onInteract?: () => void;
}

export interface FlowGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  children?: ReactNode;
  expanded: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  leading?: ReactNode;
  summary: string;
  summaryItems?: readonly { label: string; count: string }[];
  /** Full localized description for the tooltip and accessible control name. */
  summaryDescription?: string;
  itemCount?: number;
  placement?: 'standalone' | 'inline';
  streaming?: boolean;
  /** Opt into an internal scroll area for embedded hosts; transcripts use natural height. */
  bounded?: boolean;
  /** The host renders members as siblings in its single virtual timeline. */
  externalContent?: boolean;
  receiveFeedback?: FlowGroupReceiveFeedback;
  contentRef?: Ref<HTMLDivElement>;
  onContentScroll?: HTMLAttributes<HTMLDivElement>['onScroll'];
  contentProps?: HTMLAttributes<HTMLDivElement>;
  browser?: FlowGroupBrowserProps;
  /** A shared file identity with bound revision pages instead of a capsule. */
  fileRevision?: FlowGroupFileRevision;
  /** Stable anatomy identity for semantic presets and installed Appearance packages. */
  'data-openbitfun-component'?: string;
  'data-testid'?: string;
  'data-group-kind'?: string;
}

/** Controlled collection anatomy. Membership, summaries and disclosure persistence belong to the host. */
export const FlowGroup = forwardRef<HTMLDivElement, FlowGroupProps>(function FlowGroup({
  children, expanded, onExpandedChange, leading, summary, summaryItems, summaryDescription,
  itemCount = 0, placement = 'standalone', streaming = false, bounded = false,
  receiveFeedback, contentRef, onContentScroll, contentProps, browser, fileRevision, externalContent = false, className = '',
  'data-openbitfun-component': component = 'flow-group',
  'data-testid': testId = 'chat-flow-group', 'data-group-kind': kind,
  ...props
}, ref) {
  const internalContentId = useId();
  const contentId = externalContent ? undefined : internalContentId;
  const Content = bounded ? ScrollArea : 'div';
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bindRoot = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }, [ref]);
  const motion = useCapsuleMotion(rootRef);
  const previousFeedback = useRef(receiveFeedback);
  useEffect(() => {
    const changed = previousFeedback.current !== receiveFeedback;
    previousFeedback.current = receiveFeedback;
    // Consume even when expanded or mounting after virtualization. Old feedback
    // must never replay when the reader scrolls back or later closes the group.
    const claimed = receiveFeedback?.claim();
    if (expanded) motion.cancel();
    else if (!fileRevision && changed && claimed) motion.play('receive', receiveCapsule);
  }, [expanded, fileRevision, receiveFeedback, motion.play, motion.cancel]);

  const handleToggle = () => {
    if (!onExpandedChange) return;
    motion.cancel();
    onExpandedChange(!expanded);
  };

  return <div {...props} ref={bindRoot}
    data-openbitfun-component={component} data-openbitfun-part="root" data-flow-group=""
    data-openbitfun-state={expanded ? 'expanded' : undefined} data-testid={testId}
    data-group-kind={kind} data-placement={placement} data-expanded={expanded ? 'true' : 'false'}
    data-file-revisions={fileRevision ? 'true' : undefined}
    data-collected={itemCount > 1 ? 'true' : 'false'} data-item-count={itemCount}
    className={['explore-region', 'explore-region--collapsible', expanded ? 'explore-region--expanded' : 'explore-region--collapsed',
      streaming && 'explore-region--streaming', bounded && 'explore-region--bounded', fileRevision && fileRevisionStyles.group, className].filter(Boolean).join(' ')}>
    {fileRevision ? <FileRevisionSummary file={fileRevision} itemCount={itemCount} expanded={expanded}
      onToggle={onExpandedChange ? handleToggle : undefined} contentId={contentId}
      description={[summaryDescription ?? summary, fileRevision.statusLabel, fileRevision.changeSummary?.label].filter(Boolean).join(' · ')} component={component} testId={testId} />
      : <div className={`explore-region__toolbar${expanded && browser ? ' explore-region__toolbar--browsable' : ''}`}>
      <Tooltip content={summaryDescription ?? summary} disabled={!summaryDescription}>
        <div data-openbitfun-component={component} data-openbitfun-part="header" className="explore-region__header"
          data-overflow-trigger onClick={handleToggle} role={onExpandedChange ? 'button' : undefined}
          tabIndex={onExpandedChange ? 0 : undefined} aria-label={onExpandedChange ? summaryDescription ?? summary : undefined}
          aria-expanded={onExpandedChange ? expanded : undefined} aria-controls={onExpandedChange ? contentId : undefined}
          onKeyDown={event => {
            if (onExpandedChange && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault(); handleToggle();
            }
          }} data-testid={`${testId}-toggle`} data-group-kind={kind} data-expanded={expanded ? 'true' : 'false'}>
          <span className="explore-region__summary-surface">
            <span aria-hidden="true" data-capsule-skin className="explore-region__skin" />
            <StatusPill tone="neutral" className="explore-region__pill" leading={
              <span aria-hidden="true" className="explore-region__leading-icon">
                <span className="explore-region__leading-icon--default">{leading ?? <Icon name="folder" size="sm" />}</span>
                <Icon name="chevron-right" size="sm" className="explore-region__leading-icon--collapsed-hover" />
                <Icon name="chevron-down" size="sm" className="explore-region__leading-icon--expanded" />
              </span>
            }>
              <span data-openbitfun-component={component} data-openbitfun-part="summary" className="explore-region__summary">
                {summaryItems?.length ? summaryItems.map((item, index) => <Fragment key={index}>
                  {index > 0 && <span aria-hidden="true" className="explore-region__separator"> · </span>}
                  <span className="explore-region__summary-item">{item.label}{' '}<span className="explore-region__count">{item.count}</span></span>
                </Fragment>) : summary}
              </span>
            </StatusPill>
          </span>
        </div>
      </Tooltip>
      {expanded && browser && <div data-openbitfun-component={component} data-openbitfun-part="controls"
        className="explore-region__controls" onFocusCapture={browser.onInteract}>
        <FlowGroupBrowser browser={browser} />
      </div>}
    </div>}
    {!externalContent && <FlowChatCollapse isOpen={expanded} id={contentId}
      data-openbitfun-component={component} data-openbitfun-part="contentWrapper"
      className="explore-region__content-wrapper"
      innerClassName="explore-region__content-inner">
      <Content {...contentProps} ref={contentRef}
        {...(bounded ? { edgeFade: 'vertical' as const, overscrollBehaviorY: 'auto' as const } : {})}
        data-openbitfun-component={component} data-openbitfun-part="content"
        className="explore-region__content" onScroll={onContentScroll ?? contentProps?.onScroll}
        data-testid={`${testId}-content`} data-group-kind={kind} data-expanded={expanded ? 'true' : 'false'}>
        {browser?.empty && <div className="explore-region__empty">{browser.emptyLabel}</div>}
        {children}
      </Content>
    </FlowChatCollapse>}
    {externalContent && expanded && browser?.empty && <div className="explore-region__empty">{browser.emptyLabel}</div>}
  </div>;
});

/** Search remains visible; tool statistics and filters live in the menu. */
function FlowGroupBrowser({ browser }: { browser: FlowGroupBrowserProps }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const menuId = useId();
  const filterLabel = browser.filterLabel ?? `${browser.tools.label} · ${browser.status.label}`;
  const resultLabel = [browser.resultLabel, browser.notice].filter(Boolean).join(' · ');
  const activeFilters = [browser.tools, browser.status].some(filter => filter.value !== filter.options[0]?.value);

  const clearSearch = () => {
    browser.onQueryChange('');
    searchRef.current?.focus({ preventScroll: true });
  };
  const reset = () => {
    browser.onReset();
    searchRef.current?.focus({ preventScroll: true });
  };
  const items: MenuEntry[] = [
    ...([['tools', browser.tools], ['status', browser.status]] as const).map(([id, filter]) => ({
      id, label: filter.label,
      submenu: filter.options.map(option => ({
        id: `${id}:${option.value}`, label: option.label, shortcut: option.count,
        role: 'menuitemradio' as const, checked: filter.value === option.value,
        onSelect: () => filter.onValueChange(option.value),
      })),
    })),
    ...(browser.filtering ? [{ id: 'separator', label: '', separator: true },
      { id: 'reset', label: browser.resetLabel, onSelect: reset }] : []),
  ];
  const results = browser.filtering ? <span role="status" aria-busy={browser.pending || undefined}
    className="explore-region__filter-status"><OverflowText title={resultLabel}>{resultLabel}</OverflowText></span> : null;

  return <>
    <div className="explore-region__browse-main">
      <SearchField ref={searchRef} id={searchId} className="explore-region__search" size="sm"
        aria-label={browser.searchLabel} placeholder={browser.searchLabel} value={browser.query}
        leadingIcon={<Icon name="search" size="sm" />} trailing={results}
        trailingAction={<Tooltip content={filterLabel} disabled={menuOpen}>
          <IconButton ref={menuRef} aria-label={filterLabel} aria-haspopup="menu" aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined} aria-pressed={activeFilters} size="xs"
            shape="circle" variant={activeFilters ? 'fill' : 'quiet'} icon={<Icon name="filter" size="sm" />}
            onClick={() => { browser.onInteract?.(); setMenuOpen(!menuOpen); }} />
        </Tooltip>}
        onValueChange={browser.onQueryChange} clearLabel={browser.clearSearchLabel}
        onClear={browser.query ? clearSearch : undefined}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation();
            if (browser.query) clearSearch();
          }
        }} />
    </div>
    <MenuPopover id={menuId} aria-label={filterLabel} items={items} open={menuOpen}
      onClose={() => setMenuOpen(false)} anchorRef={menuRef} placement="bottom" />
  </>;
}
