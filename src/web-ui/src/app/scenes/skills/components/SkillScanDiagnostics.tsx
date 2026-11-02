import { Button } from '@openbitfun/ui';
import type { SkillScanDiagnostic } from '@/infrastructure/config/types';
import { getEcosystemSourceLabel } from '@/infrastructure/config/skillSourcePresentation';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';

interface SkillScanDiagnosticsProps {
  diagnostics: SkillScanDiagnostic[];
  diagnosticsAvailable: boolean;
  loading: boolean;
  canRevealPath: boolean;
  onRetry: () => void;
  onCopyPath: (path: string) => void;
  onRevealPath: (path: string) => void;
}

export function SkillScanDiagnostics({ diagnostics, diagnosticsAvailable, loading, canRevealPath,
  onRetry, onCopyPath, onRevealPath }: SkillScanDiagnosticsProps) {
  const { t } = useI18n('scenes/skills');
  const { t: tCommon } = useI18n('common');
  if (diagnostics.length === 0 && diagnosticsAvailable) return null;

  return (
    <details className="skill-scan-diagnostics">
      <summary>{diagnostics.length > 0
        ? t('list.diagnostics.title', { count: diagnostics.length })
        : t('list.diagnosticsUnavailable')}</summary>
      <div className="skill-scan-diagnostics__content">
        <p>{t('list.diagnostics.description')}</p>
        {!diagnosticsAvailable && diagnostics.length > 0 && <p>{t('list.diagnosticsUnavailable')}</p>}
        <ul className="skill-scan-diagnostics__items">
          {diagnostics.map((item, index) => (
            <li key={`${item.sourceId}:${item.path}:${index}`}>
              <strong>{getEcosystemSourceLabel(item.sourceId) || t('list.item.unknownSource')}</strong>
              <code className="skill-scan-diagnostics__path">{item.path}</code>
              <p>{item.unsupportedField ? t('list.unsupportedField', { field: item.unsupportedField }) : item.message}</p>
              <div className="skill-scan-diagnostics__actions">
                <Button size="sm" variant="quiet" disabled={!item.path.trim()} onClick={() => onCopyPath(item.path)}>{tCommon('file.copyPath')}</Button>
                <Button size="sm" variant="quiet" disabled={!canRevealPath || !item.path.trim()} onClick={() => onRevealPath(item.path)}>{t('list.item.openPathInExplorer')}</Button>
              </div>
            </li>
          ))}
        </ul>
        {!canRevealPath && diagnostics.length > 0 && <p>{t('list.item.revealPathUnavailableRemote')}</p>}
        <Button size="sm" variant="outline" disabled={loading} onClick={onRetry}>{t('list.retry')}</Button>
      </div>
    </details>
  );
}
