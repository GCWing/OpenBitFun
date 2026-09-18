import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { FilePlus, FolderPlus, List, RotateCw } from 'lucide-react';
import {
  Icon, IconButton, NavigationPanel, NavigationPanelBody, NavigationPanelContent,
  NavigationPanelHeader, OverflowText, StatusPill, Tooltip,
} from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { getWorkspaceDisplayName, useWorkspaceContext } from '@/infrastructure/contexts/WorkspaceContext';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';
import { globalEventBus } from '@/infrastructure/event-bus';
import type { FileExplorerToolbarHandlers } from '@/tools/file-system';
import { isTerminalPathInside } from '@/tools/terminal/services/terminalWorkspaceScope';
import type { ShellInfo } from '@/tools/terminal/types/session';
import { getTerminalService } from '@/tools/terminal/services/TerminalService';
import FilesPanel from '../../components/panels/FilesPanel';
import TerminalEditModal from '../../components/panels/TerminalEditModal';
import { useShellEntries } from '../shell/hooks';
import { DEFAULT_RESOURCE_LAYOUT, useWorkspaceResourceState } from './workspaceResourceState';
import WorkspaceTerminals from './WorkspaceTerminals';
import { useResourceSplit } from './useResourceSplit';
import { showResourceMenu } from './resourceMenus';
import { resolveResourceWorkspace, useNavSceneStore } from '../../stores/navSceneStore';
import type { WorkspaceInfo } from '@/shared/types';
import '../file-viewer/FileViewerNav.scss';

export default function WorkspaceResourcePanel() {
  const { activeWorkspace, openedWorkspaces } = useWorkspaceContext();
  const target = useNavSceneStore(state => state.resourceWorkspace);
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const workspace = resolveResourceWorkspace(target, scope.surfaceId, openedWorkspaces, activeWorkspace);
  // Persisted layout and search state are keyed by (surface, workspace ID) only.
  const resourceKey = scope.key('workspace-resources', workspace?.id);
  const migrateLayout = useWorkspaceResourceState(state => state.migrateLayout);
  useEffect(() => {
    if (!workspace) return;
    migrateLayout(
      scope.key('workspace-resources', workspace.connectionId, workspace.id, workspace.rootPath),
      resourceKey,
    );
  }, [migrateLayout, resourceKey, scope, workspace]);
  return <WorkspaceResourceContent key={resourceKey} resourceKey={resourceKey} workspace={workspace} />;
}

