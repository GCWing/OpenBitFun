import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopFrontendProfile } from './desktop-frontend-profile.mjs';

const html = profile => `<html lang="zh-CN" data-openbitfun-font-profile="${profile}">`;
test('native benchmarks reject a generic web build for an Apple Desktop target', () => {
  assert.throws(() => desktopFrontendProfile(html('harmony-bundled'), { platform: 'darwin' }), /does not match/);
  assert.deepEqual(desktopFrontendProfile(html('apple-system'), { platform: 'darwin' }),
    { actual: 'apple-system', desktopTarget: 'apple-system', matchesDesktopTarget: true });
  assert.equal(desktopFrontendProfile(html('harmony-bundled'), { platform: 'win32' }).matchesDesktopTarget, true);
  assert.equal(desktopFrontendProfile(html('harmony-bundled'), { platform: 'linux' }).matchesDesktopTarget, true);
});
test('alternate profiles require explicit selection and remain labelled as different from Desktop', () => {
  assert.equal(desktopFrontendProfile(html('harmony-bundled'), {
    platform: 'darwin', expectedProfile: 'harmony-bundled',
  }).matchesDesktopTarget, false);
  assert.throws(() => desktopFrontendProfile('<html>', { platform: 'darwin' }), /must declare/);
  assert.throws(() => desktopFrontendProfile(html('unknown')), /Unsupported/);
});
