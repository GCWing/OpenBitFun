import { Alert, Button } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';

export function ModuleLoadFailure({ error, retry }: { error: Error; retry: () => void }) {
  // Errors is a bootstrap namespace. The fallback must not load another module
  // or pull the application service graph into every lazy declaration.
  const { t } = useTranslation('errors', { useSuspense: false });
  return (
    <div style={{ padding: 16, minWidth: 0, maxWidth: '100%' }}>
      <Alert
        tone="error"
        title={t('moduleLoad.title')}
        message={t('moduleLoad.description')}
        description={
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Button size="sm" variant="primary" onClick={retry}>
              {t('moduleLoad.retry')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
              {t('boundary.reload')}
            </Button>
          </span>
        }
      />
      {import.meta.env.DEV && (
        <details style={{ marginTop: 12, overflowWrap: 'anywhere' }}>
          <summary>{t('boundary.technicalDetails')}</summary>
          {error.message}
        </details>
      )}
    </div>
  );
}
