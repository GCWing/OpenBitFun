import { describe, expect, it } from 'vitest';
import { devicePlatform } from './useSidebarDevices';

describe('devicePlatform', () => {
  it('names the platform of reported OS strings and user agents', () => {
    expect(devicePlatform('macOS 15.1')).toBe('mac');
    expect(devicePlatform('MacIntel Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac');
    expect(devicePlatform('Windows 11')).toBe('windows');
    expect(devicePlatform('Ubuntu 24.04')).toBe('linux');
    expect(devicePlatform(null)).toBeNull();
  });
});
