/**
 * MiniAppGalleryScene — Mini App gallery scene.
 * Opening an app opens a separate scene tab (miniapp:id).
 */
import React, { Suspense, lazy, useState } from 'react';

import { TabGroup } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { isTauriRuntime } from '@/infrastructure/runtime';
import './MiniAppGalleryScene.scss';

const MiniAppLibraryView = lazy(() => import('./views/MiniAppLibraryView'));
const MiniAppSubmissionsView = lazy(() => import('./views/MiniAppSubmissionsView'));

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

  // MiniApps run inside the desktop host (worker pool + built-in seeding live
  // there). On server/web surfaces the scene degrades loudly instead of
  // rendering an empty gallery.
  if (!isTauriRuntime()) {
    return (
      <div className="miniapp-gallery-scene" data-bf-scene="miniapp-gallery" data-bf-part="root">
        <div className="miniapp-gallery-scene__unsupported">
          <div className="miniapp-gallery-scene__unsupported-card">
            <h2 className="miniapp-gallery-scene__unsupported-title">{t('unsupported.title')}</h2>
            <p className="miniapp-gallery-scene__unsupported-body">{t('unsupported.body')}</p>
          </div>
        </div>
      </div>
    );
  }

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
