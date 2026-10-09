import { SettingsPage } from '../shared/SettingsPage';
import HooksSettingsSection from './HooksSettingsSection';
import QuickActionsSettingsSection from './QuickActionsSettingsSection';

export default function AutomationSettingsPage() {
  return (
    <SettingsPage pageId="tools.automation" data-openbitfun-component="automation-settings-page" data-openbitfun-part="root">
      <div data-openbitfun-component="automation-settings-page" data-openbitfun-part="quickActions">
        <QuickActionsSettingsSection />
      </div>
      <div data-openbitfun-component="automation-settings-page" data-openbitfun-part="hooks">
        <HooksSettingsSection />
      </div>
    </SettingsPage>
  );
}
