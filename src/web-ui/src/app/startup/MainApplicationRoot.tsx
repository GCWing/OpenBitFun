import App from '../App';
import { WorkspaceProvider } from '@/infrastructure/contexts/WorkspaceProvider';
import { PeerDeviceProvider } from '@/infrastructure/peer-device/PeerDeviceContext';
import { PeerHostInvokeBridge } from '@/infrastructure/peer-device/PeerHostInvokeBridge';
import { PeerDirectoryPickerHost } from '@/infrastructure/peer-device/PeerDirectoryPickerHost';
import { MiniAppPresence } from '@/app/scenes/miniapps/MiniAppPresence';
import { MiniAppAgentSurface } from '@/app/scenes/miniapps/agent/MiniAppAgentSurface';

/** Loaded only by the workbench window, never by the desktop companion. */
export default function MainApplicationRoot() {
  return (
    <WorkspaceProvider>
      <PeerDeviceProvider>
        <PeerHostInvokeBridge />
        <PeerDirectoryPickerHost />
        <MiniAppPresence />
        <MiniAppAgentSurface />
        <App />
      </PeerDeviceProvider>
    </WorkspaceProvider>
  );
}
