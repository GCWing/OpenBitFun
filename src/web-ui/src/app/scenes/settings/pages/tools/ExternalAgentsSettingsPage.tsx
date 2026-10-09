import { useSettingsStore } from '@/app/scenes/settings/settingsStore';
import type { SettingsPageProps } from '@/app/scenes/settings/settingsTypes';
import AcpAgentsConfig from '@/infrastructure/config/components/AcpAgentsConfig';
import React from 'react';

const ExternalAgentsSettingsPage: React.FC<SettingsPageProps> = ({
  viewId,
  navigationRequestId,
}) => {
  const setActiveView = useSettingsStore((state) => state.setActiveView);
  return (
    <AcpAgentsConfig
      navigationRequestId={navigationRequestId}
      onViewChange={setActiveView}
      settingsDraftEnabled
      viewId={viewId === 'ssh' || viewId === 'json' ? viewId : 'local'}
    />
  );
};

export default ExternalAgentsSettingsPage;
