import { SettingsPage } from '../shared/SettingsPage';
import KeyboardShortcutsSection from './KeyboardShortcutsSection';
import VoiceSettingsSection from './VoiceSettingsSection';
import TextSelectionSettingsSection from './TextSelectionSettingsSection';

export default function InputSettingsPage() {
  return (
    <SettingsPage pageId="application.input">
      <TextSelectionSettingsSection />
      <VoiceSettingsSection />
      <KeyboardShortcutsSection />
    </SettingsPage>
  );
}
