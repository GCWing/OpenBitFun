import type { SubscriptionAccount } from '@/infrastructure/api/service-api/AIApi';

export type SubscriptionAccountState =
  | 'loading'
  | 'loadFailed'
  | 'unavailable'
  | 'vaultUnavailable'
  | 'reauthenticationRequired'
  | 'disconnected'
  | 'refreshRequired'
  | 'connected';

/** Credential presence is not proof that the current access token is valid. */
export function getSubscriptionAccountState(
  account: SubscriptionAccount | undefined,
  loading: boolean,
  loadFailed: boolean,
  now = Date.now(),
): SubscriptionAccountState {
  if (loading) return 'loading';
  if (loadFailed) return 'loadFailed';
  if (!account) return 'unavailable';
  if (account.vault_unavailable) return 'vaultUnavailable';
  if (account.reauthentication_required) return 'reauthenticationRequired';
  if (!account.connected) return 'disconnected';
  if (account.expires_at != null && account.expires_at * 1000 <= now) return 'refreshRequired';
  return 'connected';
}
