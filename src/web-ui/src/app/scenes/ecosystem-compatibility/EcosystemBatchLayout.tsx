import { Fragment, useRef, type ReactNode } from 'react';
import { Button, DialogBody, Icon, type IconSource } from '@openbitfun/ui';
import { Server, Webhook } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n';

type ImportKind = 'skill' | 'mcp' | 'hook';
const GROUPS = [
  { kind: 'skill', icon: { name: 'book-open' } },
  { kind: 'mcp', icon: { glyph: Server } },
  { kind: 'hook', icon: { glyph: Webhook } },
] as const satisfies readonly { kind: ImportKind; icon: IconSource }[];

/** Keep review/progress visible while only the typed item list scrolls. */
export function EcosystemBatchLayout<T extends { id: string }>({ entries, getKind, renderEntry, summary, processed, busy, children }: {
  entries: T[];
  getKind: (entry: T) => ImportKind;
  renderEntry: (entry: T) => ReactNode;
  summary: ReactNode;
  processed?: number;
  busy: boolean;
  children?: ReactNode;
}) {
  const { t, formatNumber } = useI18n('scenes/ecosystem-compatibility');
  const groupElements = useRef<Partial<Record<ImportKind, HTMLElement | null>>>({});
  const groups = GROUPS.map((group) => ({ ...group, entries: entries.filter((entry) => getKind(entry) === group.kind) })).filter((group) => group.entries.length);
  const progressLabel = t('content.batchProgress', { completed: formatNumber(processed ?? 0), total: formatNumber(entries.length) });
  return <>
    <div className="ecosystem-compatibility__batch-status">
      <p>{summary}</p>
      <div className="ecosystem-compatibility__batch-types">
        {groups.map(({ kind, icon, entries: group }) => <Button key={kind} size="sm" variant="outline" leadingIcon={<Icon {...icon} size="sm" />}
          onClick={() => groupElements.current[kind]?.scrollIntoView({ block: 'start' })}>
          {t(`capabilities.${kind}`)} · {formatNumber(group.length)}
        </Button>)}
      </div>
      {processed !== undefined ? <div className="ecosystem-compatibility__batch-progress" role="status">
        <div><span>{progressLabel}</span>{busy ? <span>{t(processed === entries.length ? 'content.batchRefreshing' : 'content.batchProcessing')}</span> : null}</div>
        <progress value={processed} max={Math.max(entries.length, 1)} aria-label={progressLabel} />
      </div> : null}
    </div>
    <DialogBody className="ecosystem-compatibility__batch-body">
      <div className="ecosystem-compatibility__content-detail">
        {groups.map(({ kind, icon, entries: group }) => {
          return <section key={kind} ref={(element) => { groupElements.current[kind] = element; }} className="ecosystem-compatibility__batch-group" aria-label={t(`capabilities.${kind}`)}>
            <h3><Icon {...icon} size="sm" /><span>{t(`capabilities.${kind}`)}</span><span>{formatNumber(group.length)}</span></h3>
            {group.map((entry) => <Fragment key={entry.id}>{renderEntry(entry)}</Fragment>)}
          </section>;
        })}
        {children}
      </div>
    </DialogBody>
  </>;
}
