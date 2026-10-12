import { configManager } from './ConfigManager';

export const SEND_DURING_TURN_CONFIG_PATH = 'app.flow_chat.send_during_turn';
export type ChatInputSendDuringTurn = 'immediate' | 'queue';

export function normalizeChatInputSendDuringTurn(value: unknown): ChatInputSendDuringTurn {
  return value === 'queue' ? 'queue' : 'immediate';
}

/** Optional reads distinguish an older host's missing field from a failed read. */
export async function getChatInputSendDuringTurn(): Promise<ChatInputSendDuringTurn> {
  return normalizeChatInputSendDuringTurn(await configManager.getOptionalConfig(SEND_DURING_TURN_CONFIG_PATH));
}
