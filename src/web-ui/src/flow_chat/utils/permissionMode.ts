import type { ToolPermissionConfig } from '@/infrastructure/config/types';
import type { SessionPermissionMode } from '@/infrastructure/api/service-api/AgentAPI';
import type { ChatInputPermissionMode } from '../components/ChatInputWorkspaceStrip';

/**
 * The chat input control and the backend name the same three modes slightly
 * differently: the control has carried `auto` since before the backend had a
 * single mode value, and the backend spells it `auto_approve`. These helpers
 * keep that one difference in one place instead of at every call site.
 */

type NativePermissionMode = Exclude<ChatInputPermissionMode, 'acp' | 'reject'>;

/** Backend mode -> chat input control mode. */
export function chatInputPermissionMode(mode: SessionPermissionMode): NativePermissionMode {
  return mode === 'auto_approve' ? 'auto' : mode;
}

/** Chat input control mode -> backend mode. */
export function sessionPermissionMode(mode: NativePermissionMode): SessionPermissionMode {
  return mode === 'auto' ? 'auto_approve' : mode;
}

/**
 * Derives the mode a stored configuration represents.
 *
 * Mirrors `PermissionMode::from_config`: full access already resolves every
 * ask, so it outranks the automatic approval preference. Both the legacy
 * interaction flag and the new approval strategy project to the same control.
 */
export function permissionModeFromConfig(config: ToolPermissionConfig): SessionPermissionMode {
  if (config.policy.preset === 'full_access') return 'full_access';
  return config.interaction.auto_approve_ask
    || config.approval?.strategy === 'model'
    || config.approval?.strategy === 'immediate_allow'
    ? 'auto_approve'
    : 'ask';
}

/** Projects a mode back onto the two stored configuration knobs. */
export function permissionModeToConfig(
  config: ToolPermissionConfig,
  mode: SessionPermissionMode,
): ToolPermissionConfig {
  const approval = config.approval ?? {
    strategy: 'interactive' as const,
    model_kind: 'chat' as const,
    chat_model_id: '',
    timeout_ms: 30_000,
    on_ask: 'user' as const,
    on_error: 'ask' as const,
  };
  return {
    policy: {
      ...config.policy,
      preset: mode === 'full_access' ? 'full_access' : 'ask',
    },
    interaction: {
      ...config.interaction,
      auto_approve_ask: mode === 'auto_approve',
    },
    approval: {
      ...approval,
      strategy: mode === 'auto_approve' ? 'model' : 'interactive',
    },
  };
}
