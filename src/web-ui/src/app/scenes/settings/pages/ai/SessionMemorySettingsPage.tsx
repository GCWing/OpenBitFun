import { ConfigPageSectionStack } from '@/infrastructure/config/components/common';
import { SettingsPage } from '../shared/SettingsPage';
import { useSettingsSectionAnchor } from '../shared/useSettingsSectionAnchor';
import DefaultHarnessSection from './DefaultHarnessSection';
import MemorySettingsSection from './MemorySettingsSection';
import SessionTitleSection from './SessionTitleSection';

export default function SessionMemorySettingsPage() {
  const sessionAnchor = useSettingsSectionAnchor('session');
  return (
    <SettingsPage pageId="ai.session-memory">
      <ConfigPageSectionStack id={sessionAnchor}>
        <DefaultHarnessSection />
        <SessionTitleSection />
      </ConfigPageSectionStack>
      <MemorySettingsSection />
    </SettingsPage>
  );
}
