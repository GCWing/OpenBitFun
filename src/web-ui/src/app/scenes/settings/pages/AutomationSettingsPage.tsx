import { lazyWithRecovery } from '@/shared/utils/lazyWithRecovery';
import { ScrollArea } from '@openbitfun/ui';
import React, { Suspense, useEffect, useRef } from 'react';
import type { SettingsPageProps } from '../settingsTypes';
import './AutomationSettingsPage.scss';

const QuickActionsConfig = lazyWithRecovery(() => import('@/infrastructure/config/components/QuickActionsConfig'));
const HooksConfig = lazyWithRecovery(() => import('@/infrastructure/config/components/HooksConfig'));

function AutomationSettingsLoading() {
  return (
    <div className="openbitfun-automation-settings-page__loading" aria-busy="true" aria-hidden="true">
      <span />
      <span />
      <span className="openbitfun-automation-settings-page__loading-block" />
    </div>
  );
}

const AutomationSettingsPage: React.FC<SettingsPageProps> = ({ viewId, navigationRequestId }) => {
  const quickActionsSectionRef = useRef<HTMLElement>(null);
  const hooksSectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const target = viewId === 'hooks' ? hooksSectionRef.current : quickActionsSectionRef.current;
    target?.scrollIntoView?.({ block: 'start' });
  }, [navigationRequestId, viewId]);

  return (
    <ScrollArea
      className="openbitfun-automation-settings-page"
      data-openbitfun-component="automation-settings-page"
      data-openbitfun-part="root"
    >
      <section
        ref={quickActionsSectionRef}
        className="openbitfun-automation-settings-page__section"
        data-openbitfun-component="automation-settings-page"
        data-openbitfun-part="quickActions"
      >
        <Suspense fallback={<AutomationSettingsLoading />}>
          <QuickActionsConfig />
        </Suspense>
      </section>
      <section
        ref={hooksSectionRef}
        className="openbitfun-automation-settings-page__section openbitfun-automation-settings-page__section--hooks"
        data-openbitfun-component="automation-settings-page"
        data-openbitfun-part="hooks"
      >
        <Suspense fallback={<AutomationSettingsLoading />}>
          <HooksConfig />
        </Suspense>
      </section>
    </ScrollArea>
  );
};

export default AutomationSettingsPage;
