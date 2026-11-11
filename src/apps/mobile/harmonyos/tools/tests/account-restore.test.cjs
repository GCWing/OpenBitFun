const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const official = 'https://remote.openbitfun.com/v/1.0.2';
const linkSource = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/services/AccountDeviceLink.ets'), 'utf8');
const linkJs = ts.transpileModule(linkSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const accountLink = {};
new Function('exports', linkJs)(accountLink);
const accountSource = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/services/CloudAccountClient.ets'), 'utf8');
const accountJs = ts.transpileModule(accountSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const account = {};
new Function('require', 'exports', accountJs)(name => ({
  './AccountDeviceLink': { OFFICIAL_RELAY_URL: official },
  './RemoteCrypto': { HarmonyRemoteCryptoCipher: class {} },
}[name] || {}), account);
const source = fs.readFileSync(path.join(__dirname, '../../entry/src/main/ets/pages/viewmodel/SettingsController.ets'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exported = {};
new Function('require', 'exports', js)(name => ({
  '../../services/AccountDeviceLink': accountLink,
  '../../services/CloudAccountClient': account,
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

test('device aliases are read without changing legacy device filtering or raw names', async () => {
  const client = new account.CloudAccountClient();
  client.request = async () => [
    { device_id: 'desktop', device_name: 'Studio Mac', device_alias: 'HarmonyOS Phone', online: true, device_kind: 'desktop' },
    { device_id: 'cleared', device_name: 'Office PC', device_alias: null, online: false },
    { device_id: 'legacy', device_name: 'Legacy PC', online: true },
    { device_id: 'unnamed', device_name: '', online: false },
    { device_id: 'phone', device_name: 'HarmonyOS Phone', device_alias: 'Office', online: true },
  ];
  const devices = await client.listDevices(official, { token: 'token' });
  assert.deepEqual(devices.map(device => device.deviceId), ['desktop', 'cleared', 'legacy', 'unnamed']);
  assert.equal(devices[0].deviceName, 'Studio Mac');
  assert.deepEqual(devices.map(account.accountDeviceDisplayName), ['HarmonyOS Phone', 'Office PC', 'Legacy PC', 'unnamed']);
});

test('directory refresh and presence retain aliases in the selected and preferred device names', async () => {
  let alias = 'Office';
  let onPresence;
  let published;
  const client = new account.CloudAccountClient();
  client.request = async () => [
    { device_id: 'desktop', device_name: 'Studio Mac', device_alias: alias, online: true, compatible: false },
  ];
  client.observePresence = (_relay, _session, listener) => { onPresence = listener; return () => {}; };
  const state = {
    controlTargetType: 'account_device', controlTargetDeviceId: 'desktop',
    setControlTarget(type, id, name) { this.controlTargetType = type; this.controlTargetDeviceId = id; this.controlTargetDeviceName = name; },
    setDesktopIdentity(name, id) { this.desktopName = name; this.desktopId = id; },
  };
  const controller = new exported.SettingsController({ client, remoteState: state, hooks: {
    deviceId: () => 'phone', onAccountDevices: devices => { published = devices; },
  } });
  controller.cloudSession = { token: 'token', userId: 'user' };
  controller.cloudRelayUrl = official;
  controller.setPreferredCloudTarget('desktop', 'Old name');
  await controller.listCloudAccountDevices();
  assert.equal(state.controlTargetDeviceName, 'Office');
  assert.equal(state.desktopName, 'Office');
  assert.equal(controller.preferredCloudTarget().deviceName, 'Office');
  controller.startPresencePolling(0);
  onPresence(['desktop']);
  assert.equal(account.accountDeviceDisplayName(published[0]), 'Office');
  assert.equal(published[0].deviceName, 'Studio Mac');
  assert.equal(published[0].compatible, false);

  alias = 'Work PC';
  await controller.listCloudAccountDevices();
  assert.equal(state.controlTargetDeviceName, 'Work PC');
  alias = null;
  await controller.listCloudAccountDevices();
  assert.equal(state.controlTargetDeviceName, 'Studio Mac');
  assert.equal(controller.preferredCloudTarget().deviceName, 'Studio Mac');
  assert.equal(state.controlTargetDeviceId, 'desktop');
  controller.stopPresencePolling();
});
