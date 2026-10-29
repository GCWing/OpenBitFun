import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditTypographyFileContractText,
  auditTypographyText,
} from './audit-typography-tokens.mjs';

function codesFor(source, relativePath) {
  return auditTypographyText(source, relativePath).map(issue => issue.code);
}

test('accepts canonical CSS typography, inheritance, structural zeros, and documented geometry', () => {
  const issues = auditTypographyText(`
    .body {
      font-family: var(--openbitfun-type-body-md-font-family);
      font-size: var(--openbitfun-type-body-md-font-size);
      font-weight: var(--openbitfun-font-weight-regular);
      line-height: var(--openbitfun-line-height-base);
      letter-spacing: var(--openbitfun-letter-spacing-normal);
    }
    .inherit { font: inherit; }
    .structural { font-size: 0; line-height: 0; }
    .avatar {
      /* typography-audit: allow -- emoji is graphic content scaled from its avatar box */
      font-size: calc(var(--avatar-size) * 0.5);
    }
  `, 'fixture.scss');

  assert.deepEqual(issues, []);
});

test('rejects raw CSS sizes, weights, line heights, tracking, and font stacks', () => {
  const codes = codesFor(`
    .bad {
      font-family: Inter, sans-serif;
      font-size: 14px;
      font-weight: 650;
      line-height: 1.5;
      letter-spacing: -0.01em;
    }
  `, 'fixture.css');

  assert.equal(codes.filter(code => code === 'raw-css-typography').length, 5);
});

test('accepts only build-owned font faces and stacks in Web font profiles', () => {
  const issues = auditTypographyText(`
    @font-face {
      font-family: "OpenBitFun HarmonyOS Sans";
      font-weight: 500;
    }
    @layer openbitfun.tokens.system {
      :where([data-openbitfun-design-system-root]) {
        --openbitfun-font-family-sans: "OpenBitFun HarmonyOS Sans", system-ui, sans-serif;
        --openbitfun-font-family-control: "OpenBitFun HarmonyOS Sans", system-ui, sans-serif;
        --openbitfun-font-family-mono: "Fira Code", monospace;
      }
    }
  `, 'src/web-ui/src/font-profiles/harmony-bundled.css');

  assert.deepEqual(issues, []);
});

test('rejects unrelated raw typography inside Web font profiles', () => {
  const codes = codesFor(`
    .bad {
      font-family: Inter, sans-serif;
      font-size: 14px;
      font-weight: 650;
      --feature-font-family: Inter, sans-serif;
    }
  `, 'src/web-ui/src/font-profiles/harmony-bundled.css');

  assert.equal(codes.filter(code => code === 'raw-css-typography').length, 3);
  assert.equal(codes.filter(code => code === 'raw-private-typography-token').length, 1);
});

test('requires semantic roles in the complete component library and every React product frontend', () => {
  const primitiveCodes = codesFor(`
    .title {
      font-family: var(--openbitfun-font-family-control);
      font-size: var(--openbitfun-font-size-sm);
      font-weight: var(--openbitfun-font-weight-semibold);
      line-height: var(--openbitfun-line-height-tight);
      letter-spacing: var(--openbitfun-letter-spacing-normal);
    }
  `, 'design-system/packages/ui/src/components/Card/Card.module.css');

  assert.equal(
    primitiveCodes.filter(code => code === 'foundation-typography-in-semantic-consumer').length,
    5,
  );

  const semanticIssues = auditTypographyText(`
    .title {
      font-family: var(--openbitfun-type-heading-card-font-family);
      font-size: var(--openbitfun-type-heading-card-font-size);
      font-weight: var(--openbitfun-type-heading-card-font-weight);
      line-height: var(--openbitfun-type-heading-card-line-height);
      letter-spacing: var(--openbitfun-type-heading-card-letter-spacing);
    }
  `, 'design-system/packages/ui/src/components/Card/Card.module.css');

  assert.deepEqual(semanticIssues, []);

  const geometryIssues = auditTypographyText(`
    .icon { inline-size: var(--openbitfun-font-size-sm); block-size: var(--openbitfun-font-size-sm); }
  `, 'design-system/packages/ui/src/components/ActionItem/ActionItem.module.css');

  assert.deepEqual(geometryIssues, []);

  const flowChatCodes = codesFor(`
    .message { font-size: var(--openbitfun-font-size-sm); }
  `, 'design-system/packages/ui/src/flow-chat/Message.module.css');

  assert.equal(
    flowChatCodes.filter(code => code === 'foundation-typography-in-semantic-consumer').length,
    1,
  );

  const webUiCodes = codesFor(`
    .label {
      font-size: var(--openbitfun-font-size-xs);
      line-height: var(--openbitfun-line-height-tight);
    }
  `, 'src/web-ui/src/app/components/LegacyLabel.scss');

  assert.equal(
    webUiCodes.filter(code => code === 'foundation-typography-in-semantic-consumer').length,
    2,
  );

  const webUiIndirectCodes = codesFor(`
    .title {
      --local-title-font: var(--openbitfun-font-family-sans);
      min-height: calc(var(--openbitfun-font-size-sm) * var(--openbitfun-line-height-base));
    }
  `, 'src/web-ui/src/app/components/LegacyTitle.scss');

  assert.equal(
    webUiIndirectCodes.filter(code => code === 'foundation-typography-in-semantic-consumer').length,
    3,
  );

  for (const productPath of [
    'src/mobile-web/src/styles/LegacyLabel.scss',
    'OpenBitFun-Installer/src/styles/LegacyLabel.css',
    'design-system/apps/design-lab/src/LegacyLabel.css',
  ]) {
    const productCodes = codesFor(`
      .label { font-size: var(--openbitfun-font-size-xs); }
    `, productPath);

    assert.equal(
      productCodes.filter(code => code === 'foundation-typography-in-semantic-consumer').length,
      1,
      productPath,
    );
  }
});