function WorkspaceResourceContent({ resourceKey, workspace }: { resourceKey: string; workspace: WorkspaceInfo | null }) {
  const { t, formatNumber } = useI18n('common');
  const { t: tFiles } = useI18n('panels/files');
  const { t: tTools } = useI18n('tools');
  const { openedWorkspacesList } = useWorkspaceContext();
  const openWorkspaceResources = useNavSceneStore(state => state.openWorkspaceResources);
  const scope = getActiveSurfaceScope();
  const terminals = useShellEntries(workspace);
  const layout = useWorkspaceResourceState(state => state.layouts[resourceKey] ?? DEFAULT_RESOURCE_LAYOUT);
  const updateLayout = useWorkspaceResourceState(state => state.updateLayout);
  const [toolbar, setToolbar] = useState<FileExplorerToolbarHandlers | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedTerminal, setSelectedTerminal] = useState<string | null>(null);
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const container = useRef<HTMLDivElement>(null);
  const filesId = useId();
  const terminalsId = useId();
  const split = useResourceSplit(container, layout.terminalFraction, fraction => updateLayout(resourceKey, { terminalFraction: fraction }));
  const hasTerminalContent = terminals.entries.length > 0 || Boolean(terminals.error || actionError);
  const showSplit = !layout.filesCollapsed && !layout.terminalsCollapsed && hasTerminalContent;
  const isRemote = workspace?.workspaceKind === 'remote';

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (isRemote) return;
    let cancelled = false;
    void getTerminalService().getAvailableShells().then(items => {
      if (!cancelled && scope.isCurrent()) setShells(items.filter(item => item.available));
    }).catch(() => { /* Default terminal creation reports errors through the action surface. */ });
    return () => { cancelled = true; };
  }, [isRemote, scope]);
  const run = useCallback((action: () => void | Promise<unknown>) => {
    if (busyRef.current || !mounted.current || !scope.isCurrent()) return;
    busyRef.current = true;
    setBusy(true);
    setActionError(null);
    void Promise.resolve().then(() => {
      if (mounted.current && scope.isCurrent()) return action();
    }).catch(error => {
      if (mounted.current && scope.isCurrent()) {
        setActionError(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    });
  }, [scope]);
  const revealDirectory = useCallback((path: string) => {
    if (!mounted.current || !scope.isCurrent()) return;
    updateLayout(resourceKey, { filesCollapsed: false, fileView: 'tree' });
    setPendingReveal(path);
  }, [resourceKey, scope, updateLayout]);
  useEffect(() => {
    if (!pendingReveal || layout.filesCollapsed || layout.fileView !== 'tree') return;
    globalEventBus.emit('file-explorer:navigate', { path: pendingReveal, scrollIntoView: true });
    setPendingReveal(null);
  }, [pendingReveal, layout.filesCollapsed, layout.fileView]);

  const workspaceName = getWorkspaceDisplayName(workspace);
  const location = isRemote ? workspace?.connectionName || workspace?.sshHost || t('nav.resources.remote')
    : scope.surfaceId === 'local' ? t('nav.resources.local') : t('nav.resources.peer');
  const error = actionError || terminals.error;
  const createTerminal = (shellType?: string, shellId?: string) => run(async () => {
    updateLayout(resourceKey, { terminalsCollapsed: false });
    await terminals.createManualTerminal(shellType, undefined, shellId);
  });

  return (
    <NavigationPanel className="openbitfun-file-viewer-nav" aria-label={t('nav.resources.title')}
      data-openbitfun-component="file-viewer-nav" data-openbitfun-part="root" data-testid="workspace-resources">
      <NavigationPanelHeader className="openbitfun-file-viewer-nav__panel-header">
        <div className="openbitfun-file-viewer-nav__workspace" data-openbitfun-component="file-viewer-nav" data-openbitfun-part="workspace">
          <button type="button" data-overflow-trigger className="openbitfun-file-viewer-nav__workspace-button"
            data-openbitfun-component="file-viewer-nav" data-openbitfun-part="workspaceButton"
            disabled={openedWorkspacesList.length < 2 || busy} aria-haspopup="menu"
            aria-label={t('nav.resources.switchWorkspace')}
            onClick={event => showResourceMenu(event, openedWorkspacesList.map(item => ({
              id: item.id, label: getWorkspaceDisplayName(item), icon: item.id === workspace?.id ? 'Check' : 'Folder',
              onClick: () => openWorkspaceResources(item.id),
            })))}>
            <Icon name="folder" size="sm" />
            <OverflowText className="openbitfun-file-viewer-nav__workspace-name">{workspaceName || t('nav.resources.title')}</OverflowText>
            {openedWorkspacesList.length > 1 && <Icon name="chevron-down" size="xs" />}
          </button>
          {workspace && <span className="openbitfun-file-viewer-nav__location" data-overflow-trigger title={location}
            data-openbitfun-component="file-viewer-nav" data-openbitfun-part="location">
            <StatusPill tone="neutral">{location}</StatusPill>
          </span>}
        </div>
      </NavigationPanelHeader>
      <NavigationPanelBody className="openbitfun-file-viewer-nav__body">
        <NavigationPanelContent className="openbitfun-file-viewer-nav__content">
          {!workspace || (isRemote && !workspace.connectionId)
            ? <p className="openbitfun-file-viewer-nav__empty">{workspace ? t('nav.resources.unavailable') : tFiles('empty.selectWorkspace')}</p> : (
            <div ref={container} className="openbitfun-file-viewer-nav__sections"
              data-openbitfun-component="file-viewer-nav" data-openbitfun-part="sections">
              <section className="openbitfun-file-viewer-nav__section" aria-label={t('nav.resources.files')}
                style={{ flex: layout.filesCollapsed ? '0 0 auto' : showSplit ? `${1 - split.fraction} 1 0` : '1 1 0' }}>
                <div className="openbitfun-file-viewer-nav__header" data-openbitfun-component="file-viewer-nav" data-openbitfun-part="header">
                  <button type="button" data-overflow-trigger className="openbitfun-file-viewer-nav__section-toggle" aria-expanded={!layout.filesCollapsed}
                    aria-controls={filesId} onClick={() => updateLayout(resourceKey, { filesCollapsed: !layout.filesCollapsed })}>
                    <Icon name={layout.filesCollapsed ? 'chevron-right' : 'chevron-down'} size="xs" />
                    <OverflowText className="openbitfun-file-viewer-nav__section-label">{t('nav.resources.files')}</OverflowText>
                  </button>
                  <div className="openbitfun-file-viewer-nav__actions" data-openbitfun-component="file-viewer-nav" data-openbitfun-part="actions">
                    {layout.fileView === 'tree' && toolbar && <>
                      <Tooltip content={tTools('fileTree.newFile')}><IconButton size="xs" aria-label={tTools('fileTree.newFile')} icon={<FilePlus />} onClick={toolbar.onNewFile} /></Tooltip>
                      <Tooltip content={tTools('fileTree.newFolder')}><IconButton size="xs" aria-label={tTools('fileTree.newFolder')} icon={<FolderPlus />} onClick={toolbar.onNewFolder} /></Tooltip>
                      <Tooltip content={tTools('fileTree.refresh')}><IconButton size="xs" aria-label={tTools('fileTree.refresh')} icon={<RotateCw />} onClick={toolbar.onRefresh} /></Tooltip>
                    </>}
                    <Tooltip content={layout.fileView === 'tree' ? tFiles('actions.switchToSearch') : tFiles('actions.switchToTree')}>
                      <IconButton size="xs" aria-label={layout.fileView === 'tree' ? tFiles('actions.switchToSearch') : tFiles('actions.switchToTree')}
                        icon={layout.fileView === 'tree' ? <Icon name="search" size="xs" /> : <List />}
                        onClick={() => updateLayout(resourceKey, { filesCollapsed: false, fileView: layout.fileView === 'tree' ? 'search' : 'tree' })} />
                    </Tooltip>
                  </div>
                </div>
                <div id={filesId} hidden={layout.filesCollapsed} className="openbitfun-file-viewer-nav__section-body">
                  <FilesPanel workspace={workspace} workspacePath={workspace.rootPath} searchStateKey={resourceKey} hideHeader hideExplorerToolbar onExplorerToolbarApi={setToolbar}
                    viewMode={layout.fileView} onViewModeChange={fileView => updateLayout(resourceKey, { fileView })} />
                </div>
              </section>
              {showSplit && <div className="openbitfun-file-viewer-nav__divider" role="separator" tabIndex={0}
                data-openbitfun-component="file-viewer-nav" data-openbitfun-part="divider"
                aria-label={t('nav.resources.resize')} aria-orientation="horizontal" aria-controls={terminalsId}
                aria-valuemin={15} aria-valuemax={75} aria-valuenow={Math.round(split.fraction * 100)}
                {...split.handlers} />}
              <section className="openbitfun-file-viewer-nav__section openbitfun-file-viewer-nav__section--terminals" aria-label={t('nav.resources.terminals')}
                style={{ flex: layout.terminalsCollapsed || !hasTerminalContent ? '0 0 auto' : showSplit ? `${split.fraction} 1 0` : '1 1 0' }}>
                <div className="openbitfun-file-viewer-nav__header" data-openbitfun-component="file-viewer-nav" data-openbitfun-part="header">
                  <button type="button" data-overflow-trigger className="openbitfun-file-viewer-nav__section-toggle" aria-expanded={!layout.terminalsCollapsed}
                    aria-controls={terminalsId} onClick={() => updateLayout(resourceKey, { terminalsCollapsed: !layout.terminalsCollapsed })}>
                    <Icon name={layout.terminalsCollapsed ? 'chevron-right' : 'chevron-down'} size="xs" />
                    <OverflowText className="openbitfun-file-viewer-nav__section-label">{t('nav.resources.terminals')}</OverflowText>
                    {terminals.entries.length > 0 && <span className="openbitfun-file-viewer-nav__count">{formatNumber(terminals.entries.length)}</span>}
                  </button>
                  <div className="openbitfun-file-viewer-nav__actions" data-openbitfun-component="file-viewer-nav" data-openbitfun-part="actions">
                    <Tooltip content={t('nav.shell.actions.refresh')}><IconButton size="xs" aria-label={t('nav.shell.actions.refresh')} icon={<RotateCw />}
                      disabled={busy || terminals.loading} onClick={() => run(terminals.refresh)} /></Tooltip>
                    <Tooltip content={t('nav.shell.actions.newTerminal')}><IconButton size="xs" aria-label={t('nav.shell.actions.newTerminal')} icon={<Icon name="plus" size="xs" />}
                      disabled={busy} onClick={() => createTerminal()} /></Tooltip>
                    {!isRemote && shells.length > 1 && <IconButton size="xs" aria-label={t('nav.resources.chooseShell')} aria-haspopup="menu"
                      icon={<Icon name="chevron-down" size="xs" />} disabled={busy}
                      onClick={event => showResourceMenu(event, shells.map(shell => ({
                        id: shell.id, label: shell.version ? `${shell.name} ${shell.version}` : shell.name,
                        onClick: () => createTerminal(shell.shellType, shell.id),
                      })))} />}
                  </div>
                </div>
                <div id={terminalsId} hidden={layout.terminalsCollapsed} className="openbitfun-file-viewer-nav__section-body">
                  {error && <div className="openbitfun-file-viewer-nav__error" role="alert" title={error}
                    data-openbitfun-component="file-viewer-nav" data-openbitfun-part="error">
                    <span>{actionError ? t('nav.resources.actionFailed', { error: actionError }) : t('nav.resources.unavailable')}</span>
                    <IconButton size="xs" aria-label={t('nav.shell.actions.refresh')} icon={<RotateCw />} disabled={busy}
                      onClick={() => run(terminals.refresh)} />
                  </div>}
                  <WorkspaceTerminals terminals={terminals} busy={busy} selectedId={selectedTerminal} onSelect={setSelectedTerminal}
                    run={run} onReveal={revealDirectory}
                    canReveal={path => isTerminalPathInside(path, workspace.rootPath, isRemote)} />
                </div>
              </section>
            </div>
          )}
        </NavigationPanelContent>
      </NavigationPanelBody>
      <TerminalEditModal isOpen={terminals.editModalOpen} onClose={terminals.closeEditModal}
        onSave={terminals.saveEdit}
        initialName={terminals.editingTerminal?.entry.name ?? ''}
        initialWorkingDirectory={terminals.editingTerminal?.entry.workingDirectory ?? terminals.editingTerminal?.entry.cwd}
        initialStartupCommand={terminals.editingTerminal?.entry.startupCommand} />
    </NavigationPanel>
  );
}
