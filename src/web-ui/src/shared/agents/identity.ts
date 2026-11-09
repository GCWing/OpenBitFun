/** Shared built-in identity contract. Legacy aliases are decoded only on input. */
export {
  HARNESS_IDS,
  canonicalAgentId,
  canonicalAgentConfigId,
  canonicalHarnessId,
  isHarnessId,
  legacyAgentWireId,
  type HarnessId,
} from '../../../../shared/agent-harness/contract.generated';

import { canonicalHarnessId } from '../../../../shared/agent-harness/contract.generated';

export type AgentKind = 'harness' | 'agent' | 'subagent';

export function primaryAgentKind(agent: { id: string; source?: string }): 'harness' | 'agent' {
  return (!agent.source || agent.source === 'builtin') && canonicalHarnessId(agent.id)
    ? 'harness'
    : 'agent';
}

const BUILTIN_NAME_KEYS: Readonly<Record<string, string>> = {
  Minimal: 'shared:agents.Minimal',
  Standard: 'shared:agents.Standard',
  Ultimate: 'shared:agents.Ultimate',
  Creative: 'shared:agents.Creative',
  Claw: 'shared:agents.Claw',
  Cowork: 'shared:agents.Cowork',
  DeepResearch: 'shared:agents.DeepResearch',
  PaperWriting: 'shared:agents.PaperWriting',
  ComputerUse: 'shared:agents.ComputerUse',
};

export function agentName(agent: { id: string; name: string; source?: string }, t: (key: string) => string): string {
  const key = (!agent.source || agent.source === 'builtin') && Object.prototype.hasOwnProperty.call(BUILTIN_NAME_KEYS, agent.id)
    ? BUILTIN_NAME_KEYS[agent.id] : undefined;
  return key ? t(key) : agent.name;
}

/** Configuration targets come from the host catalog, including capable subagents. */
export function supportsSkillConfiguration(agent: {
  source?: string;
  subagentSource?: string;
  defaultTools?: string[];
  visibility?: { showInGlobalRegistry: boolean };
}): boolean {
  return (agent.subagentSource ?? agent.source) !== 'external'
    && agent.visibility?.showInGlobalRegistry !== false
    && Boolean(agent.defaultTools?.includes('Skill'));
}
