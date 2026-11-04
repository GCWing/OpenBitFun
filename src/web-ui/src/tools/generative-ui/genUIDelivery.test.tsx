// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import examples from '../../../../shared/generative-ui/examples.json';
import { verifyGenUICandidate } from './genUIDelivery';
import { genUIProduct } from './genUIProduct';
import { GenUIStateStore } from './genUIState';
import type { GenUIAppDefinition } from './genUITypes';
describe('GenUI mounted candidate delivery', () => {
  it('rejects source-less applications at delivery', async () => {
    const app = structuredClone(examples.ledger) as GenUIAppDefinition;
    delete app.source;
    const state = new GenUIStateStore().initialize(app);
    await expect(verifyGenUICandidate({ revision: 'r1', app, state })).rejects.toThrow('source is required');
    expect(document.querySelector('.gen-ui-application')).toBeNull();
  });
  it('keeps free HTML/SVG documents on the same owner and specification path', async () => {
    const app: GenUIAppDefinition = {
      schemaVersion: 2,
      id: 'free-phone',
      title: 'Free phone document',
      template: 'openbitfun.harmony.app',
      libraryId: 'openbitfun.harmony.v1',
      libraryRevision: 3,
      designSpec: { id: 'harmony.phone.v1', revision: 1 },
      source: { kind: 'html-document', html: '<section><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg></section>', css: 'section { width: 100%; }' },
      state: {},
    };
    expect(await verifyGenUICandidate({ revision: 'free-r1', app, state: {} })).toMatchObject({ sourceKind: 'html-document', checks: 'passed', render: 'passed', reopen: 'passed', layout: 'unverified' });
    expect(document.querySelector('[data-gen-ui-html-frame]')).toBeNull();
  });
  it('mounts OpenUI Lang documents with the selected trusted library', async () => {
    const app: GenUIAppDefinition = {
      schemaVersion: 2,
      id: 'openui-phone',
      title: 'OpenUI phone',
      template: 'openbitfun.harmony.app',
      libraryId: 'openbitfun.harmony.v1',
      libraryRevision: 3,
      designSpec: { id: 'harmony.phone.v1', revision: 1 },
      source: { kind: 'openui-lang', content: 'root = Col([Title("Hello")])' },
      state: {},
    };
    expect(await verifyGenUICandidate({ revision: 'openui-r1', app, state: {} })).toMatchObject({ sourceKind: 'openui-lang', checks: 'passed', render: 'passed', reopen: 'passed', probeReopen: 'passed' });
  });
  it('roundtrips OpenUI reactive state through an isolated reopen', async () => {
    const app: GenUIAppDefinition = {
      schemaVersion: 2,
      id: 'openui-state',
      title: 'OpenUI state',
      template: 'openbitfun.harmony.app',
      libraryId: 'openbitfun.harmony.v1',
      libraryRevision: 3,
      designSpec: { id: 'harmony.phone.v1', revision: 1 },
      source: { kind: 'openui-lang', content: 'root = Col([input, value])\ninput = Input($name, "Name", "text")\nvalue = Text($name)' },
      state: { '$name': { type: 'string', default: 'Initial' } },
    };
    expect(await verifyGenUICandidate({ revision: 'openui-state-r1', app, state: { '$name': 'Initial' } })).toMatchObject({
      sourceKind: 'openui-lang',
      interaction: 'observed',
      reopen: 'passed',
      probeReopen: 'passed',
    });
  });

  it('roundtrips a numeric slider using a valid range probe', async () => {
    const app: GenUIAppDefinition = {
      schemaVersion: 2,
      id: 'openui-slider-state',
      title: 'OpenUI slider state',
      template: 'openbitfun.harmony.app',
      libraryId: 'openbitfun.harmony.v1',
      libraryRevision: 3,
      designSpec: { id: 'harmony.phone.v1', revision: 1 },
      source: { kind: 'openui-lang', content: 'root = Col([slider, value])\nslider = Slider($temperature, 5, 35, 1, "Temperature", "°C")\nvalue = Text($temperature + "°C")' },
      state: { '$temperature': { type: 'number', default: 20 } },
    };
    const report = await verifyGenUICandidate({ revision: 'openui-slider-state-r1', app, state: { '$temperature': 20 } });
    expect(report).toMatchObject({
      sourceKind: 'openui-lang',
      interaction: 'observed',
      reopen: 'passed',
      probeReopen: 'passed',
    });
    expect(report.interactionEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ control: 'input:range', stateChanged: true, outputChanged: true }),
    ]));
  });

  it('probes state buttons before ToAssistant and never performs action side effects', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const state = { '$scene': 'commute' };
    const app: GenUIAppDefinition = {
      schemaVersion: 2,
      id: 'openui-action-probe',
      title: 'OpenUI action probe',
      template: 'openbitfun.harmony.app',
      libraryId: 'openbitfun.harmony.v1',
      libraryRevision: 3,
      designSpec: { id: 'harmony.phone.v1', revision: 1 },
      source: {
        kind: 'openui-lang',
        content: 'root = Col([heading, scenes, outfit, copy, ask])\n$scene = "commute"\nheading = Title("Today\'s outfit")\nscenes = SegmentedControl($scene, [{"value":"commute","label":"通勤"},{"value":"date","label":"约会"}])\noutfit = Text($scene == "commute" ? "风衣" : "连衣裙")\ncopy = Button("复制", @CopyToClipboard("风衣"))\nask = Button("问助手", @ToAssistant("再选一套"))',
      },
      state: { '$scene': { type: 'string', default: 'commute' } },
    };

    try {
      const report = await verifyGenUICandidate({ revision: 'openui-action-probe-r1', app, state });
      expect(report.interactionEvidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: '约会', stateChanged: true, outputChanged: true }),
        expect.objectContaining({ target: '问助手', actionDelivered: true, actionType: 'continue_conversation' }),
      ]));
      expect(report.renderedEvidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: '风衣' }),
      ]));
      expect(report.candidateEvidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ ref: 'candidate:source-kind', text: 'openui-lang' }),
      ]));
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard);
      else delete (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    }
  });
});
