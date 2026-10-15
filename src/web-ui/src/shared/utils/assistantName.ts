import { i18nService } from '@/infrastructure/i18n';

interface AssistantNameFacts {
  name?: string;
  defaultNameNumber?: number | null;
  identity?: { name?: string | null } | null;
}

/** The host proves default-name provenance. Custom strings are never rewritten. */
export function resolveAssistantName(workspace: AssistantNameFacts | null | undefined, assistantLabel?: string): string {
  const identityName = workspace?.identity?.name?.trim();
  if (identityName) return identityName;
  const number = workspace?.defaultNameNumber;
  const label = () => assistantLabel ?? i18nService.t('shared:agents.Claw');
  if (typeof number === 'number' && Number.isSafeInteger(number) && number > 0) {
    return number === 1 ? label() : `${label()} ${i18nService.formatNumber(number, { useGrouping: false })}`;
  }
  return workspace?.name?.trim() || label();
}
