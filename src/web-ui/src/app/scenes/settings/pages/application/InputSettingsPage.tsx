import { SettingsPage } from '../shared/SettingsPage';
import KeyboardShortcutsSection from './KeyboardShortcutsSection';
import VoiceSettingsSection from './VoiceSettingsSection';

export default function InputSettingsPage() {
  return (
    <SettingsPage pageId="application.input">
      <VoiceSettingsSection />
      <KeyboardShortcutsSection />
    </SettingsPage>
  );
}
