import { describe, expect, it } from 'vitest';
import { formatSkillDetailPath } from './skillDetailPath';

describe('Skill detail path presentation', () => {
  it('keeps complete directories around the omission in the reported Windows path', () => {
    expect(formatSkillDetailPath(String.raw`C:\Users\HUAWEI\AppData\Roaming\openbitfun\skills\.system\agent-browser`))
      .toBe(String.raw`C:\Users\HUAWEI\…\.system\agent-browser`);
  });

  it('preserves a remote POSIX root and complete trailing directory names', () => {
    expect(formatSkillDetailPath('/home/alex/.config/openbitfun/skills/.system/create-openbitfun-skin'))
      .toBe('/home/alex/.config/…/.system/create-openbitfun-skin');
  });

  it('preserves the UNC prefix and trailing separator', () => {
    expect(formatSkillDetailPath('\\\\server\\share\\team\\tools\\openbitfun\\skills\\agent-browser\\'))
      .toBe('\\\\server\\share\\team\\…\\skills\\agent-browser\\');
  });

  it.each(['', '/', 'C:\\', 'C:\\skills\\agent-browser', '/home/alex/skills/agent-browser'])(
    'leaves a short path unchanged: %s',
    path => expect(formatSkillDetailPath(path)).toBe(path),
  );
});
