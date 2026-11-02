import { useEffect, useState } from 'react';
import { ToolCardText } from '@openbitfun/ui/flow-chat';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope } from '@/infrastructure/peer-device/deviceSurface';

const MIME_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' };

/** Reads only the explicitly bound source workspace; detached history never falls back to this host. */
export default function BuiltinImagePreview({ path, workspaceId, onResize }: {
  path: string; workspaceId?: string; onResize: () => void;
}) {
  const { t } = useI18n('flow-chat');
  const [source, setSource] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const scope = getActiveSurfaceScope();
    let cancelled = false;
    const current = () => !cancelled && scope.isCurrent();
    setSource(undefined);
    setFailed(false);
    const mime = MIME_TYPES[path.split('.').at(-1)?.toLowerCase() ?? ''];
    if (!workspaceId || !mime || /^[a-z]+:\/\//i.test(path)) { setFailed(true); return; }
    void (async () => {
      const { workspaceAPI } = await import('@/infrastructure/api/service-api/WorkspaceAPI');
      if (!current()) return;
      const metadata = await workspaceAPI.getWorkspaceFileMetadata(workspaceId, path);
      if (!current()) return;
      if (!metadata.isFile || metadata.size > 20 * 1024 * 1024) throw new Error('Image exceeds inline preview limits');
      const bytes = await workspaceAPI.readWorkspaceFile(workspaceId, path, 'base64');
      if (current()) setSource(`data:${mime};base64,${bytes}`);
    })().catch(() => { if (current()) setFailed(true); });
    return () => { cancelled = true; };
  }, [path, workspaceId]);
  useEffect(onResize, [source, failed, onResize]);
  return <>
    <ToolCardText variant="prose">{t(failed ? 'toolCards.builtin.imageUnavailable'
      : source ? 'toolCards.builtin.imageCurrent' : 'toolCards.builtin.imageLoading')}</ToolCardText>
    {source && !failed && <img src={source} alt={path} loading="lazy" onLoad={onResize} onError={() => setFailed(true)} />}
  </>;
}
