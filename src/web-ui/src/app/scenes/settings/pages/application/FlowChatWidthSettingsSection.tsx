import { useStore } from 'zustand';
import { Button, NumberInput } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { ConfigPageRow, ConfigPageSection } from '@/infrastructure/config/components/common';
import { DEFAULT_FLOW_CHAT_WIDTH, MIN_FLOW_CHAT_WIDTH, flowChatWidthStore } from '@/infrastructure/appearance/preferences/flowChatWidthStore';

export default function FlowChatWidthSettingsSection() {
  const { t } = useI18n('settings/appearance');
  const width = useStore(flowChatWidthStore, state => state.preferredWidth);
  const setWidth = useStore(flowChatWidthStore, state => state.setPreferredWidth);

  return (
    <ConfigPageSection id="flow-chat-width" title={t('contentWidth.title')}
      extra={<Button size="sm" variant="quiet" disabled={width === DEFAULT_FLOW_CHAT_WIDTH}
        onClick={() => setWidth(DEFAULT_FLOW_CHAT_WIDTH)}>{t('contentWidth.reset')}</Button>}>
      <ConfigPageRow label={t('contentWidth.label')} description={t('contentWidth.description', { min: MIN_FLOW_CHAT_WIDTH })} align="center">
        <NumberInput size="sm" variant="stepper" unit="px" step={10} min={MIN_FLOW_CHAT_WIDTH}
          value={width} onValueChange={setWidth} aria-label={t('contentWidth.label')}
          decrementLabel={t('contentWidth.decrease')} incrementLabel={t('contentWidth.increase')} />
      </ConfigPageRow>
    </ConfigPageSection>
  );
}
