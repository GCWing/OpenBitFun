import { Suspense } from 'react';
import { Dialog, DialogBody, DialogClose, DialogHeader, DialogHeaderActions, DialogTitle, ScrollArea } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { lazyWithRecovery } from '@/shared/utils/lazyWithRecovery';
import { AccountIdentityControls } from '@/features/market-account';
import '@/app/scenes/settings/pages/application/AppearanceSettingsPage.scss';
import '@/app/scenes/miniapps/MiniAppGalleryScene.scss';

const MiniAppSubmissionsView = lazyWithRecovery(() => import('@/app/scenes/miniapps/views/MiniAppSubmissionsView'));
const AppearanceMarketWorkflows = lazyWithRecovery(() => import('@/infrastructure/config/components/AppearanceMarketWorkflows')
  .then(module => ({ default: module.AppearanceMarketWorkflows })));

/** Reuse the account's existing submission workspace; opening it never resubmits a tool. */
export default function BuiltinMarketDialog({ kind, open, onClose, onExited }: {
  kind: 'miniapps' | 'appearance'; open: boolean; onClose: () => void; onExited: () => void;
}) {
  const { t } = useI18n('flow-chat');
  return <Dialog open={open} onOpenChange={open => { if (!open) onClose(); }} onExitComplete={onExited} size="2xl">
    <DialogHeader>
      <DialogTitle>{t('toolCards.builtin.links.openSubmissions')}</DialogTitle>
      <DialogHeaderActions><AccountIdentityControls /><DialogClose /></DialogHeaderActions>
    </DialogHeader>
    <DialogBody><ScrollArea><Suspense fallback={t('toolCards.default.executing')}>
      {kind === 'miniapps' ? <div className="miniapp-gallery-scene" data-openbitfun-scene="miniapp-gallery" data-openbitfun-part="root">
        <div className="miniapp-gallery-scene__content"><MiniAppSubmissionsView /></div>
      </div> : <div className="appearance-market" data-openbitfun-component="appearance-settings" data-openbitfun-part="marketDialog">
        <AppearanceMarketWorkflows workflow="submissions" />
      </div>}
    </Suspense></ScrollArea></DialogBody>
  </Dialog>;
}
