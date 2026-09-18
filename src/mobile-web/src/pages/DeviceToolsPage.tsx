import React, { useEffect, useState } from 'react';
import { ChevronDown, Files, Monitor, Server, TerminalSquare, X } from 'lucide-react';
import { MobileBanner, MobileButton, MobileChoiceSheet, MobileIconButton, MobileListRow, MobilePageHeader, MobileStatus } from '@openbitfun/ui/mobile';
import { WorkspaceFiles } from '../components/WorkspaceFiles';
import { WorkspaceTerminal } from '../components/WorkspaceTerminal';
import type { RemoteSessionManager } from '../services/RemoteSessionManager';
import { useMobileStore } from '../services/store';
import { useI18n } from '../i18n';
import './WorkspacePage.scss';
import { useControlTargetEpoch } from '../hooks/useControlTargetEpoch';

/** Device locations are filesystem providers, independent of the runtime's workspace catalog. */
export default function DeviceToolsPage({ manager, onBack }: { manager: RemoteSessionManager; onBack: () => void }) {
  const { t } = useI18n();
  const deviceName = useMobileStore(state => state.controlTarget?.deviceName);
  const targetEpoch = useControlTargetEpoch(manager);
  const [home, setHome] = useState<string>();
  const [connections, setConnections] = useState<Array<{id: string; name: string}>>([]);
  const [connection, setConnection] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [panel, setPanel] = useState('files');
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    setHome(undefined); setError(undefined); setConnection('');
    void Promise.all([
      manager.invokeHost<{homeDir?: string}>('get_system_info', {}, false),
      manager.invokeHost<Array<{id: string; name: string}>>('ssh_list_saved_connections', {}, false),
    ]).then(([system, saved]) => {
      if (!active) return;
      if (!system.homeDir) throw new Error('The controlled device did not provide its home directory');
      setHome(system.homeDir.replace(/\\/g, '/')); setConnections(saved);
    }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [manager, targetEpoch]);
  const location = { workspace_id: undefined, path: connection ? '/' : home, remote_connection_id: connection };
  return <div className="workspace-page workspace-page--tools device-tools-page"><div className="workspace-page__sheet">
    <MobilePageHeader className="workspace-page__header" title={t('workspace.tools')}
      actions={<MobileIconButton size="sm" appearance="surface" icon={<X/>} aria-label={t('common.close')} onClick={onBack}/>}/>
    <div className="workspace-page__navigation">
      <MobileListRow className="device-tools-page__location" appearance="plain" label={connections.find(item => item.id === connection)?.name ?? deviceName}
        leading={connection ? <Server size={18}/> : <Monitor size={18}/>} trailing={<ChevronDown size={16}/>}
        onClick={() => setChoosing(true)}/>
      <div className="device-tools-page__tabs" role="tablist" aria-label={t('workspace.tools')}>
        <MobileButton appearance="plain" role="tab" aria-selected={panel === 'files'} leading={<Files size={18}/>} onClick={() => setPanel('files')}>{t('workspace.files')}</MobileButton>
        <MobileButton appearance="plain" role="tab" aria-selected={panel === 'terminal'} leading={<TerminalSquare size={18}/>} onClick={() => setPanel('terminal')}>{t('workspace.terminal')}</MobileButton>
      </div>
    </div>
    <MobileChoiceSheet open={choosing} onOpenChange={() => setChoosing(false)} title={t('workspace.location')}
      selectedValue={connection} cancelLabel={t('common.cancel')}
      options={[{value: '', label: deviceName, leading: <Monitor size={18}/>}, ...connections.map(item => ({value:item.id,label:item.name,leading:<Server size={18}/>}))]}
      onSelect={value => {setConnection(value);setChoosing(false);}}/>
    <div className={`workspace-page__content workspace-tools-content${panel === 'terminal' ? ' workspace-tools-content--terminal' : ''}`}>
      {error ? <MobileBanner tone="danger">{error}</MobileBanner> : !home ? <MobileStatus loading title={t('common.loading')}/> :
        <React.Fragment key={`${targetEpoch}:${connection}`}>
          <div hidden={panel !== 'files'}><WorkspaceFiles manager={manager} workspace={location}/></div>
          <div className="workspace-terminal-panel" hidden={panel !== 'terminal'}><WorkspaceTerminal manager={manager} workspace={location}/></div>
        </React.Fragment>}
    </div>
  </div></div>;
}
