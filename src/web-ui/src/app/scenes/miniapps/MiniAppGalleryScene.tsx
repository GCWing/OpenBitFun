/**
 * MiniAppGalleryScene — Mini App gallery scene.
 * Installed cards offer an in-app tab or an independent window.
 */
import { lazyWithRecovery } from '@/shared/utils/lazyWithRecovery';
import React, { Suspense, useState } from 'react';

import { TabGroup } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import type { MiniAppMeta } from '@/infrastructure/api/service-api/MiniAppAPI';
import './MiniAppGalleryScene.scss';

const MiniAppLibraryView = lazyWithRecovery(() => import('./views/MiniAppLibraryView'));
const MiniAppSubmissionsView = lazyWithRecovery(() => import('./views/MiniAppSubmissionsView'));

type MiniAppGalleryTab = 'installed' | 'market' | 'submissions';

interface MiniAppGallerySceneProps {
  initialDetailApp?: MiniAppMeta;
  onDetailBack?: () => void;
  detailBackLabel?: string;
}

const MiniAppGalleryScene: React.FC<MiniAppGallerySceneProps> = ({ initialDetailApp, onDetailBack, detailBackLabel }) => {
  const { t } = useI18n('scenes/miniapp');
  const [activeTab, setActiveTab] = useState<MiniAppGalleryTab>('installed');
  const tabs = (
    <TabGroup
      className="miniapp-gallery-tabs__categories"
      aria-label={t('title')}
      items={[
        {
          value: 'installed',
          label: t('market.tabs.installed'),
        },
        {
          value: 'market',
          label: t('market.tabs.market'),
        },
        {
          value: 'submissions',
          label: t('market.tabs.submissions'),
        },
      ]}
      size="sm"
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as MiniAppGalleryTab)}
    />
  );
  const renderLibrary = (content?: React.ReactNode, toolbarActions?: React.ReactNode) => (
    <MiniAppLibraryView tabs={tabs} catalog={activeTab === 'market' ? 'market' : 'installed'} toolbarActions={toolbarActions}
      initialDetailApp={initialDetailApp} onDetailBack={onDetailBack} detailBackLabel={detailBackLabel}>
      {content}
    </MiniAppLibraryView>
  );

  return (
    <div className="miniapp-gallery-scene" data-openbitfun-scene="miniapp-gallery" data-openbitfun-part="root">
      <div className="miniapp-gallery-scene__content">
        <Suspense fallback={null}>
          {activeTab === 'submissions'
            ? <MiniAppSubmissionsView renderLayout={renderLibrary} />
            : renderLibrary()}
        </Suspense>
      </div>
    </div>
  );
};

export default MiniAppGalleryScene;
