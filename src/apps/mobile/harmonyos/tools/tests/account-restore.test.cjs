const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const official = 'https://remote.openbitfun.com/v/1.0.1';
const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/pages/viewmodel/SettingsController.ets'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exported = {};
new Function('require', 'exports', js)(name => ({
  '../../services/AccountDeviceLink': { OFFICIAL_RELAY_URL: official },
  '../../services/CloudAccountClient': { DEFAULT_CLOUD_RELAY_URL: official },
  '../../services/RemoteLogger': { RemoteLogger: { warn() {} } },
  '../../i18n/RemoteI18n': { RemoteI18n: { t: key => key } },
}[name] || {}), exported);

test('an older relay credential retains its saved profile without claiming current authentication', async () => {
  const record = { relayUrl: 'https://remote.openbitfun.com/v/1.0.0', userId: 'user', username: 'saved-user', token: 'old-token' };
  const state = {};
  let cleared = false;
  const controller = new exported.SettingsController({
    sessionStore: { load: async () => record, clear: async () => { cleared = true; } },
    remoteState: {
      setAccountUserId: value => { state.userId = value; },
      setAccountUsername: value => { state.username = value; },
      setStatusText: value => { state.status = value; },
    },
  });
  await controller.restoreCloudAccountSession();
  assert.equal(state.userId, '');
  assert.equal(state.username, 'saved-user');
  assert.equal(state.status, 'remote.settings.relayReauthorizationRequired');
  assert.equal(controller.hasCloudAccountSession(), false);
  assert.equal(controller.activeCloudAccount(), undefined);
  assert.equal(cleared, false);
  assert.equal(record.token, 'old-token');
});
