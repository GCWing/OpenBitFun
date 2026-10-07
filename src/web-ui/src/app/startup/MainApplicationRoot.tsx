import App from '../App';
import { WorkspaceProvider } from '@/infrastructure/contexts/WorkspaceProvider';
import { PeerDeviceProvider } from '@/infrastructure/peer-device/PeerDeviceContext';
import { PeerHostInvokeBridge } from '@/infrastructure/peer-device/PeerHostInvokeBridge';
import { PeerDirectoryPickerHost } from '@/infrastructure/peer-device/PeerDirectoryPickerHost';

/** Loaded only by the workbench window, never by the desktop companion. */
export default function MainApplicationRoot() {
  return (
    <WorkspaceProvider>
      <PeerDeviceProvider>
        <PeerHostInvokeBridge />
        <PeerDirectoryPickerHost />
        <App />
      </PeerDeviceProvider>
    </WorkspaceProvider>
  );
}
