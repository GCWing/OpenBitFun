import { Folder as LucideFolder, X as LucideX, Monitor, Server, ChevronDown } from 'lucide-react';
import React, { useEffect, useState, useCallback } from 'react';
import { MobileBanner, MobileButton, MobileTextField, MobileIconButton, MobileListRow, MobilePageHeader, MobileStatus, MobileChoiceSheet } from '@openbitfun/ui/mobile';
import './WorkspacePage.scss';
import { WorkspaceTerminal } from '../components/WorkspaceTerminal';
import { WorkspaceFolderPicker } from '../components/WorkspaceFolderPicker';
import { WorkspaceFiles } from '../components/WorkspaceFiles';
import { useI18n } from '../i18n';
import { useMobileStore } from '../services/store';
import {
  RemoteSessionManager,
  WorkspaceInfo,
  RecentWorkspaceEntry,
} from '../services/RemoteSessionManager';
import { describeRemoteError } from '../services/remoteErrorPresentation';
import { sameWorkspace, workspaceIdentityKey } from '../services/workspaceIdentity';

interface WorkspacePageProps {
  sessionMgr: RemoteSessionManager;
  tool?: { workspace: RecentWorkspaceEntry; panel: 'files' | 'terminal' };
  onReady: () => void;
  onBack?: () => void;
}

