import { Button, Icon, IconButton } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { skillPageNumbers } from '../hooks/useSkillsPagination';

interface SkillsPaginationProps {
  pagination: { page: number; totalPages: number; start: number; end: number };
  total: number;
  listId: string;
  hasMore?: boolean;
  loading?: boolean;
  onPageChange: (page: number) => void;
}

export function SkillsPagination({ pagination, total, listId, hasMore = false, loading = false, onPageChange }: SkillsPaginationProps) {
  const { t, formatNumber } = useI18n('scenes/skills');
  if (pagination.totalPages <= 1 && !hasMore) return null;

  return (
    <nav
      className="skills-pagination"
      aria-label={t('pagination.label')}
      aria-busy={loading || undefined}
      data-testid={`${listId}-pagination`}
      data-openbitfun-scene="skills"
      data-openbitfun-part="pagination"
    >
      <span className="skills-pagination__summary" role="status" aria-live="polite" aria-atomic="true" data-openbitfun-scene="skills" data-openbitfun-part="pageInfo">
        {t(hasMore ? 'pagination.rangeMore' : 'pagination.range', {
          start: formatNumber(pagination.start),
          end: formatNumber(pagination.end),
          total: formatNumber(total),
        })}
      </span>
      <div className="skills-pagination__controls">
        <IconButton
          variant="quiet"
          size="sm"
          icon={<Icon name="chevron-left" size="sm" />}
          aria-label={t('market.pagination.prev')}
          title={t('market.pagination.prev')}
          aria-controls={listId}
          disabled={loading || pagination.page === 1}
          onClick={() => onPageChange(pagination.page - 1)}
        />
        <ol className="skills-pagination__pages">
          {skillPageNumbers(pagination.page, pagination.totalPages).map(page => (
            <li key={page}>
              {typeof page === 'number' ? (
                <Button
                  variant={page === pagination.page ? 'secondary' : 'text'}
                  size="sm"
                  aria-label={t('pagination.page', { page: formatNumber(page) })}
                  aria-current={page === pagination.page ? 'page' : undefined}
                  aria-controls={listId}
                  disabled={loading}
                  onClick={() => onPageChange(page)}
                  data-openbitfun-scene="skills"
                  data-openbitfun-part="pageButton"
                >
                  {formatNumber(page)}
                </Button>
              ) : <span className="skills-pagination__gap" aria-hidden="true">…</span>}
            </li>
          ))}
        </ol>
        <span className="skills-pagination__compact">
          {t(hasMore ? 'market.pagination.infoMore' : 'market.pagination.info', {
            current: formatNumber(pagination.page),
            total: formatNumber(pagination.totalPages),
          })}
        </span>
        <IconButton
          variant="quiet"
          size="sm"
          icon={<Icon name="chevron-right" size="sm" />}
          aria-label={t('market.pagination.next')}
          title={t('market.pagination.next')}
          aria-controls={listId}
          disabled={loading || (!hasMore && pagination.page === pagination.totalPages)}
          onClick={() => onPageChange(pagination.page + 1)}
        />
      </div>
    </nav>
  );
}
