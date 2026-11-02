import type { SettingsPageProps } from '../../settingsTypes';
import { SettingsPage } from '../shared/SettingsPage';
import DesktopCardsSettingsSection from './DesktopCardsSettingsSection';
import PetSettingsSection from './PetSettingsSection';
import RealtimeVoiceSettingsSection from './RealtimeVoiceSettingsSection';

export default function PetAssistantSettingsPage({ isActive }: SettingsPageProps) {
  return (
    <SettingsPage pageId="application.pet">
      <RealtimeVoiceSettingsSection />
      <PetSettingsSection isActive={isActive} />
      <DesktopCardsSettingsSection />
    </SettingsPage>
  );
}
