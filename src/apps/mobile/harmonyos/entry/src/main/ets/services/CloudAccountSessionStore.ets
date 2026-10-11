import { GitHubAccountProfile, readCachedGitHubProfile } from './GitHubAccountProfile';
import { huks } from '@kit.UniversalKeystoreKit';
import { preferences } from '@kit.ArkData';
import { Encoding } from './Encoding';
import { HarmonyUpgradeIdentityContract } from './HarmonyUpgradeIdentityContract';
import { OhosError } from './OhosError';
import { RemoteLogger } from './RemoteLogger';

const STORE_NAME: string = HarmonyUpgradeIdentityContract.CLOUD_ACCOUNT_STORE;
const CIPHER_KEY: string = 'github_device_session_v1_cipher';
const IV_KEY: string = 'github_device_session_v1_iv';
const HUKS_ALIAS: string = HarmonyUpgradeIdentityContract.CLOUD_ACCOUNT_HUKS_ALIAS;

export interface PersistedCloudAccountSession {
  relayUrl: string;
  username: string;
  token: string;
  userId: string;
  masterKey: string;
  targetDeviceId?: string;
  targetDeviceName?: string;
}

export interface PersistedWatchProvisionIdentity {
  relayUrl: string;
  userId: string;
  deviceId: string;
  requestId: string;
  privateKeyBase64: string;
}

/** Persists only an HUKS-encrypted account session, never plaintext secrets. */
export class CloudAccountSessionStore {
  private store?: preferences.Preferences;
  private deviceKeyWork?: Promise<Uint8Array>;

  async init(context: Context): Promise<void> {
    try {
      this.store = await preferences.getPreferences(context, STORE_NAME);
    } catch (err) {
      throw OhosError.wrap('cloud account session init', err);
    }
  }

  async deviceSecret(): Promise<Uint8Array> {
    if (!this.deviceKeyWork) this.deviceKeyWork = this.loadOrCreateDeviceSecret();
    try { return new Uint8Array(await this.deviceKeyWork); }
    catch (err) { this.deviceKeyWork = undefined; throw OhosError.wrap('device identity', err); }
  }

  private async loadOrCreateDeviceSecret(): Promise<Uint8Array> {
    const value = await this.readSealed('device_private_key_v1_cipher', 'device_private_key_v1_iv');
    if (value) {
      const secret = Encoding.base64ToBytes(value);
      if (secret.length !== 32) throw new Error('Stored device identity is invalid.');
      return secret;
    }
    const previous = await this.load();
    const secret = previous ? Encoding.base64ToBytes(previous.masterKey) : Encoding.randomBytes(32);
    if (secret.length !== 32) throw new Error('Stored device identity is invalid.');
    try {
      await this.writeSealed('device_private_key_v1_cipher', 'device_private_key_v1_iv', Encoding.bytesToBase64(secret));
    } catch (err) {
      // A reinstall clears Preferences but HarmonyOS may retain the HUKS alias.
      // Only rotate the alias when there is no prior session record: existing
      // encrypted account data must never be made unreadable as recovery.
      if (previous) throw err instanceof Error ? err : new Error(OhosError.reason(err));
      RemoteLogger.warn('cloud account device identity write failed on fresh install; recreating local key');
      await this.recreateKeyForFreshInstall();
      await this.writeSealed('device_private_key_v1_cipher', 'device_private_key_v1_iv', Encoding.bytesToBase64(secret));
    }
    return secret;
  }

  private async recreateKeyForFreshInstall(): Promise<void> {
    try {
      await huks.deleteKeyItem(HUKS_ALIAS, {});
    } catch (err) {
      const message = OhosError.reason(err);
      if (message.indexOf('12000011') < 0 && message.indexOf('-13') < 0 &&
        message.toLowerCase().indexOf('does not exist') < 0) {
        throw err instanceof Error ? err : new Error(OhosError.reason(err));
      }
    }
    await this.ensureKey();
  }

  async loadProfile(userId: string): Promise<GitHubAccountProfile | undefined> {
    const text = await this.readSealed(`github_profile_${userId}_v1_cipher`, `github_profile_${userId}_v1_iv`);
    return readCachedGitHubProfile(userId, text || '');
  }

  async saveProfile(profile: GitHubAccountProfile): Promise<void> {
    await this.writeSealed(`github_profile_${profile.userId}_v1_cipher`, `github_profile_${profile.userId}_v1_iv`, JSON.stringify(profile));
  }

  async save(session: PersistedCloudAccountSession): Promise<void> {
    await this.writeSealed(CIPHER_KEY, IV_KEY, JSON.stringify(session));
  }

  async loadWatchProvisionIdentity(relayUrl: string, userId: string,
    deviceId: string): Promise<PersistedWatchProvisionIdentity | undefined> {
    const key = this.watchProvisionKey(relayUrl, userId, deviceId);
    const text = await this.readSealed(`${key}_cipher`, `${key}_iv`);
    if (!text) return undefined;
    const identity = JSON.parse(text) as PersistedWatchProvisionIdentity;
    if (identity.relayUrl !== relayUrl || identity.userId !== userId || identity.deviceId !== deviceId ||
      !identity.requestId || Encoding.base64ToBytes(identity.privateKeyBase64).length !== 32) {
      throw new Error('Stored watch provisioning identity is invalid.');
    }
    return identity;
  }