const WorkspacePage: React.FC<WorkspacePageProps> = ({ sessionMgr, onReady, onBack, tool }) => {
  const { t } = useI18n();
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo | null>(null);
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [choosingHost, setChoosingHost] = useState(false);
  const panel = tool?.panel ?? 'workspaces';
  const [path, setPath] = useState('');
  const [remoteConnectionId, setRemoteConnectionId] = useState('');
  const [connections, setConnections] = useState<Array<{ id: string; name: string }>>([]);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controlTarget = useMobileStore((state) => state.controlTarget);

  const loadWorkspaceInfo = useCallback(async () => {
    try {
      const info = await sessionMgr.getWorkspaceInfo();
      setWorkspaceInfo(info);
    } catch (e: any) {
      setError(describeRemoteError(e, t));
    }
  }, [sessionMgr, t]);

  const loadRecentWorkspaces = useCallback(async () => {
    try {
      const list = await sessionMgr.listRecentWorkspaces();
      setRecentWorkspaces(list);
    } catch (e: any) {
      setError(describeRemoteError(e, t));
    }
  }, [sessionMgr, t]);

  useEffect(() => {
    if (tool) {
      setWorkspaceInfo({ ...tool.workspace, has_workspace: true, project_name: tool.workspace.name });
      setLoading(false);
      return;
    }
    setLoading(true);
    void Promise.all([loadWorkspaceInfo(), loadRecentWorkspaces()]).finally(() => setLoading(false));
    void sessionMgr.invokeHost<Array<{ id: string; name: string }>>('ssh_list_saved_connections', {}, false).then(setConnections).catch(cause => setError(String(cause)));
  }, [loadRecentWorkspaces, loadWorkspaceInfo, tool]);

  const handleSelectWorkspace = useCallback(async (workspace: RecentWorkspaceEntry) => {
    if (switching) return;
    setSwitching(true);
    setError(null);
    try {
      const result = await sessionMgr.setWorkspace(workspace);
      if (result.success) {
        await loadWorkspaceInfo();
        onReady();
      } else {
        setError(result.error || t('workspace.failedToSetWorkspace'));
      }
    } catch (e: any) {
      setError(describeRemoteError(e, t));
    } finally {
      setSwitching(false);
    }
  }, [loadWorkspaceInfo, onReady, sessionMgr, switching, t]);

  if (loading) {
    return (
      <div className="workspace-page workspace-page--tools">
        <MobileStatus className="workspace-page__loading" loading title={t('workspace.loadingInfo')} />
      </div>
    );
  }

  return (
    <div className="workspace-page workspace-page--tools">
      <div className="workspace-page__sheet">
        <MobilePageHeader
          className="workspace-page__header"
          title={t(panel === 'files' ? 'workspace.files' : panel === 'terminal' ? 'workspace.terminal' : 'workspace.selectWorkspace')}
          subtitle={tool ? `${tool.workspace.name} · ${tool.workspace.path}` : undefined}
          actions={onBack ? (
            <MobileIconButton
              appearance="surface"
              className="workspace-page__close"
              icon={<LucideX stroke="currentColor" aria-hidden="true" />}
              onClick={onBack}
              size="sm"
              aria-label={t('common.close')}
            />
          ) : undefined}
        />

        {choosingFolder && <WorkspaceFolderPicker key={`${sessionMgr.controlTargetEpoch}:${remoteConnectionId}`}
          manager={sessionMgr} remoteConnectionId={remoteConnectionId || undefined}
          initialPath={path.trim() || (workspaceInfo?.remote_connection_id === (remoteConnectionId || undefined) ? workspaceInfo?.path : undefined) || '/'}
          location={connections.find(connection => connection.id === remoteConnectionId)?.name ?? controlTarget?.deviceName ?? undefined}
          onSelect={value => {setPath(value);setChoosingFolder(false);}} onClose={() => setChoosingFolder(false)}/>}
        <MobileChoiceSheet open={choosingHost} onOpenChange={() => setChoosingHost(false)} title={t('workspace.location')}
          selectedValue={remoteConnectionId} cancelLabel={t('common.cancel')}
          options={[{value: '', label: controlTarget?.deviceName, leading: <Monitor size={18}/>}, ...connections.map(connection => ({value: connection.id, label: connection.name, leading: <Server size={18}/>}))]}
          onSelect={value => {setRemoteConnectionId(value);setChoosingHost(false);}}/>
        <div className="workspace-page__divider" />
        <div className={`workspace-page__content workspace-tools-content${panel === 'terminal' ? ' workspace-tools-content--terminal' : ''}`}>
          <div className="workspace-picker" hidden={panel !== 'workspaces'}>
          <form className="workspace-picker__open" onSubmit={(event) => {
            event.preventDefault();
            if (path.trim()) void handleSelectWorkspace({ path: path.trim(), name: path.trim(), last_opened: '', remote_connection_id: remoteConnectionId || undefined });
          }}>
            <div className="workspace-picker__label">{t('workspace.location')}
              <MobileListRow className="workspace-picker__location" appearance="plain" disabled={switching} onClick={() => setChoosingHost(true)}
                leading={remoteConnectionId ? <Server size={18}/> : <Monitor size={18}/>}
                label={connections.find(connection => connection.id === remoteConnectionId)?.name ?? controlTarget?.deviceName}
                trailing={<ChevronDown size={16}/>}/>
            </div>
            <div className="workspace-picker__label">{t('workspace.targetPath')}
              <MobileTextField className="workspace-picker__path-field" aria-label={t('workspace.targetPath')} placeholder="/" value={path} onChange={event => setPath(event.target.value)} disabled={switching}
                trailing={<MobileIconButton size="sm" appearance="plain" aria-label={t('workspace.chooseFolder')} icon={<LucideFolder size={20}/>}
                  disabled={switching} onClick={() => setChoosingFolder(true)}/>}/>
            </div>
            <p>{t('workspace.targetPathHint')}</p>
            <MobileButton className="workspace-picker__submit" appearance="primary" type="submit" disabled={switching || !path.trim()}>{t('workspace.openPath')}</MobileButton>
          </form>
          <h2 className="workspace-picker__section-title">{t('workspace.recentWorkspaces')}</h2>
          {recentWorkspaces.length === 0 ? (
            <MobileStatus className="workspace-page__recent-empty" description={t('workspace.noRecentWorkspaces')} />
          ) : (
            <div className="workspace-page__recent-list">
              {recentWorkspaces.map((ws) => {
                // Identity comparison: IDs when both sides carry one, the legacy
                // triple only for rows from pre-ID hosts.
                const selected = workspaceInfo?.has_workspace ? sameWorkspace(workspaceInfo, ws) : false;
                return (
                  <MobileListRow
                    key={workspaceIdentityKey(ws)}
                    appearance="plain"
                    className={`workspace-page__recent-item${selected ? ' is-selected' : ''}`}
                    onClick={() => handleSelectWorkspace(ws)}
                    disabled={switching}
                    selected={selected}
                    leading={<span className="workspace-page__recent-item-icon" aria-hidden="true">
                      <LucideFolder width="22" height="22" stroke="currentColor" aria-hidden="true" />
                    </span>}
                    label={<span className="workspace-page__recent-item-name">{ws.name}</span>}
                    supportingText={<span className="workspace-page__recent-item-path">{ws.path}</span>}
                    trailing={<span className="workspace-page__recent-item-trailing" aria-hidden="true">{selected ? '✓' : '›'}</span>}
                  />
                );
              })}
            </div>
          )}
          </div>
          {panel === 'files' && workspaceInfo?.has_workspace && (workspaceInfo.workspace_kind !== 'remote' || !!workspaceInfo.remote_connection_id) && <div hidden={panel !== 'files'}><WorkspaceFiles manager={sessionMgr} workspace={workspaceInfo} /></div>}
          {panel === 'terminal' && workspaceInfo?.has_workspace && (workspaceInfo.workspace_kind !== 'remote' || !!workspaceInfo.remote_connection_id) && <div className="workspace-terminal-panel" hidden={panel !== 'terminal'}><WorkspaceTerminal key={`${sessionMgr.controlTargetEpoch}:${workspaceInfo.remote_connection_id}:${workspaceInfo.path}`} manager={sessionMgr} workspace={workspaceInfo} /></div>}
          {switching && <MobileStatus className="workspace-page__switching" loading />}
          {error && <MobileBanner className="workspace-page__error" tone="danger">{error}</MobileBanner>}
        </div>
      </div>
    </div>
  );
};

export default WorkspacePage;
