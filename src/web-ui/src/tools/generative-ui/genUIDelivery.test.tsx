// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
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
      libraryRevision: 2,
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
      libraryRevision: 2,
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
      libraryRevision: 2,
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
});