  async saveWatchProvisionIdentity(identity: PersistedWatchProvisionIdentity): Promise<void> {
    const key = this.watchProvisionKey(identity.relayUrl, identity.userId, identity.deviceId);
    await this.writeSealed(`${key}_cipher`, `${key}_iv`, JSON.stringify(identity));
  }

  private watchProvisionKey(relayUrl: string, userId: string, deviceId: string): string {
    return `watch_provision_v1_${encodeURIComponent(relayUrl)}_${encodeURIComponent(userId)}_${deviceId}`;
  }

  private async writeSealed(cipherKey: string, ivKey: string, plaintext: string): Promise<void> {
    try {
      const store = this.requireStore();
      await this.ensureKey();
      const iv = Encoding.randomBytes(16);
      const options = this.options(huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT, iv);
      const handle = await huks.initSession(HUKS_ALIAS, options);
      const encrypted = await huks.finishSession(handle.handle, {
        properties: options.properties,
        inData: Encoding.utf8ToBytes(plaintext)
      });
      if (!encrypted.outData || encrypted.outData.length === 0) {
        throw new Error('Cloud account session encryption failed.');
      }
      await store.put(cipherKey, Encoding.bytesToBase64(encrypted.outData));
      await store.put(ivKey, Encoding.bytesToBase64(iv));
      await store.flush();
    } catch (err) {
      throw OhosError.wrap('cloud account session save', err);
    }
  }

  async load(): Promise<PersistedCloudAccountSession | undefined> {
    const text = await this.readSealed(CIPHER_KEY, IV_KEY);
    return text ? JSON.parse(text) as PersistedCloudAccountSession : undefined;
  }

  private async readSealed(cipherKey: string, ivKey: string): Promise<string | undefined> {
    try {
      const store = this.requireStore();
      const cipher = await store.get(cipherKey, '');
      const ivText = await store.get(ivKey, '');
      if (typeof cipher !== 'string' || typeof ivText !== 'string' || cipher.length === 0 || ivText.length === 0) {
        return undefined;
      }
      const iv = Encoding.base64ToBytes(ivText);
      const options = this.options(huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT, iv);
      const handle = await huks.initSession(HUKS_ALIAS, options);
      const decrypted = await huks.finishSession(handle.handle, {
        properties: options.properties,
        inData: Encoding.base64ToBytes(cipher)
      });
      if (!decrypted.outData) {
        return undefined;
      }
      return Encoding.bytesToUtf8(decrypted.outData);
    } catch (err) {
      throw OhosError.wrap('cloud account session load', err);
    }
  }

  async clear(): Promise<void> {
    try {
      const store = this.requireStore();
      await store.delete(CIPHER_KEY);
      await store.delete(IV_KEY);
      await store.flush();
    } catch (err) {
      throw OhosError.wrap('cloud account session clear', err);
    }
  }

  private async ensureKey(): Promise<void> {
    if (await this.keyItemExists()) {
      return;
    }
    try {
      await huks.generateKeyItem(HUKS_ALIAS, {
        properties: [
          { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
          { tag: huks.HuksTag.HUKS_TAG_KEY_SIZE, value: huks.HuksKeySize.HUKS_AES_KEY_SIZE_256 },
          { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_ENCRYPT | huks.HuksKeyPurpose.HUKS_KEY_PURPOSE_DECRYPT },
          { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_CBC },
          { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_PKCS7 }
        ]
      });
    } catch (err) {
      throw OhosError.wrap('cloud account session generate key', err);
    }
  }

  private async keyItemExists(): Promise<boolean> {
    try {
      return await huks.isKeyItemExist(HUKS_ALIAS, {});
    } catch (err) {
      const message = err instanceof Error ? err.message : JSON.stringify(err);
      if (message.indexOf('12000011') >= 0 || message.indexOf('-13') >= 0 ||
        message.toLowerCase().indexOf('does not exist') >= 0) {
        return false;
      }
      throw new Error(message || 'HUKS key lookup failed.');
    }
  }

  private options(purpose: huks.HuksKeyPurpose, iv: Uint8Array): huks.HuksOptions {
    return {
      properties: [
        { tag: huks.HuksTag.HUKS_TAG_ALGORITHM, value: huks.HuksKeyAlg.HUKS_ALG_AES },
        { tag: huks.HuksTag.HUKS_TAG_PURPOSE, value: purpose },
        { tag: huks.HuksTag.HUKS_TAG_BLOCK_MODE, value: huks.HuksCipherMode.HUKS_MODE_CBC },
        { tag: huks.HuksTag.HUKS_TAG_PADDING, value: huks.HuksKeyPadding.HUKS_PADDING_PKCS7 },
        { tag: huks.HuksTag.HUKS_TAG_IV, value: iv }
      ]
    };
  }

  private requireStore(): preferences.Preferences {
    if (!this.store) {
      throw new Error('Cloud account session store is not initialized.');
    }
    return this.store;
  }
}
