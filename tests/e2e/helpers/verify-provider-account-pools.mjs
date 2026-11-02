import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Full native host and UI; only external vendor responses are simulated. */
export async function verifyProviderAccountPools(context) {
  const { invoke, until, readModels, reloadShell, click, send, statistics, provider, report } = context;
  const configurations = [
    ['antigravity', 'gemini-code-assist', 'gemini-3-pro-high', 'https://daily-cloudcode-pa.sandbox.googleapis.com'],
    ['grok', 'responses', 'grok-4.5', 'https://api.x.ai/v1'],
    ['hermes', 'openai', 'z-ai/glm-5.2', 'https://inference-api.nousresearch.com/v1'],
    ['opencode', 'openai', 'pool-fixture', 'https://opencode.ai/zen/v1'],
  ];
  for (const [name, format, model, baseUrl] of configurations) {
    console.log('Native provider pool: ' + name);
    const accounts = [name, name + '-account-' + randomUUID()];
    for (const [index, accountId] of accounts.entries()) {
      const sessionId = randomUUID();
      const login = await invoke('start_subscription_account_login', { provider: name, accountId, sessionId });
      if (name === 'antigravity') {
        const authorization = new URL(login.authorization_url);
        const callback = new URL(authorization.searchParams.get('redirect_uri'));
        assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname));
        callback.searchParams.set('state', authorization.searchParams.get('state'));
        callback.searchParams.set('code', 'mock-antigravity-' + (index + 1));
        await fetch(callback, { signal: AbortSignal.timeout(10_000) });
      } else {
        assert.equal(login.method, 'device');
        assert.equal(login.user_code, 'ABCD-EFGH');
      }
      await until(async () => {
        const status = await invoke('get_subscription_login_status', { provider: name, sessionId });
        if (status.status === 'failed') throw Object.assign(new Error(status.error), { fatal: true });
        return status.status === 'authorized';
      }, name + ' authorization ' + (index + 1));
    }
    const instances = (await invoke('list_subscription_account_instances')).filter(instance => instance.account.provider === name);
    assert.deepEqual(instances.map(instance => instance.upstream_account_id).sort(), [name + '-seat-1', name + '-seat-2']);
    assert.ok(instances.every(instance => instance.account.connected && instance.supports_multiple_accounts));
    const before = await statistics();
    const models = await readModels();
    const config = { ...models[0], id: 'provider-pool-' + name, name: 'Pool ' + name,
      provider: format, model_name: model, base_url: baseUrl, request_url: undefined,
      channel_routing: undefined, api_key: '', skip_ssl_verify: true,
      auth: { type: 'subscription_pool', provider: name, accounts, revision: 1 } };
    await invoke('set_config', { path: 'ai.models', expectedModels: models, value: [...models, config] });
    await invoke('set_config', { path: 'ai.default_models', value: { primary: config.id, fast: 'key-two' } });
    await reloadShell();
    const start = provider.services.requests.length;
    await click('[data-testid=nav-workspace-new-session-btn]');
    await send('PROVIDER_POOL_' + name + ': Reply briefly without using tools.', 'PROVIDER_POOL_COMPLETE');
    const actual = provider.services.requests.slice(start);
    assert.deepEqual(actual.map(request => [request.provider, request.subject, request.epoch]),
      [[name, name + '-seat-1', 0], [name, name + '-seat-1', 1], [name, name + '-seat-2', 0]],
      name + ': recover current identity once, then switch to declared backup');
    if (name === 'opencode') assert.deepEqual(actual.map(request => request.org),
      ['org-opencode-seat-1', 'org-opencode-seat-1', 'org-opencode-seat-2'], 'Catalog routes and organization headers remain account-scoped');
    assert.equal(provider.services.rotations.get(name + ':1'), 1);
    assert.equal(provider.services.rotations.get(name + ':2'), 0);
    const after = await until(async () => { const value = await statistics(); return value.totalRequests === before.totalRequests + 3 ? value : null; }, name + ' ledger commit');
    assert.equal(after.totalRequests - before.totalRequests, 3);
    const recorded = after.recentAttempts.filter(attempt => attempt.channel?.modelConfigId === config.id);
    assert.equal(recorded.length, 3);
    assert.deepEqual(recorded.sort((a, b) => a.attemptIndex - b.attemptIndex).map(attempt => JSON.parse(attempt.accountKey.slice('subscription:'.length))),
      [[name, accounts[0], name + '-seat-1'], [name, accounts[0], name + '-seat-1'], [name, accounts[1], name + '-seat-2']]);
    assert.equal(recorded.filter(attempt => attempt.outcome === 'failed').length, 2);
    assert.equal(recorded.filter(attempt => attempt.outcome === 'completed').length, 1);
    const quota = await invoke('get_subscription_account_quota', { provider: name, accountId: accounts[1], forceRefresh: true });
    assert.equal(quota.state, 'unsupported');
    await invoke('set_subscription_account_enabled', { provider: name, accountId: accounts[1], enabled: false });
    await invoke('logout_subscription_account_instance', { provider: name, accountId: accounts[1] });
    await invoke('set_subscription_account_enabled', { provider: name, accountId: accounts[1], enabled: true });
    const loggedOut = (await invoke('list_subscription_account_instances')).find(instance => instance.account_id === accounts[1]);
    assert.equal(loggedOut.account.connected, false);
    assert.equal(loggedOut.upstream_account_id, name + '-seat-2');
    const primary = (await invoke('list_subscription_account_instances')).find(instance => instance.account_id === accounts[0]);
    assert.equal(primary.account.connected, true, 'Backup logout must not affect primary');
    report.checks.push(name + ': two actual native authorizations, account-scoped refresh, native 401 recovery → quota failover, ledger, unknown allowance and independent logout');
  }
}
