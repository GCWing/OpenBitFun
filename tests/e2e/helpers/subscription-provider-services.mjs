export const SUBSCRIPTION_FIXTURE_HOSTS = ['auth.openai.com', 'chatgpt.com', 'oauth2.googleapis.com', 'www.googleapis.com',
    'daily-cloudcode-pa.sandbox.googleapis.com', 'cloudcode-pa.googleapis.com', 'autopush-cloudcode-pa.sandbox.googleapis.com', 'antigravity-auto-updater-974169037036.us-central1.run.app',
    'antigravity.google', 'auth.x.ai', 'api.x.ai', 'portal.nousresearch.com',
    'inference-api.nousresearch.com', 'opencode.ai', 'models.opencode.ai'];

/** Simulates only external services. Account selection remains in native code. */
export function subscriptionProviderServices(json, stream) {
  const hosts = SUBSCRIPTION_FIXTURE_HOSTS;
  const issued = new Map();
  const rotations = new Map();
  const modelRequests = [];
  const claims = token => { try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); } catch { return {}; } };
  const makeToken = (provider, seat, epoch) => {
    const payload = { sub: provider + '-seat-' + seat, email: provider + '-' + seat + '@fixture.invalid',
      exp: Math.floor(Date.now() / 1000) + (provider === 'grok' ? 900 : 3600), scope: 'inference:invoke', fixtureEpoch: epoch };
    return 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.synthetic';
  };
  function device(provider, host, res) {
    const seat = (issued.get(provider) ?? 0) + 1;
    issued.set(provider, seat);
    const verify = 'https://' + host + (provider === 'grok' ? '/device' : '/activate');
    json(res, 200, { device_code: provider + ':' + seat, user_code: 'ABCD-EFGH',
      verification_uri: verify, verification_uri_complete: verify + '?user_code=ABCD-EFGH', expires_in: 300, interval: 1 });
  }
  function tokens(provider, seat, res, rotate) {
    const id = provider + ':' + seat;
    const epoch = (rotations.get(id) ?? 0) + (rotate ? 1 : 0);
    rotations.set(id, epoch);
    const token = makeToken(provider, seat, epoch);
    json(res, 200, { access_token: token, id_token: token, refresh_token: 'synthetic:' + id + ':' + epoch,
      token_type: 'Bearer', scope: 'inference:invoke', expires_in: provider === 'grok' ? 900 : 3600 });
  }
  return {
    hosts, requests: modelRequests, rotations,
    handle(req, res, url, body) {
      const host = url.hostname;
      const pathname = url.pathname;
      if (host === 'auth.x.ai' && pathname === '/oauth2/device/code') { device('grok', host, res); return true; }
      if (host === 'portal.nousresearch.com' && pathname === '/api/oauth/device/code') { device('hermes', host, res); return true; }
      if (host === 'opencode.ai' && pathname === '/console/auth/device/code') { device('opencode', host, res); return true; }
      const provider = host === 'auth.x.ai' ? 'grok' : host === 'portal.nousresearch.com' ? 'hermes'
        : host === 'oauth2.googleapis.com' ? 'antigravity' : host === 'opencode.ai' ? 'opencode' : null;
      if (provider && ['/oauth2/token', '/api/oauth/token', '/token', '/console/auth/device/token', '/console/auth/refresh'].includes(pathname)) {
        const rotate = body.grant_type === 'refresh_token' || pathname.endsWith('/refresh');
        const seat = rotate ? body.refresh_token?.split(':')[2]
          : provider === 'antigravity' ? body.code?.split('-').at(-1) : body.device_code?.split(':')[1];
        tokens(provider, Number(seat ?? 1), res, rotate); return true;
      }
      const identity = claims((req.headers.authorization ?? '').replace(/^Bearer /i, ''));
      if (host === 'www.googleapis.com' && pathname === '/oauth2/v1/userinfo') {
        json(res, 200, { id: identity.sub, email: identity.email }); return true;
      }
      if (host === 'models.opencode.ai') { json(res, 200, { opencode: { id: 'opencode', name: 'OpenCode', models: {} }, 'opencode-go': { id: 'opencode-go', name: 'Go', models: {} } }); return true; }
      if (host === 'opencode.ai' && pathname === '/console/api/user') {
        json(res, 200, { id: identity.sub, email: identity.email }); return true;
      }
      if (host === 'opencode.ai' && pathname === '/console/api/orgs') {
        json(res, 200, [{ id: 'org-' + identity.sub, name: 'Fixture' }]); return true;
      }
      if (host === 'opencode.ai' && pathname === '/console/api/config') {
        json(res, 200, { config: { provider: { opencode: {
          npm: '@ai-sdk/openai-compatible', api: 'https://opencode.ai/inference/openai/v1',
          options: { apiKey: '{env:OPENCODE_CONSOLE_TOKEN}', headers: { 'x-opencode-org-id': 'org-' + identity.sub } },
          models: { 'pool-fixture': { id: 'pool-fixture' } },
        } } } }); return true;
      }
      if (host.startsWith('antigravity-auto-updater') || host === 'antigravity.google') {
        json(res, 200, { version: '2.0.6' }); return true;
      }
      if (host.includes('cloudcode-pa') && pathname === '/v1internal:loadCodeAssist') {
        json(res, 200, { cloudaicompanionProject: 'project-' + identity.sub, currentTier: { id: 'standard-tier' } }); return true;
      }
      const modelProvider = host === 'api.x.ai' ? 'grok' : host === 'inference-api.nousresearch.com' ? 'hermes'
        : host === 'daily-cloudcode-pa.sandbox.googleapis.com' ? 'antigravity'
          : host === 'opencode.ai' && pathname.startsWith('/inference/') ? 'opencode' : null;
      if (!modelProvider) return false;
      // Auxiliary/catalog probes do not consume the deterministic pool sequence.
      const tools = body.tools ?? body.request?.tools ?? [];
      const native = tools.some(tool => ['Read', 'ExecCommand'].includes(tool.name ?? tool.function?.name)
        || tool.functionDeclarations?.some(fn => ['Read', 'ExecCommand'].includes(fn.name)));
      if (native) {
        modelRequests.push({ provider: modelProvider, subject: identity.sub, epoch: identity.fixtureEpoch,
          host, path: pathname, org: req.headers['x-opencode-org-id'], body });
        if (identity.sub?.endsWith('-seat-1')) {
          json(res, identity.fixtureEpoch === 0 ? 401 : 402, { error: {
            code: identity.fixtureEpoch === 0 ? 'invalid_api_key' : 'insufficient_quota',
            type: identity.fixtureEpoch === 0 ? 'authentication_error' : 'insufficient_quota',
            message: identity.fixtureEpoch === 0 ? 'Synthetic credential rejected' : 'Synthetic quota exhausted',
          } }); return true;
        }
      }
      const text = 'PROVIDER_POOL_COMPLETE';
      if (modelProvider === 'antigravity') {
        stream(res, [{ response: { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 } } }]); return true;
      }
      if (modelProvider === 'grok') {
        stream(res, [{ type: 'response.output_text.delta', delta: text },
          { type: 'response.completed', response: { id: 'fixture', model: body.model, output: [],
            usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } }]); return true;
      }
      stream(res, [{ id: 'fixture', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
      { id: 'fixture', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }]); return true;
    },
  };
}
