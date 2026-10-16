import { Button, Icon, IconButton, MenuPopover, Tooltip } from '@openbitfun/ui';
import { MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import { miniAppPresentationAPI } from '@/infrastructure/api/service-api/MiniAppPresentationAPI';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { useMiniAppSystemInstallation } from '../hooks/useMiniAppSystemInstallation';
import { MiniAppActionTooltip } from './MiniAppActionTooltip';

interface MiniAppSystemAppActionsProps {
  app: MiniAppMeta;
  workspacePath?: string | null;
  supported: boolean;
  compact?: boolean;
}

/** Export management is separate from deleting the app or stopping its work. */
export function MiniAppSystemAppActions({ app, workspacePath, supported, compact = false }: MiniAppSystemAppActionsProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const { t } = useI18n('scenes/miniapp');
  const systemInstallation = useMiniAppSystemInstallation(supported);
  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const current = generation.current;
    const scope = getActiveSurfaceScope();
    setPaths([]);
    setError(false);
    setLoading(supported);
    if (!supported) return;
    void miniAppPresentationAPI.installation(app.id).then(result => {
      if (current === generation.current && scope.isCurrent()) setPaths(result.paths);
    }).catch(() => {
      if (current === generation.current && scope.isCurrent()) setError(true);
    }).finally(() => {
      if (current === generation.current && scope.isCurrent()) setLoading(false);
    });
    return () => { generation.current++; };
  }, [app.id, supported, revision]);

  const mutate = async (remove: boolean) => {
    if (!supported || pending.current || loading || error) return;
    pending.current = true;
    setBusy(true);
    const current = generation.current;
    const scope = getActiveSurfaceScope();
    try {
      if (remove) {
        const removed = await systemInstallation.uninstall(app);
        if (!removed || current !== generation.current || !scope.isCurrent()) return;
        setPaths([]);
      } else {
        const result = await systemInstallation.install(app, workspacePath, paths.length > 0);
        if (!result || current !== generation.current || !scope.isCurrent()) return;
        setPaths([result.path]);
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  if (compact) {
    const label = t('presentation.moreActions');
    return <>
      <MiniAppActionTooltip content={label}>
        <IconButton ref={anchorRef} size="xs" aria-label={label} aria-expanded={menuOpen} aria-haspopup="menu"
          icon={<Icon glyph={MoreHorizontal} size="sm" />} onClick={() => setMenuOpen(value => !value)} />
      </MiniAppActionTooltip>
      <MenuPopover anchorRef={anchorRef} open={menuOpen} onClose={() => setMenuOpen(false)} aria-label={label}
        items={error ? [{ id: 'retry', label: t('presentation.retryInstallation'), onSelect: () => setRevision(value => value + 1) }] : [
          { id: 'install', label: paths.length ? t('presentation.updateInstallation') : t('presentation.install'),
            disabled: !supported || loading || busy, onSelect: () => void mutate(false) },
          ...(paths.length ? [{ id: 'uninstall', label: t('presentation.uninstall'), disabled: busy || !supported, onSelect: () => void mutate(true) }] : []),
        ]} />
    </>;
  }
  if (error) return <Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>
    {t('presentation.retryInstallation')}
  </Button>;
  return <>
    <Tooltip content={t('presentation.unsupported')} disabled={supported}>
      <Button variant="outline" size="sm" disabled={!supported || loading || busy} onClick={() => void mutate(false)}>
        {paths.length ? t('presentation.updateInstallation') : t('presentation.install')}
      </Button>
    </Tooltip>
    {paths.length > 0 && <Tooltip content={t('presentation.uninstallHint')}>
      <Button variant="outline" size="sm" disabled={busy || !supported} onClick={() => void mutate(true)}>
        {t('presentation.uninstall')}
      </Button>
    </Tooltip>}
  </>;
}
