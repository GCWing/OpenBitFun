import React from 'react';
import GenUILibrarySection from '../../src/app/scenes/settings/pages/ai/GenUILibrarySection';
import { configAPI } from '../../src/infrastructure/api/service-api/ConfigAPI';
import { createGenUILibraryPreview, genUILibraryProfiles } from '../../src/tools/generative-ui/genUILibraryPreview';
import previewCopy from '../../src/locales/en-US/settings/runtime.json';
import { createRoot } from 'react-dom/client';
import '@openbitfun/ui/styles.css';
import '../../src/app/styles/index.scss';
import { I18nProvider, i18nService } from '../../src/infrastructure/i18n';
import { appearanceRuntime, buildBuiltinAppearance, openBitFunDarkPalette } from '../../src/infrastructure/appearance';
import { verifyGenUICandidate } from '../../src/tools/generative-ui/genUIDelivery';
import { GenUIStateStore } from '../../src/tools/generative-ui/genUIState';
import GenUIApplication from '../../src/tools/generative-ui/GenUIApplication';
import type { GenUIAppDefinition } from '../../src/tools/generative-ui/genUITypes';
import { i18nAPI } from '../../src/infrastructure/api/service-api/I18nAPI';

// Only the locale/storage boundaries are replaced in this browser fixture.
i18nAPI.getCurrentLanguage = async () => 'en-US';
await i18nService.initialize();
await appearanceRuntime.initialize(buildBuiltinAppearance(openBitFunDarkPalette));
const reports: Record<string, unknown> = {};
const screenshots: Record<string, string> = {};
const freePhone: GenUIAppDefinition = { schemaVersion: 2, id: 'free-phone', title: 'Free phone document', template: 'openbitfun.harmony.app', libraryId: 'openbitfun.harmony.v1', libraryRevision: 2, designSpec: { id: 'harmony.phone.v1', revision: 1 }, source: { kind: 'html-document', html: '<section><h2>Free SVG</h2><svg viewBox="0 0 120 40" role="img" aria-label="Decorative chart"><path d="M4 32 L30 20 L58 25 L90 8 L116 14" fill="none" stroke="currentColor" stroke-width="4" /></svg></section>', css: 'section { display: grid; gap: 16px; } svg { width: 100%; height: auto; }' }, state: {} };
const scriptPhone: GenUIAppDefinition = { schemaVersion: 2, id: 'script-phone', title: 'Controlled script document', template: 'openbitfun.harmony.app', libraryId: 'openbitfun.harmony.v1', libraryRevision: 2, designSpec: { id: 'harmony.phone.v1', revision: 1 }, source: { kind: 'html-document', html: '<p data-bridge-result>waiting</p>', script: 'setTimeout(() => window.openbitfunWidget.request("echo", {value: "bridge-ok"}).then(value => { document.querySelector("[data-bridge-result]").textContent = value; }), 0);' }, state: {} };
const openUISource: GenUIAppDefinition = { schemaVersion: 2, id: 'openui-phone', title: 'OpenUI phone document', template: 'openbitfun.harmony.app', libraryId: 'openbitfun.harmony.v1', libraryRevision: 2, designSpec: { id: 'harmony.phone.v1', revision: 1 }, source: { kind: 'openui-lang', content: 'root = Col([title, name, body, ping])\ntitle = Title("OpenUI Lang")\nname = Input($name, "Name", "text")\nbody = Card([Text("Trusted component"), Text("Rendered by the selected Harmony library")], "soft")\nping = Button("Ping", @ToAssistant("Ping from OpenUI"))' }, state: { '$name': { type: 'string', default: 'Initial' } } };
const harmonyStyleProbe: GenUIAppDefinition = { schemaVersion: 2, id: 'harmony-style-probe', title: 'Plant garden', template: 'openbitfun.harmony.app', libraryId: 'openbitfun.harmony.v1', libraryRevision: 2, designSpec: { id: 'harmony.phone.v1', revision: 1 }, source: { kind: 'openui-lang', content: 'root = Col([card, action, field, slider, icon])\ncard = Card([Title("Garden"), Text("Harmony component surface")], "soft")\naction = Button("Open")\nfield = Input($value, "Name", "text")\nslider = Slider($progress, 0, 100, 1, "Progress")\nicon = Icon("house", "md")' }, state: { '$value': { type: 'string', default: 'Plant' }, '$progress': { type: 'number', default: 40 } } };
const harmonyHtmlStyleProbe: GenUIAppDefinition = { schemaVersion: 2, id: 'harmony-html-style-probe', title: 'Plant garden', template: 'openbitfun.harmony.app', libraryId: 'openbitfun.harmony.v1', libraryRevision: 2, designSpec: { id: 'harmony.phone.v1', revision: 1 }, source: { kind: 'html-document', html: '<main class="page"><header class="page-header"><h1>Garden</h1><span class="tag brand">Today</span></header><section class="card"><div class="hero-ring" style="--value:.42"><svg viewBox="0 0 120 120"><circle class="hero-ring-track" cx="60" cy="60" r="54"/><circle class="hero-ring-bar" cx="60" cy="60" r="54" pathLength="100"/></svg><div class="hero-ring-label"><span class="hero-ring-value">42%</span><span class="hero-ring-caption">Watered</span></div></div><div class="progress brand"><div class="progress-bar" style="width:42%"></div></div></section><ul class="list"><li class="list-item"><span class="list-item-icon"><span class="hm-icon" data-icon="leaf" aria-hidden="true"></span></span><div class="list-item-text"><span class="list-item-title">Basil</span><span class="list-item-subtitle">Healthy</span></div><label class="list-item-trailing"><input class="switch" type="checkbox" role="switch" checked aria-label="Basil alerts"></label></li></ul><div class="chips"><button class="chip active">Today</button><button class="chip">Week</button></div></main>' }, state: {} };
const harmonyDarkStyleProbe: GenUIAppDefinition = { schemaVersion: 2, id: 'harmony-dark-style-probe', title: 'Night music diary', template: 'openbitfun.harmony.app', libraryId: 'openbitfun.harmony.v1', libraryRevision: 2, designSpec: { id: 'harmony.phone.v1', revision: 1 }, source: { kind: 'openui-lang', content: 'root = Col([Title("Night mix"), Card([Text("Dark Harmony surface")], "soft"), Button("Play")])' }, state: {} };
const scriptBridge = { capabilities: { echo: { payload: { type: 'object' as const, properties: { value: { type: 'string' as const } }, required: ['value'], additionalProperties: false }, permission: 'test.genui.echo', remote: 'local' as const } }, handlers: { echo: async (payload: unknown, context: { appId: string; sourceKey: string; designSpec?: { id: string; revision: number } }) => { sessionStorage.setItem('genui-script-context', JSON.stringify({ payload, context })); return (payload as { value: string }).value; } } };
try {
  const cachedReports = sessionStorage.getItem('genui-browser-reports');
  if (cachedReports) Object.assign(reports, JSON.parse(cachedReports));
  else {
  const previews = Object.fromEntries(Object.keys(genUILibraryProfiles).map(id => [id, createGenUILibraryPreview(id, key => key.split('.').reduce((value: any, part) => value[part], previewCopy))]));
  const invalidFree = { ...freePhone, id: 'invalid-free-phone', source: { kind: 'html-document' as const, html: '<section></section>' } };
  let invalidFreeError = '';
  try {
    await verifyGenUICandidate({ revision: 'invalid-free', app: invalidFree, state: {} }, undefined, true);
  } catch (error) {
    invalidFreeError = String(error);
  }
  if (!invalidFreeError.includes('no visible rendered content')) throw new Error('HTML delivery checker accepted an empty free document: ' + invalidFreeError);
  reports['free-invalid-rejection'] = 'passed';
  for (const [name, definition] of Object.entries({ openui: previews.openui, harmony: previews.harmony, 'openui-source': openUISource, free: freePhone })) {
    const app = definition as GenUIAppDefinition;
    const candidate = { revision: name, app, state: new GenUIStateStore().initialize(app) };
    const evidence = await verifyGenUICandidate(candidate, undefined, true);
    reports[name] = { ...evidence, screenshot: evidence.screenshot?.slice(0, 30), screenshotBytes: evidence.screenshot?.length };
    if (evidence.screenshot) screenshots[name] = evidence.screenshot;
  }
  sessionStorage.setItem('genui-browser-reports', JSON.stringify(reports));
  }
  document.documentElement.dataset.genuiResult = 'passed';
} catch (error) {
  reports.error = String(error); document.documentElement.dataset.genuiResult = 'failed';
}
const params = new URLSearchParams(location.search);
const profile = params.get('profile');
const settingsPreview = params.has('settings');
if (settingsPreview) {
  // Use real settings UI/ConfigManager; replace only host IO in this fixture.
  configAPI.getConfig = async path => {
    if (path !== 'ai.generative_ui_library') throw new Error('Unexpected preview config read: ' + path);
    return sessionStorage.getItem('genui-browser-library') ?? 'openui';
  };
  configAPI.setConfig = async (path, value) => {
    if (path !== 'ai.generative_ui_library') throw new Error('Unexpected preview config write: ' + path);
    sessionStorage.setItem('genui-browser-library', value);
  };
}
// Keep the default live surface on the OpenUI preview so the browser fixture
// exercises local reactive input without entering the Harmony delivery path.
// The source adapter and delivery probes are covered independently above.
const app = profile ? createGenUILibraryPreview(profile, key => key.split('.').reduce((value: any, part) => value[part], previewCopy)) : createGenUILibraryPreview('openui', key => key.split('.').reduce((value: any, part) => value[part], previewCopy));
// The default OpenUI surface is transient. It owns local reactive state while
// mounted, but it never enters the Harmony owner/persistence pipeline.
const StreamingFixture = params.has('streaming') ? (await import('./genuiStreaming')).default : undefined;
createRoot(document.getElementById('root')!).render(<I18nProvider>
  <div style={{ overflow: 'auto', maxHeight: '100vh' }}>{StreamingFixture ? <StreamingFixture deferred={params.has('deferred')} /> : settingsPreview ? <GenUILibrarySection /> : <GenUIApplication definition={app} persistState={false} />}</div>
  <pre data-testid="genui-evidence">{JSON.stringify(reports)}</pre>
  {!StreamingFixture && !settingsPreview ? <>
    <div data-testid="free-live-document" style={{ position: 'fixed', left: '-10000px', top: 0, width: 360, height: 764 }}><GenUIApplication definition={freePhone} preview /></div>
    <div data-testid="script-live-document" style={{ position: 'fixed', left: '-10000px', top: 0, width: 360, height: 764 }}><GenUIApplication definition={scriptPhone} htmlBridge={scriptBridge} /></div>
    <div data-testid="harmony-style-probe" style={{ position: 'fixed', left: '-10000px', top: 0, width: 360, height: 764 }}><GenUIApplication definition={harmonyStyleProbe} /></div>
    <div data-testid="harmony-html-style-probe" style={{ position: 'fixed', left: '-10000px', top: 0, width: 360, height: 764 }}><GenUIApplication definition={harmonyHtmlStyleProbe} /></div>
    <div data-testid="harmony-dark-style-probe" style={{ position: 'fixed', left: '-10000px', top: 0, width: 360, height: 764 }}><GenUIApplication definition={harmonyDarkStyleProbe} /></div>
  </> : null}
  {Object.entries(screenshots).map(([name, src]) => <img key={name} data-testid={'genui-screenshot-' + name} src={src} alt={name + ' host probe screenshot'} hidden />)}
</I18nProvider>);
