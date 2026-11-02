import { REMOTE_CAPABILITY_DEVICE_MODEL_DEFAULTS_V1 } from '../../model/RemoteModels';

/**
 * Entry rules for the device model settings page.
 *
 * The page reads and writes the desktop the phone is driving right now, so the
 * entry belongs to that row and to no other: an offline row has no link to
 * answer with, and an online desktop this phone is not connected to would
 * promise a read the client cannot perform. Capability, link and row identity
 * are decided here together so the row, its badge and its reason line can never
 * disagree.
 */
export class DeviceModelSettingsEntryPolicy {
  /** One-line reason shown when the degraded entry is tapped. */
  static readonly DEGRADE_REASON_KEY: string = 'settings.model.unsupported';

  /** The host advertises the device model defaults command. */
  static supportsDeviceModelDefaults(capabilities: string[]): boolean {
    return (capabilities || []).indexOf(REMOTE_CAPABILITY_DEVICE_MODEL_DEFAULTS_V1) >= 0;
  }

  /** Whether the device row carries the entry at all. */
  static showsEntry(
    online: boolean,
    deviceId: string,
    phoneDeviceId: string,
    controlTargetDeviceId: string,
    connectionState: string
  ): boolean {
    return DeviceModelSettingsEntryPolicy.isDrivenTarget(
      deviceId, phoneDeviceId, controlTargetDeviceId, connectionState
    ) && online;
  }

  /** Whether the entry opens the page. */
  static entryEnabled(supportsDeviceModelDefaults: boolean): boolean {
    return supportsDeviceModelDefaults;
  }

  /**
   * The corner badge for an older desktop: the entry stays visible so the user
   * learns why it is unavailable, and is greyed rather than silently missing.
   */
  static showsUpgradeBadge(showsEntry: boolean, supportsDeviceModelDefaults: boolean): boolean {
    return showsEntry && !supportsDeviceModelDefaults;
  }

  /** The reason line to show, or an empty string when the entry is usable. */
  static degradeReasonKey(showsEntry: boolean, supportsDeviceModelDefaults: boolean): string {
    return DeviceModelSettingsEntryPolicy.showsUpgradeBadge(showsEntry, supportsDeviceModelDefaults) ?
      DeviceModelSettingsEntryPolicy.DEGRADE_REASON_KEY : '';
  }

  /** The desktop this phone is connected to and controlling, by row identity. */
  private static isDrivenTarget(
    deviceId: string,
    phoneDeviceId: string,
    controlTargetDeviceId: string,
    connectionState: string
  ): boolean {
    return deviceId.length > 0 &&
      deviceId !== phoneDeviceId &&
      deviceId === controlTargetDeviceId &&
      connectionState === 'connected';
  }
}
