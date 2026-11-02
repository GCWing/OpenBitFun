import { describe, expect, it } from 'vitest';
import en from '../../locales/en-US/flow-chat.json';
import zh from '../../locales/zh-CN/flow-chat.json';
import tw from '../../locales/zh-TW/flow-chat.json';
import { resolveSubagentNameKey, SUBAGENT_NAME_KEYS } from './nameResolver';

describe('localized subagent names', () => {
  it('provides exactly 30 distinct identities in every supported language', () => {
    expect(SUBAGENT_NAME_KEYS).toHaveLength(30);
    expect(new Set(SUBAGENT_NAME_KEYS).size).toBe(30);
    for (const catalog of [en, zh, tw]) {
      const names = catalog.subagentIdentity.names;
      expect(Object.keys(names)).toHaveLength(30);
      expect(new Set(Object.values(names)).size).toBe(30);
      for (const key of SUBAGENT_NAME_KEYS) {
        expect(names[key.split('.').at(-1) as keyof typeof names].trim()).not.toBe('');
      }
    }
  });

  it('keeps a restored session identity independent of locale and lookup order', () => {
    expect(resolveSubagentNameKey('child-session')).toBe('subagentIdentity.names.cloudHopper');
    resolveSubagentNameKey('another-session');
    expect(resolveSubagentNameKey(' child-session ')).toBe('subagentIdentity.names.cloudHopper');
    expect(zh.subagentIdentity.names.cloudHopper).not.toBe(en.subagentIdentity.names.cloudHopper);
    expect(resolveSubagentNameKey('   ')).toBe(SUBAGENT_NAME_KEYS[0]);
  });
});
