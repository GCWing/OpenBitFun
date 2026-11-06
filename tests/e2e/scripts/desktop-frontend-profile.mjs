import assert from 'node:assert/strict';
import { fontProfileForDesktopTarget, normalizeWebFontProfile } from '../../../scripts/web-font-profile.mjs';

/** A standalone Web UI build is not necessarily the Desktop target's build. */
export function desktopFrontendProfile(html, { platform = process.platform, expectedProfile } = {}) {
  const marker = html.match(/data-openbitfun-font-profile=["']([^"']+)["']/)?.[1];
  assert.ok(marker, 'The frontend must declare data-openbitfun-font-profile');
  const actual = normalizeWebFontProfile(marker);
  const desktopTarget = fontProfileForDesktopTarget({ platform });
  const expected = expectedProfile ? normalizeWebFontProfile(expectedProfile) : desktopTarget;
  assert.equal(actual, expected,
    `Frontend font profile does not match this benchmark. Build with OPENBITFUN_WEB_FONT_PROFILE=${expected}; `
    + 'use OPENBITFUN_E2E_EXPECTED_FONT_PROFILE only for an explicitly reported alternate-profile diagnostic.');
  return { actual, desktopTarget, matchesDesktopTarget: actual === desktopTarget };
}
