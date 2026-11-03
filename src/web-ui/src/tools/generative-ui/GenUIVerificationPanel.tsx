import { useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import type { GenUIVerification } from './genUIVerification';
export function GenUIVerificationPanel({ report, delivery, onRepair, onReload }: {
  report: GenUIVerification;
  delivery?: Record<string, unknown>;
  onRepair?: () => Promise<void>;
  onReload?: () => Promise<void>;
}) {
  const { t } = useI18n('flow-chat');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const stages = ['preflight', 'checks', 'render', 'interaction', 'persistence', 'reopen'] as const;
  return <details className="gen-ui-verification">
    <summary>{t('toolCards.generativeUI.verification')}</summary>
    <dl>{stages.map(stage => <div key={stage}><dt>{t('toolCards.generativeUI.' + stage)}</dt><dd>{t('toolCards.generativeUI.' + (report[stage] ?? 'unverified'))}</dd></div>)}</dl>
    {delivery ? <dl>{['probeReopen', 'layout', 'requirementCoverage', 'visual'].map(stage => {
      const value = stage === 'requirementCoverage' ? (delivery[stage] as { status?: unknown } | undefined)?.status : delivery[stage];
      const status = value === 'passed' || value === 'failed' ? value : 'unverified';
      return <div key={stage}><dt>{t('toolCards.generativeUI.' + stage)}</dt><dd>{t('toolCards.generativeUI.' + status)}</dd></div>;
    })}</dl> : null}
    {onReload ? <button type="button" disabled={pending || report.persistence !== 'saved'} onClick={() => {
      setPending(true);
      setError('');
      onReload().catch(error => setError(error instanceof Error ? error.message : String(error))).finally(() => setPending(false));
    }}>{t('toolCards.generativeUI.verifyReload')}</button> : null}
    {onRepair ? <button type="button" disabled={pending} onClick={() => {
      setPending(true);
      setError('');
      onRepair().catch(error => setError(error instanceof Error ? error.message : String(error))).finally(() => setPending(false));
    }}>{t('toolCards.generativeUI.repair')}</button> : null}
    {error ? <p role="alert">{error}</p> : null}
  </details>;
}