test('rejects static TypeScript typography but accepts tokens, adapters, and dynamic previews', () => {
  const codes = codesFor(`
    const RAW_FONT_SIZE = 12;
    const terminalOptions = { fontSize: 13, lineHeight: 1.4 };
    const compilerKeys = { fontSize: 'font-size', lineHeight: 'line-height' };
    const tokenOptions = { fontSize: getTypographyTokenPx('font.size.base') };
    const dynamicPreview = { fontSize: \`\${previewPx}px\` };
    const tokenStyle = { fontWeight: 'var(--openbitfun-font-weight-semibold)' };
    const Component = ({ fontSize = 16 }) => (
      <svg><text fontSize={10} fontWeight="var(--openbitfun-font-weight-medium)" /></svg>
    );
  `, 'fixture.tsx');

  assert.equal(codes.filter(code => code === 'raw-script-typography').length, 5);
});

test('requires semantic roles in product frontend inline styles and embedded CSS', () => {
  const codes = codesFor(`
    const style = { fontSize: 'var(--openbitfun-font-size-sm)' };
    const shell = \`<style>.title { font-weight: var(--openbitfun-font-weight-semibold); }</style>\`;
  `, 'src/web-ui/src/fixture.tsx');

  assert.equal(
    codes.filter(code => code === 'foundation-typography-in-semantic-consumer').length,
    2,
  );

  const semanticIssues = auditTypographyText(`
    const style = { fontSize: 'var(--openbitfun-type-label-md-font-size)' };
    const shell = \`<style>.title { font-weight: var(--openbitfun-type-heading-card-font-weight); }</style>\`;
  `, 'src/web-ui/src/fixture.tsx');

  assert.deepEqual(semanticIssues, []);

  for (const productPath of [
    'src/mobile-web/src/fixture.tsx',
    'OpenBitFun-Installer/src/fixture.tsx',
  ]) {
    const productCodes = codesFor(`
      const style = { fontSize: 'var(--openbitfun-font-size-sm)' };
    `, productPath);
    assert.equal(
      productCodes.filter(code => code === 'foundation-typography-in-semantic-consumer').length,
      1,
      productPath,
    );
  }
});

test('rejects retired aliases and FlowChat font APIs', () => {
  const codes = codesFor(`
    const oldToken = 'font.size.body';
    const oldVar = '--openbitfun-appearance-token-flowchat-font-size-base';
    setFlowChatFont('independent');
  `, 'fixture.ts');

  assert.deepEqual(codes.sort(), [
    'retired-flowchat-font-api',
    'retired-flowchat-font-variable',
    'retired-font-token-name',
  ]);
});

test('rejects retired component typography tokens and variables', () => {
  const codes = codesFor(`
    const oldToken = 'control.button.xsFontSize';
    const oldVariable = '--openbitfun-overlay-modal-title-font-weight';
  `, 'fixture.ts');

  assert.deepEqual(codes.sort(), [
    'retired-component-typography-token',
    'retired-component-typography-variable',
  ]);
});

test('allows retired names only inside explicit negative-test blocks', () => {
  const issues = auditTypographyText(`
    // typography-audit: negative-test-start -- verifies the retired alias stays absent
    expect(css).not.toContain('--openbitfun-appearance-token-font-size-base');
    // typography-audit: negative-test-end
  `, 'fixture.test.ts');

  assert.deepEqual(issues, []);
});

test('does not mistake token-editor labels or schema property maps for typography values', () => {
  const issues = auditTypographyText(`
    const categories = { lineHeight: 'Line height' };
    const messages = { fontSize: 'tokens.category.fontSize' };
    const cssProperties = {
      fontFamily: 'font-family',
      fontSize: 'font-size',
      fontWeight: 'font-weight',
      lineHeight: 'line-height',
      letterSpacing: 'letter-spacing',
    };
  `, 'fixture.ts');

  assert.deepEqual(issues, []);
});

test('limits the AppearanceStyle typography ban to that interface block', () => {
  const path = 'src/web-ui/src/infrastructure/appearance/types/index.ts';
  const valid = auditTypographyFileContractText(`
    export interface AppearanceStyle {
      backgroundColor?: string;
    }

    export interface MonacoAppearanceTokenRule {
      fontStyle?: string;
    }
  `, path);
  assert.deepEqual(valid, []);

  const invalid = auditTypographyFileContractText(`
    export interface AppearanceStyle {
      fontStyle?: string;
    }
  `, path);
  assert.deepEqual(invalid.map(issue => issue.code), [
    'appearance-style-typography-reintroduced',
  ]);
});

test('rejects a backend FlowChat font snapshot', () => {
  const issues = auditTypographyFileContractText(`
    pub struct FontPreferenceSnapshot {
        pub ui_size: UiFontSizeSnapshot,
        pub flow_chat: FlowChatFontSnapshot,
    }
  `, 'src/crates/assembly/core/src/service/config/types.rs');

  assert.deepEqual(issues.map(issue => issue.code), [
    'backend-flowchat-font-snapshot-reintroduced',
  ]);
});
