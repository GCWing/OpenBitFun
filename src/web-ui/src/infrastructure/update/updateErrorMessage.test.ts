import { expect, it } from 'vitest';
import { formatUpdateInstallError } from './updateErrorMessage';

it('preserves certificate errors even when the transport includes network error keywords', () => {
  expect(formatUpdateInstallError('reqwest connection failed: TLS certificate expired', key => key)).toBe('update.errors.tls');
  expect(formatUpdateInstallError('connection timed out', key => key)).toBe('update.errors.network');
});
