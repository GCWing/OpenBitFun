/**
 * MiniAppGalleryScene — Mini App gallery scene.
 * Opening an app opens a separate scene tab (miniapp:id).
 */
import { lazyWithRecovery } from '@/shared/utils/lazyWithRecovery';
import React, { Suspense, useState } from 'react';

import { TabGroup } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import './MiniAppGalleryScene.scss';

const MiniAppLibraryView = lazyWithRecovery(() => import('./views/MiniAppLibraryView'));
const MiniAppSubmissionsView = lazyWithRecovery(() => import('./views/MiniAppSubmissionsView'));

type MiniAppGalleryTab = 'apps' | 'submissions';

const MiniAppGalleryScene: React.FC = () => {
  const { t } = useI18n('scenes/miniapp');
  const [activeTab, setActiveTab] = useState<MiniAppGalleryTab>('apps');
  const tabs = (
    <div className="miniapp-gallery-tabs">
    <TabGroup
      aria-label={t('title')}
      items={[
        {
          value: 'apps',
          label: t('market.tabs.apps'),
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
    </div>
  );

  return (
    <div className="miniapp-gallery-scene" data-openbitfun-scene="miniapp-gallery" data-openbitfun-part="root">
      <div className="miniapp-gallery-scene__content">
        <Suspense fallback={null}>
          {activeTab === 'apps' && <MiniAppLibraryView tabs={tabs} />}
          {activeTab === 'submissions' && <MiniAppSubmissionsView tabs={tabs} />}
        </Suspense>
      </div>
    </div>
  );
};

export default MiniAppGalleryScene;
