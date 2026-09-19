import { describe, expect, it } from 'vitest';
import { isNewerAppVersion, normalizeAppUpdateResult } from './appUpdateVersion';

describe('application update version precedence', () => {
  it.each([
    ['1.0.1', '1.0.1', false],
    ['1.0.0', '1.0.1', false],
    ['1.0.1-rc.1', '1.0.1', false],
    ['1.0.1+release', '1.0.1+local', false],
    ['1.0.2', '1.0.1', true],
    ['1.10.0', '1.9.0', true],
    ['1.0.1', '1.0.1-rc.1', true],
    ['1.0.1-rc.10', '1.0.1-rc.2', true],
    ['1.0.1-rc.2', '1.0.1-rc.10', false],
    ['invalid', '1.0.1', false],
    ['1.0.2', null, false],
  ])('compares %s against installed %s as %s', (candidate, installed, expected) => {
    expect(isNewerAppVersion(candidate, installed)).toBe(expected);
  });

  it('removes release details when the advertised release is already installed', () => {
    expect(normalizeAppUpdateResult({
      updateAvailable: true, currentVersion: '1.0.1', latestVersion: '1.0.1',
      releaseNotes: 'Old announcement', releaseDate: '2026-09-01',
    })).toEqual({
      updateAvailable: false, currentVersion: '1.0.1', latestVersion: null,
      releaseNotes: null, releaseDate: null,
    });
  });

  it('rejects mismatched host versions and malformed available versions', () => {
    const response = {
      updateAvailable: true, currentVersion: '1.0.1', latestVersion: '1.0.2',
      releaseNotes: null, releaseDate: null,
    };
    expect(() => normalizeAppUpdateResult(response, '1.0.2')).toThrow('different application version');
    expect(() => normalizeAppUpdateResult({ ...response, latestVersion: 'invalid' })).toThrow('invalid release version');
  });
});
