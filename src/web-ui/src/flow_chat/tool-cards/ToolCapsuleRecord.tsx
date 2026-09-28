import { ToolCapsuleDetails } from '@openbitfun/ui/flow-chat';
import { useI18n } from '@/infrastructure/i18n';
import type { FlowToolItem } from '../types/flow-chat';

/** Mounted by the public collapse only when requested; no eager large-result serialization. */
export function ToolCapsuleRecord({ item }: { item: FlowToolItem }) {
  const { t } = useI18n('flow-chat');
  const fields = [{ label: t('toolCapsule.input'), value: JSON.stringify(item.toolCall.input, null, 2) ?? '' }];
  if (item.toolResult?.result !== undefined) {
    const result = item.toolResult.result;
    fields.push({ label: t('toolCapsule.result'), value: typeof result === 'string' ? result : JSON.stringify(result, null, 2) });
  }
  if (item.toolName === 'AgentWait' && ['running', 'streaming', 'preparing', 'waiting'].includes(item.status)) {
    fields.unshift({ label: t('toolCapsule.agents'), value: t('toolCards.agentWait.steeringHint') });
  }
  return <ToolCapsuleDetails fields={fields} error={item.toolResult?.error} />;
}
