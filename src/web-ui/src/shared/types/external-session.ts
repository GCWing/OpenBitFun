/** Source identities for imported, non-executable session history. */
export const EXTERNAL_SESSION_NAMES = {
  codex: 'Codex',
  cursor: 'Cursor',
  zcode: 'Zcode',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  pi: 'Pi',
  'deepseek-harness': 'DeepSeek Harness',
} as const;

export type ExternalSessionEcosystem = keyof typeof EXTERNAL_SESSION_NAMES;

export function isExternalSessionEcosystem(value: unknown): value is ExternalSessionEcosystem {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EXTERNAL_SESSION_NAMES, value);
}
