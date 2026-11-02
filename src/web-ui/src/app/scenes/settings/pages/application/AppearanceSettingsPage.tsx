import '@/app/scenes/settings/pages/application/AppearanceSettingsPage.scss';
import { AppearancePackageConfigSection } from '@/infrastructure/config/components/AppearancePackageConfigSection';
import {
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
  ConfigPageSectionStack
} from '@/infrastructure/config/components/common';
import { FontPreferencePanel } from '@/infrastructure/font-preference';
import SessionPanelSettingsSection from './SessionPanelSettingsSection';
import FlowChatWidthSettingsSection from './FlowChatWidthSettingsSection';
import SidebarSettingsSection from './SidebarSettingsSection';
import React from 'react';
import { useTranslation } from 'react-i18next';

const AppearanceSettingsPage: React.FC = () => {
  const { t } = useTranslation('settings/appearance');

  return (
    <ConfigPageLayout
      className="openbitfun-appearance-settings"
      data-openbitfun-component="appearance-settings"
      data-openbitfun-part="root"
    >
      <ConfigPageHeader title={t('title')} />
      <ConfigPageContent
        className="openbitfun-appearance-settings__content"
        data-openbitfun-component="appearance-settings"
        data-openbitfun-part="content"
      >
        <ConfigPageSectionStack data-testid="appearance-settings">
          <AppearancePackageConfigSection />
          <FontPreferencePanel />
          <SidebarSettingsSection />
          <FlowChatWidthSettingsSection />
          <SessionPanelSettingsSection />
        </ConfigPageSectionStack>
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default AppearanceSettingsPage;
