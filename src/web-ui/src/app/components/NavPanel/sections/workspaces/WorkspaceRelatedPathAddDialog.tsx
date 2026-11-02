import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Alert, Button, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader,
  DialogHeading, DialogTitle, Field, Icon, Input, Textarea } from '@openbitfun/ui';
import { FolderOpen } from 'lucide-react';
import { useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { useI18n } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { sshApi } from '@/features/ssh-remote/sshApi';
import RemoteFileBrowser from '@/features/ssh-remote/RemoteFileBrowser';
import { isRemoteWorkspace, type RelatedPath, type WorkspaceInfo } from '@/shared/types';
import './WorkspaceRelatedPathsDialog.scss';

export function WorkspaceRelatedPathAddDialog({ workspace, isOpen, onClose, onAdd }: {
  workspace: WorkspaceInfo;
  isOpen: boolean;
  onClose: () => void;
  /** The directory manager stages additions until its existing Save action. */
  onAdd?: (directory: RelatedPath) => void;
}) {
  const { t } = useI18n('common');
  const { updateWorkspaceRelatedPaths } = useWorkspaceContext();
  const activeScope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const ownerScope = useRef(activeScope).current;
  const latest = useRef({ workspace, isOpen });
  latest.current = { workspace, isOpen };
  const generation = useRef(0);
  const pending = useRef(false);
  const formId = useId();
  const [path, setPath] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [homePath, setHomePath] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const remote = isRemoteWorkspace(workspace);
  const connectionId = workspace.connectionId?.trim();
  const busy = saving || selecting;

  useEffect(() => {
    generation.current += 1;
    pending.current = false;
    setPath(''); setDescription(''); setError(null); setSaving(false); setSelecting(false); setBrowsing(false);
    return () => { generation.current += 1; };
  }, [isOpen, workspace.id, workspace.rootPath, connectionId]);

  useEffect(() => {
    setHomePath(undefined);
    if (!isOpen || !remote || !connectionId || !ownerScope.isCurrent()) return;
    let cancelled = false;
    void sshApi.getServerInfo(connectionId).then(info => {
      if (!cancelled && ownerScope.isCurrent()) setHomePath(info?.homeDir?.trim() || undefined);
    }).catch(() => { /* The explicit project root remains a usable browsing start. */ });
    return () => { cancelled = true; };
  }, [connectionId, isOpen, ownerScope, remote]);

  const current = (version: number) => generation.current === version && ownerScope.isCurrent()
    && latest.current.isOpen && latest.current.workspace.id === workspace.id;
  const close = () => { if (!busy && ownerScope.isCurrent()) onClose(); };
  const chooseDirectory = async () => {
    if (busy || !ownerScope.isCurrent()) return;
    if (remote) { if (connectionId) setBrowsing(true); return; }
    const version = generation.current;
    setSelecting(true);
    setError(null);
    try {
      const { pickWorkspaceDirectory } = await import('@/infrastructure/peer-device/pickWorkspaceDirectory');
      if (!current(version)) return;
      const selected = await pickWorkspaceDirectory({
        title: t('nav.workspaces.relatedPaths.dialog.selectDirectoryTitle'), defaultPath: path || workspace.rootPath,
      });
      if (current(version) && selected?.trim()) setPath(selected);
    } catch {
      if (current(version)) setError(t('nav.workspaces.relatedPaths.messages.selectFailed'));
    } finally {
      if (current(version)) setSelecting(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const version = generation.current;
    if (pending.current || busy || !current(version) || !path.trim()) return;
    const directory: RelatedPath = { path: path.trim(), ...(description.trim() ? { description: description.trim() } : {}) };
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      if (onAdd) onAdd(directory);
      else await updateWorkspaceRelatedPaths(workspace.id, [...(latest.current.workspace.relatedPaths ?? []), directory]);
      if (current(version)) onClose();
    } catch (failure) {
      if (current(version)) setError(failure instanceof Error ? failure.message : t('nav.workspaces.relatedPaths.messages.saveFailed'));
    } finally {
      if (generation.current === version) pending.current = false;
      if (current(version)) setSaving(false);
    }
  };

  return <Dialog open={isOpen && ownerScope === activeScope} onOpenChange={open => { if (!open) close(); }} size="md">
    <DialogHeader>
      <DialogHeading>
        <DialogTitle>{t('nav.workspaces.relatedPaths.dialog.add')}</DialogTitle>
        {remote && <DialogDescription>{t('nav.workspaces.relatedPaths.dialog.remoteScope', {
          connectionName: workspace.connectionName || workspace.name,
        })}</DialogDescription>}
      </DialogHeading>
      <DialogClose aria-label={t('actions.close')} disabled={busy} />
    </DialogHeader>
    <DialogBody>
      <form id={formId} className="workspace-related-paths-dialog__add-form" onSubmit={event => void submit(event)}
        data-openbitfun-component="workspace-related-paths-dialog" data-openbitfun-part="addForm">
        <Field label={t('nav.workspaces.relatedPaths.dialog.pathPlaceholder')} controlWidth="fill"
          controlTrailing={<Button variant="outline" size="sm" leadingIcon={<Icon glyph={FolderOpen} size="sm" />}
            onClick={() => void chooseDirectory()} disabled={busy || (remote && !connectionId)} loading={selecting}>{t('actions.select')}</Button>}>
          <Input value={path} onChange={event => { setPath(event.target.value); setError(null); }} size="sm" autoFocus disabled={busy} />
        </Field>
        <Field label={t('nav.workspaces.relatedPaths.dialog.descriptionLabel')} controlWidth="fill">
          <Textarea value={description} onChange={event => setDescription(event.target.value)} disabled={busy}
            layout="fill" resize="none" rows={3} variant="outlined" />
        </Field>
        {error && <Alert tone="error" message={error} />}
      </form>
    </DialogBody>
    <DialogFooter>
      <Button variant="fill" size="sm" onClick={close} disabled={busy}>{t('actions.cancel')}</Button>
      <Button type="submit" form={formId} variant="primary" size="sm" disabled={busy || !path.trim()} loading={saving}>
        {t('nav.workspaces.relatedPaths.dialog.add')}
      </Button>
    </DialogFooter>
    {remote && connectionId && browsing && <RemoteFileBrowser connectionId={connectionId} initialPath={path || workspace.rootPath}
      homePath={homePath} selectDirectoriesOnly onSelect={selected => {
        if (!ownerScope.isCurrent()) return;
        setPath(selected); setBrowsing(false); setError(null);
      }} onCancel={() => setBrowsing(false)} />}
  </Dialog>;
}
