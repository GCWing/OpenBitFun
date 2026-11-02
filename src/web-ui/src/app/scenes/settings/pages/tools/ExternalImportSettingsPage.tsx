import ExternalImportSection from '../../../ecosystem-compatibility/EcosystemCompatibilityScene';
import { SettingsPage } from '../shared/SettingsPage';

export default function ExternalImportSettingsPage() {
  return (
    <SettingsPage pageId="tools.external-import">
      <ExternalImportSection />
    </SettingsPage>
  );
}
