import { expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { formatInstallPathError, parseInstallPathErrorCode } from './installPathErrors';

it('preserves the recovery diagnosis when its nested cause is access denied', () => {
  const raw = 'Recovery failed: access is denied (os error 5); backup preserved at C:\\OpenBitFun\\.openbitfun-maintenance';
  const t = ((key: string) => key) as TFunction;
  expect(parseInstallPathErrorCode(raw)).toBeNull();
  expect(formatInstallPathError(raw, t)).toBe('errors.maintenance.recovery');
  expect(formatInstallPathError('Update installed, but cleanup remains pending: access is denied (os error 5)', t))
    .toBe('errors.maintenance.cleanupPending');
  expect(parseInstallPathErrorCode('Access is denied (os error 5)')).toBe('directory_not_writable');
});
