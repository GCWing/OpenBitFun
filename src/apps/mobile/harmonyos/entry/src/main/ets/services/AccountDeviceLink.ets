export const OFFICIAL_RELAY_URL: string = 'https://remote.openbitfun.com/v/1.0.2';
export interface AccountDeviceLink { relayUrl: string; deviceId: string; }

export function normalizeAccountRelayUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '');
  if (normalized === OFFICIAL_RELAY_URL) return normalized;
  const match = /^(https?:\/\/)(localhost|\[[0-9a-fA-F:]+\]|[0-9.]+)(?::([0-9]{1,5}))?$/.exec(normalized);
  if (!match) return '';
  if (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535)) return '';
  const host = match[2].toLowerCase();
  const octets = host.split('.').map((part: string): number => Number(part));
  const local = host === 'localhost' || host === '[::1]' ||
    /^\[(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(host) ||
    (octets.length === 4 && octets.every((part: number): boolean => Number.isInteger(part) && part >= 0 && part <= 255) &&
      (octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 169 && octets[1] === 254)));
  return local ? normalized : '';
}

/** Endpoint and target are hints; the account directory is the authority. */
export function accountDeviceLink(value: string): AccountDeviceLink | undefined {
  const text = value.trim();
  if (text.length > 8192) return undefined;
  const parts = text.split('/#/pair?did=');
  if (parts.length !== 2) return undefined;
  const relayUrl = normalizeAccountRelayUrl(parts[0]);
  let deviceId = '';
  try { deviceId = decodeURIComponent(parts[1]); } catch (_error) { return undefined; }
  if (!relayUrl || !/^[A-Za-z0-9_.-]{1,128}$/.test(deviceId) || deviceId === '.' || deviceId === '..') return undefined;
  return { relayUrl, deviceId };
}
