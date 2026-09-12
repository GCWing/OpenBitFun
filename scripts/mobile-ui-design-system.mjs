#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN_DIR = join(ROOT, 'src', 'apps', 'mobile', 'design-system');
const TOKENS_PATH = join(DESIGN_DIR, 'tokens', 'mobile-tokens.json');
const COMPONENTS_PATH = join(DESIGN_DIR, 'components', 'mobile-components.json');
const SCENARIOS_PATH = join(DESIGN_DIR, 'scenarios', 'mobile-preview-scenarios.json');
const CHECK = process.argv.includes('--check');

const tokens = readJson(TOKENS_PATH);
const components = readJson(COMPONENTS_PATH);
const scenarios = readJson(SCENARIOS_PATH);

validateContract(tokens, components, scenarios);

const outputs = new Map([
  [
    join(ROOT, 'src', 'apps', 'mobile', 'harmonyos', 'entry', 'src', 'main', 'resources', 'base', 'element', 'color.json'),
    renderHarmonyColors(tokens.colors, 'light'),
  ],
  [
    join(ROOT, 'src', 'apps', 'mobile', 'harmonyos', 'entry', 'src', 'main', 'resources', 'dark', 'element', 'color.json'),
    renderHarmonyColors(tokens.colors, 'dark'),
  ],
  [
    join(ROOT, 'src', 'apps', 'mobile', 'harmonyos', 'entry', 'src', 'main', 'ets', 'generated', 'MobileDesignTokens.ets'),
    renderHarmonyTokens(tokens),
  ],
  [
    join(ROOT, 'src', 'apps', 'mobile', 'harmonyos', 'entry', 'src', 'main', 'ets', 'generated', 'MobilePreviewScenarios.ets'),
    renderHarmonyScenarios(scenarios),
  ],
  [
    join(ROOT, 'src', 'apps', 'mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'openbitfun', 'mobile', 'app', 'ui', 'theme', 'generated', 'MobileDesignTokens.kt'),
    renderAndroidTokens(tokens),
  ],
  [
    join(ROOT, 'src', 'apps', 'mobile', 'android', 'app', 'src', 'main', 'kotlin', 'com', 'openbitfun', 'mobile', 'app', 'ui', 'preview', 'generated', 'MobilePreviewScenarios.kt'),
    renderAndroidScenarios(scenarios),
  ],
  [
    join(ROOT, 'src', 'apps', 'mobile', 'shared', 'core-feature', 'src', 'commonMain', 'kotlin', 'com', 'openbitfun', 'mobile', 'core', 'feature', 'layout', 'generated', 'MobileDesignBreakpoints.kt'),
    renderSharedLayoutTokens(tokens),
  ],
  [
    join(ROOT, 'src', 'apps', 'mobile', 'ios', 'OpenBitFun', 'Features', 'DesignSystem', 'GeneratedMobileDesignTokens.swift'),
    renderIosTokens(tokens),
  ],
  [
    join(ROOT, 'src', 'apps', 'mobile', 'ios', 'OpenBitFun', 'Features', 'DesignSystem', 'GeneratedMobilePreviewScenarios.swift'),
    renderIosScenarios(scenarios),
  ],
  [
    join(DESIGN_DIR, 'preview', 'generated', 'mobile-design-data.js'),
    renderPreviewData(tokens, components, scenarios),
  ],
]);

let changed = 0;
for (const [path, content] of outputs) {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current !== null && normalizeLineEndings(current) === normalizeLineEndings(content)) continue;
  changed += 1;
  const relativePath = path.slice(ROOT.length + 1);
  if (CHECK) {
    console.error(`[mobile-ui] Generated file is stale: ${relativePath}`);
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  console.log(`[mobile-ui] Wrote ${relativePath}`);
}

if (CHECK && changed > 0) {
  console.error(`[mobile-ui] ${changed} generated file(s) need regeneration.`);
  process.exit(1);
}

if (changed === 0) {
  console.log(`[mobile-ui] ${CHECK ? 'Contract and generated files are in sync' : 'Generated files are already current'}.`);
}

function normalizeLineEndings(content) {
  return content.replace(/\r\n?/g, '\n');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function validateContract(tokenContract, componentContract, scenarioContract) {
  if (tokenContract.version !== 1 || componentContract.version !== 1 || scenarioContract.version !== 1) {
    throw new Error('Unsupported mobile design contract version.');
  }
  for (const [name, pair] of Object.entries(tokenContract.colors ?? {})) {
    for (const appearance of ['light', 'dark']) {
      if (!/^#(?:[0-9A-F]{6}|[0-9A-F]{8})$/.test(pair[appearance] ?? '')) {
        throw new Error(`Invalid ${appearance} color for ${name}.`);
      }
    }
  }
  for (const [name, value] of Object.entries(tokenContract.geometry ?? {})) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid geometry token ${name}.`);
  }
  const availableTokenNames = new Set([
    ...Object.keys(tokenContract.colors ?? {}),
    ...Object.keys(tokenContract.typography ?? {}),
    ...Object.keys(tokenContract.geometry ?? {}),
    ...Object.keys(tokenContract.breakpoints ?? {}),
    ...Object.keys(tokenContract.motion ?? {}),
  ]);
  for (const [componentName, component] of Object.entries(componentContract.components ?? {})) {
    for (const tokenName of component.tokens ?? []) {
      if (!availableTokenNames.has(tokenName)) {
        throw new Error(`Component ${componentName} references unknown mobile token ${tokenName}.`);
      }
    }
  }
  const ids = new Set();
  for (const scenario of scenarioContract.scenarios ?? []) {
    if (!scenario.id || ids.has(scenario.id)) throw new Error(`Invalid or duplicate preview scenario id: ${scenario.id}.`);
    ids.add(scenario.id);
    if (!['light', 'dark'].includes(scenario.appearance)) throw new Error(`Invalid appearance for ${scenario.id}.`);
    if (!scenario.viewport?.width || !scenario.viewport?.height) throw new Error(`Missing viewport for ${scenario.id}.`);
  }
}

function renderHarmonyColors(colors, appearance) {
  return `${JSON.stringify({
    color: Object.entries(colors).map(([name, pair]) => ({ name, value: pair[appearance] })),
  }, null, 2)}\n`;
}

function renderHarmonyTokens(contract) {
  const colors = Object.entries(contract.colors)
    .map(([name, pair]) => `  static readonly ${camel(name)}: MobileColorPair = new MobileColorPair(${quoted(pair.light)}, ${quoted(pair.dark)});`)
    .join('\n');
  const typography = Object.entries(contract.typography)
    .map(([name, token]) => `  static readonly ${camel(name)}: MobileTypographyToken = new MobileTypographyToken(${token.size}, ${token.lineHeight}, ${token.weight});`)
    .join('\n');
  const geometry = renderNumberProperties(contract.geometry, '  static readonly');
  const breakpoints = renderNumberProperties(contract.breakpoints, '  static readonly');
  const motion = renderNumberProperties(contract.motion, '  static readonly');
  return `// Generated by scripts/mobile-ui-design-system.mjs. Do not edit.\n\nexport class MobileColorPair {\n  readonly light: string;\n  readonly dark: string;\n\n  constructor(light: string, dark: string) {\n    this.light = light;\n    this.dark = dark;\n  }\n}\n\nexport class MobileDesignColors {\n${colors}\n}\n\nexport class MobileTypographyToken {\n  readonly size: number;\n  readonly lineHeight: number;\n  readonly weight: number;\n\n  constructor(size: number, lineHeight: number, weight: number) {\n    this.size = size;\n    this.lineHeight = lineHeight;\n    this.weight = weight;\n  }\n}\n\nexport class MobileDesignTypography {\n${typography}\n}\n\nexport class MobileDesignGeometry {\n${geometry}\n}\n\nexport class MobileDesignBreakpoints {\n${breakpoints}\n}\n\nexport class MobileDesignMotion {\n${motion}\n}\n`;
}

function renderHarmonyScenarios(contract) {
  const values = contract.scenarios.map((scenario) => `  static readonly ${camel(scenario.id.replaceAll('-', '_'))}: MobilePreviewScenario = new MobilePreviewScenario(\n    ${quoted(scenario.id)},\n    ${quoted(scenario.title)},\n    ${quoted(scenario.description)},\n    ${quoted(scenario.appearance)},\n    ${scenario.viewport.width},\n    ${scenario.viewport.height},\n    ${quoted(scenario.header.title)},\n    ${quoted(scenario.header.subtitle)},\n    [${scenario.messages.map((message) => `new MobilePreviewMessage(${quoted(message.role)}, ${quoted(message.text)})`).join(', ')}],\n    ${quoted(scenario.composer.draft)},\n    ${quoted(scenario.composer.placeholder)},\n    ${quoted(scenario.composer.phase)},\n    ${scenario.composer.streaming}\n  );`).join('\n\n');
  return `// Generated by scripts/mobile-ui-design-system.mjs. Do not edit.\n\nexport class MobilePreviewMessage {\n  readonly role: string;\n  readonly text: string;\n\n  constructor(role: string, text: string) {\n    this.role = role;\n    this.text = text;\n  }\n}\n\nexport class MobilePreviewScenario {\n  readonly id: string;\n  readonly title: string;\n  readonly description: string;\n  readonly appearance: string;\n  readonly viewportWidth: number;\n  readonly viewportHeight: number;\n  readonly headerTitle: string;\n  readonly headerSubtitle: string;\n  readonly messages: MobilePreviewMessage[];\n  readonly composerDraft: string;\n  readonly composerPlaceholder: string;\n  readonly connectionPhase: string;\n  readonly streaming: boolean;\n\n  constructor(\n    id: string,\n    title: string,\n    description: string,\n    appearance: string,\n    viewportWidth: number,\n    viewportHeight: number,\n    headerTitle: string,\n    headerSubtitle: string,\n    messages: MobilePreviewMessage[],\n    composerDraft: string,\n    composerPlaceholder: string,\n    connectionPhase: string,\n    streaming: boolean\n  ) {\n    this.id = id;\n    this.title = title;\n    this.description = description;\n    this.appearance = appearance;\n    this.viewportWidth = viewportWidth;\n    this.viewportHeight = viewportHeight;\n    this.headerTitle = headerTitle;\n    this.headerSubtitle = headerSubtitle;\n    this.messages = messages;\n    this.composerDraft = composerDraft;\n    this.composerPlaceholder = composerPlaceholder;\n    this.connectionPhase = connectionPhase;\n    this.streaming = streaming;\n  }\n}\n\nexport class MobilePreviewScenarios {\n${values}\n}\n`;
}

function renderAndroidTokens(contract) {
  const lightColors = renderKotlinColors(contract.colors, 'light');
  const darkColors = renderKotlinColors(contract.colors, 'dark');
  const typography = Object.entries(contract.typography)
    .map(([name, token]) => `    val ${pascal(name)} = TextStyle(fontSize = ${token.size}.sp, lineHeight = ${token.lineHeight}.sp, fontWeight = ${kotlinWeight(token.weight)})`)
    .join('\n');
  const geometry = Object.entries(contract.geometry)
    .map(([name, value]) => `    val ${pascal(name)} = ${value}.dp`)
    .join('\n');
  const breakpoints = renderKotlinInts(contract.breakpoints);
  const motion = renderKotlinInts(contract.motion);
  return `// Generated by scripts/mobile-ui-design-system.mjs. Do not edit.\npackage com.openbitfun.mobile.app.ui.theme.generated\n\nimport androidx.compose.ui.graphics.Color\nimport androidx.compose.ui.text.TextStyle\nimport androidx.compose.ui.text.font.FontWeight\nimport androidx.compose.ui.unit.dp\nimport androidx.compose.ui.unit.sp\n\ninternal object MobileDesignColors {\n    object Light {\n${lightColors}\n    }\n\n    object Dark {\n${darkColors}\n    }\n}\n\ninternal object MobileDesignTypography {\n${typography}\n}\n\ninternal object MobileDesignGeometry {\n${geometry}\n}\n\ninternal object MobileDesignBreakpoints {\n${breakpoints}\n}\n\ninternal object MobileDesignMotion {\n${motion}\n}\n`;
}

function renderAndroidScenarios(contract) {
  const values = contract.scenarios.map((scenario) => `    val ${pascal(scenario.id.replaceAll('-', '_'))} = MobilePreviewScenario(\n        id = ${quoted(scenario.id)},\n        title = ${quoted(scenario.title)},\n        description = ${quoted(scenario.description)},\n        appearance = ${quoted(scenario.appearance)},\n        viewportWidth = ${scenario.viewport.width},\n        viewportHeight = ${scenario.viewport.height},\n        headerTitle = ${quoted(scenario.header.title)},\n        headerSubtitle = ${quoted(scenario.header.subtitle)},\n        messages = listOf(${scenario.messages.map((message) => `MobilePreviewMessage(${quoted(message.role)}, ${quoted(message.text)})`).join(', ')}),\n        composerDraft = ${quoted(scenario.composer.draft)},\n        composerPlaceholder = ${quoted(scenario.composer.placeholder)},\n        connectionPhase = ${quoted(scenario.composer.phase)},\n        streaming = ${scenario.composer.streaming},\n    )`).join('\n\n');
  return `// Generated by scripts/mobile-ui-design-system.mjs. Do not edit.\npackage com.openbitfun.mobile.app.ui.preview.generated\n\ninternal data class MobilePreviewMessage(val role: String, val text: String)\n\ninternal data class MobilePreviewScenario(\n    val id: String,\n    val title: String,\n    val description: String,\n    val appearance: String,\n    val viewportWidth: Int,\n    val viewportHeight: Int,\n    val headerTitle: String,\n    val headerSubtitle: String,\n    val messages: List<MobilePreviewMessage>,\n    val composerDraft: String,\n    val composerPlaceholder: String,\n    val connectionPhase: String,\n    val streaming: Boolean,\n)\n\ninternal object MobilePreviewScenarios {\n${values}\n}\n`;
}

function renderIosTokens(contract) {
  const colors = Object.entries(contract.colors)
    .map(([name, pair]) => `    static let ${camel(name)} = dynamic(light: ${swiftHex(pair.light)}, dark: ${swiftHex(pair.dark)})`)
    .join('\n');
  const typography = Object.entries(contract.typography)
    .map(([name, token]) => `    static let ${camel(name)} = MobileTypographyToken(size: ${token.size}, lineHeight: ${token.lineHeight}, weight: .${swiftWeight(token.weight)}, textStyle: .${swiftTextStyle(name)})`)
    .join('\n');
  const geometry = renderSwiftNumbers(contract.geometry);
  const breakpoints = renderSwiftNumbers(contract.breakpoints);
  const motion = renderSwiftNumbers(contract.motion);
  return `// Generated by scripts/mobile-ui-design-system.mjs. Do not edit.\nimport SwiftUI\nimport UIKit\n\nstruct MobileTypographyToken {\n    let size: CGFloat\n    let lineHeight: CGFloat\n    let weight: UIFont.Weight\n    let textStyle: UIFont.TextStyle\n\n    private var scaledFont: UIFont {\n        UIFontMetrics(forTextStyle: textStyle).scaledFont(\n            for: UIFont.systemFont(ofSize: size, weight: weight)\n        )\n    }\n\n    var font: Font { Font(scaledFont) }\n    var lineSpacing: CGFloat {\n        let scaledLineHeight = UIFontMetrics(forTextStyle: textStyle).scaledValue(for: lineHeight)\n        return max(0, scaledLineHeight - scaledFont.lineHeight)\n    }\n}\n\nenum MobileDesignColors {\n${colors}\n\n    private static func dynamic(light: UInt32, dark: UInt32) -> Color {\n        Color(uiColor: UIColor { traits in\n            rgba(traits.userInterfaceStyle == .dark ? dark : light)\n        })\n    }\n\n    private static func rgba(_ value: UInt32) -> UIColor {\n        UIColor(\n            red: CGFloat((value >> 16) & 0xFF) / 255,\n            green: CGFloat((value >> 8) & 0xFF) / 255,\n            blue: CGFloat(value & 0xFF) / 255,\n            alpha: CGFloat((value >> 24) & 0xFF) / 255\n        )\n    }\n}\n\nenum MobileDesignTypography {\n${typography}\n}\n\nenum MobileDesignGeometry {\n${geometry}\n}\n\nenum MobileDesignBreakpoints {\n${breakpoints}\n}\n\nenum MobileDesignMotion {\n${motion}\n}\n`;
}

function renderIosScenarios(contract) {
  const values = contract.scenarios.map((scenario) => `    static let ${camel(scenario.id.replaceAll('-', '_'))} = MobilePreviewScenario(\n        id: ${quoted(scenario.id)},\n        title: ${quoted(scenario.title)},\n        description: ${quoted(scenario.description)},\n        appearance: ${quoted(scenario.appearance)},\n        viewportWidth: ${scenario.viewport.width},\n        viewportHeight: ${scenario.viewport.height},\n        headerTitle: ${quoted(scenario.header.title)},\n        headerSubtitle: ${quoted(scenario.header.subtitle)},\n        messages: [${scenario.messages.map((message) => `MobilePreviewMessage(role: ${quoted(message.role)}, text: ${quoted(message.text)})`).join(', ')}],\n        composerDraft: ${quoted(scenario.composer.draft)},\n        composerPlaceholder: ${quoted(scenario.composer.placeholder)},\n        connectionPhase: ${quoted(scenario.composer.phase)},\n        streaming: ${scenario.composer.streaming}\n    )`).join('\n\n');
  return `// Generated by scripts/mobile-ui-design-system.mjs. Do not edit.\nimport CoreGraphics\n\nstruct MobilePreviewMessage {\n    let role: String\n    let text: String\n}\n\nstruct MobilePreviewScenario {\n    let id: String\n    let title: String\n    let description: String\n    let appearance: String\n    let viewportWidth: CGFloat\n    let viewportHeight: CGFloat\n    let headerTitle: String\n    let headerSubtitle: String\n    let messages: [MobilePreviewMessage]\n    let composerDraft: String\n    let composerPlaceholder: String\n    let connectionPhase: String\n    let streaming: Bool\n}\n\nenum MobilePreviewScenarios {\n${values}\n}\n`;
}

function renderSharedLayoutTokens(contract) {
  const breakpoints = Object.entries(contract.breakpoints)
    .map(([name, value]) => `    public const val ${pascal(name)}: Int = ${value}`)
    .join('\n');
  return `// Generated by scripts/mobile-ui-design-system.mjs. Do not edit.\npackage com.openbitfun.mobile.core.feature.layout.generated\n\npublic object MobileDesignBreakpoints {\n${breakpoints}\n}\n`;
}

function renderPreviewData(tokenContract, componentContract, scenarioContract) {
  return `// Generated by scripts/mobile-ui-design-system.mjs. Do not edit.\nexport const mobileTokens = ${JSON.stringify(tokenContract, null, 2)};\nexport const mobileComponents = ${JSON.stringify(componentContract, null, 2)};\nexport const mobilePreviewScenarios = ${JSON.stringify(scenarioContract, null, 2)};\n`;
}

function renderNumberProperties(values, prefix) {
  return Object.entries(values).map(([name, value]) => `${prefix} ${camel(name)}: number = ${value};`).join('\n');
}

function renderKotlinColors(colors, appearance) {
  return Object.entries(colors)
    .map(([name, pair]) => `        val ${pascal(name)} = Color(0x${normalizeArgb(pair[appearance])})`)
    .join('\n');
}

function renderKotlinInts(values) {
  return Object.entries(values).map(([name, value]) => `    const val ${pascal(name)}: Int = ${value}`).join('\n');
}

function renderSwiftNumbers(values) {
  return Object.entries(values).map(([name, value]) => `    static let ${camel(name)}: CGFloat = ${value}`).join('\n');
}

function normalizeArgb(hex) {
  const value = hex.slice(1);
  return value.length === 6 ? `FF${value}` : value;
}

function swiftHex(hex) {
  return `0x${normalizeArgb(hex)}`;
}

function words(name) {
  return name.split('_').filter(Boolean);
}

function camel(name) {
  const [head, ...tail] = words(name);
  return head + tail.map((word) => word[0].toUpperCase() + word.slice(1)).join('');
}

function pascal(name) {
  return words(name).map((word) => word[0].toUpperCase() + word.slice(1)).join('');
}

function kotlinWeight(weight) {
  if (weight >= 700) return 'FontWeight.Bold';
  if (weight >= 500) return 'FontWeight.Medium';
  return 'FontWeight.Normal';
}

function swiftWeight(weight) {
  if (weight >= 700) return 'bold';
  if (weight >= 500) return 'medium';
  return 'regular';
}

function swiftTextStyle(name) {
  const styles = {
    brand_wordmark: 'largeTitle',
    display_large: 'largeTitle',
    display_medium: 'title1',
    display_small: 'title2',
    headline_large: 'title1',
    headline_medium: 'title2',
    headline_small: 'title3',
    title_large: 'title2',
    conversation_header_title: 'headline',
    title_medium: 'headline',
    title_small: 'subheadline',
    body_large: 'body',
    body_medium: 'callout',
    body_small: 'footnote',
    label_large: 'subheadline',
    label_medium: 'footnote',
    label_small: 'caption1',
  };
  const style = styles[name];
  if (!style) throw new Error(`Missing iOS text style mapping for mobile typography token ${name}.`);
  return style;
}

function quoted(value) {
  return JSON.stringify(value);
}
