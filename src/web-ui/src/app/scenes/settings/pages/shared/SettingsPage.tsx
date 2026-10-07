import {
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageLayout,
} from '@/infrastructure/config/components/common';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { getSettingsPageManifest } from '../../settingsRegistry';
import type { SettingsPageId } from '../../settingsTypes';

interface SettingsPageProps extends React.HTMLAttributes<HTMLDivElement> {
  pageId: SettingsPageId;
  children: React.ReactNode;
}

/** One header and scroll owner per settings destination; children are inline sections. */
export function SettingsPage({ pageId, children, ...props }: SettingsPageProps) {
  const { t } = useTranslation('settings');
  const page = getSettingsPageManifest(pageId);
  return (
    <ConfigPageLayout {...props}>
      <ConfigPageHeader title={t(page.labelKey)} subtitle={t(page.descriptionKey)} />
      <ConfigPageContent>{children}</ConfigPageContent>
    </ConfigPageLayout>
  );
}
