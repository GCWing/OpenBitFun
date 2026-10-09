import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');

const SOURCE_GROUPS = Object.freeze({
  'design-system': [
    'design-system/apps/design-lab/src',
    'design-system/packages/ui/src',
    'packages/flow-chat-presentation/src',
  ],
  'web-ui': [
    'src/web-ui/src',
    'src/mobile-web/src',
    'OpenBitFun-Installer/src',
  ],
});

const RETIRED_ONLY_ROOTS = ['scripts'];
const STYLE_EXTENSIONS = new Set(['.css', '.scss']);
const SCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx']);
const SKIPPED_DIRECTORIES = new Set(['.git', 'coverage', 'dist', 'node_modules']);
const SELF_AUDIT_FILES = new Set([
  'scripts/audit-typography-tokens.mjs',
  'scripts/audit-typography-tokens.test.mjs',
]);
const WEB_FONT_PROFILE_STYLE_ROOT = 'src/web-ui/src/font-profiles/';
const WEB_FONT_PROFILE_STACK_PROPERTIES = new Set([
  '--openbitfun-font-family-sans',
  '--openbitfun-font-family-control',
  '--openbitfun-font-family-mono',
]);

const SEMANTIC_ROLE_COMPONENT_STYLE_ROOT = 'design-system/packages/ui/src/';
const SEMANTIC_ROLE_COMPONENT_STYLE_EXCEPTIONS = new Set([
  // The bars variant uses the font-size property as a scalable graphic cell,
  // while its user-visible label already consumes type.support.
  'design-system/packages/ui/src/components/Spinner/Spinner.module.css',
]);

const SEMANTIC_ROLE_PRODUCT_STYLE_ROOTS = [
  'packages/flow-chat-presentation/src/',
  'src/web-ui/src/',
  'src/mobile-web/src/',
  'OpenBitFun-Installer/src/',
  'design-system/apps/design-lab/src/',
];

const COMPLETE_PRODUCT_STYLE_ROOTS = [
  'src/web-ui/src/',
  'src/mobile-web/src/',
  'OpenBitFun-Installer/src/',
];

const TYPOGRAPHY_PROPERTIES = new Set([
  'font',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
]);

const APPEARANCE_STYLE_TYPOGRAPHY_PROPERTIES = new Set([
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontVariantNumeric',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
]);

const CSS_PROPERTY_TO_JS_PROPERTY = Object.freeze({
  font: 'font',
  'font-family': 'fontFamily',
  'font-size': 'fontSize',
  'font-weight': 'fontWeight',
  'letter-spacing': 'letterSpacing',
  'line-height': 'lineHeight',
});

const CANONICAL_CSS_VALUE_PATTERNS = Object.freeze({
  fontFamily: /^var\(--openbitfun-(?:font-family-[a-z0-9-]+|type-[a-z0-9-]+-font-family)\)$/i,
  fontSize: /^var\(--openbitfun-(?:font-size-[a-z0-9-]+|type-[a-z0-9-]+-font-size)\)$/i,
  fontWeight: /^var\(--openbitfun-(?:font-weight-[a-z0-9-]+|type-[a-z0-9-]+-font-weight)\)$/i,
  letterSpacing: /^var\(--openbitfun-(?:letter-spacing-[a-z0-9-]+|type-[a-z0-9-]+-letter-spacing)\)$/i,
  lineHeight: /^var\(--openbitfun-(?:line-height-[a-z0-9-]+|type-[a-z0-9-]+-line-height)\)$/i,
});

const COMPOSITE_TYPOGRAPHY_IDENTIFIERS = Object.freeze([
  ['fontFamily', /(?:^|_)font_family(?:_|$)|fontFamily$/i],
  ['fontSize', /(?:^|_)font_size(?:_|$)|fontSize$/i],
  ['fontWeight', /(?:^|_)font_weight(?:_|$)|fontWeight$/i],
  ['letterSpacing', /(?:^|_)letter_spacing(?:_|$)|letterSpacing$/i],
  ['lineHeight', /(?:^|_)line_height(?:_|$)|lineHeight$/i],
  ['font', /(?:^|_)font(?:_|$)/i],
]);

const RETIRED_PATTERNS = Object.freeze([
  {
    code: 'retired-appearance-font-variable',
    pattern: /--openbitfun-appearance-token-font(?:-[a-z0-9_-]+)?/gi,
  },
  {
    code: 'retired-flowchat-font-variable',
    pattern: /--openbitfun-appearance-token-flowchat-font(?:-[a-z0-9_-]+)?/gi,
  },
  {
    code: 'retired-font-token-name',
    pattern: /\bfont\.size\.(?:body|caption|display|small|title)\b/g,
  },
  {
    code: 'retired-font-css-variable',
    pattern: /--openbitfun-font-size-(?:body|caption|display|small|title)\b/g,
  },
  {
    code: 'retired-line-height-token',
    pattern: /\blineHeight\.body\b|--openbitfun-line-height-body\b/g,
  },
  {
    code: 'retired-flowchat-sass-api',
    pattern: /\bflow-type\.\$|\bflow-type\b/g,
  },
  {
    code: 'retired-flowchat-font-api',
    pattern: /\b(?:FlowChatFontMode|resolveFlowChatFontSizeTokens|setFlowChatFont)\b/g,
  },
  {
    code: 'retired-appearance-typography-helper',
    pattern: /\b(?:createChinaTypography|createStandardTypography)\b/g,
  },
  {
    code: 'retired-component-typography-token',
    pattern: /\b(?:control\.activityItem\.inline(?:FontSize|LineHeight)|control\.askUser\.descriptionLineHeight|control\.button\.xsFontSize|control\.changeCount\.fontSize|control\.segmentedControl\.fontSize|control\.statusPill\.fontSize|layout\.formSection\.titleFontSize|layout\.navigationPanel\.headingFontSize|layout\.toolbar\.badgeFontSize|overlay\.menu\.headingFontSize|overlay\.modal\.titleFont(?:Size|Weight)|overlay\.tooltip\.fontSize)\b/g,
  },
  {
    code: 'retired-component-typography-variable',
    pattern: /--openbitfun-(?:control-activity-item-inline-(?:font-size|line-height)|control-ask-user-description-line-height|control-button-xs-font-size|control-change-count-font-size|control-segmented-control-font-size|control-status-pill-font-size|layout-form-section-title-font-size|layout-navigation-panel-heading-font-size|layout-toolbar-badge-font-size|overlay-menu-heading-font-size|overlay-modal-title-font-(?:size|weight)|overlay-tooltip-font-size)\b/g,
  },
]);

const FORBIDDEN_PATHS = Object.freeze([
  'src/web-ui/src/flow_chat/_typography.scss',
]);

const FILE_CONTRACTS = Object.freeze([
  {
    path: 'src/web-ui/src/infrastructure/appearance/builtins/AppearancePalette.ts',
    forbidden: [
      {
        code: 'appearance-owns-typography',
        pattern: /\btypography\s*\??\s*:/,
        message: 'AppearancePalette must not own typography.',
      },
    ],
  },
  {
    path: 'src/web-ui/src/infrastructure/appearance/types/index.ts',
    forbidden: [
      {
        code: 'appearance-font-family-contract-reintroduced',
        pattern: /\b(?:AppearanceFontFamily(?:Literal|Value)|fontFamilies)\b/,
        message: 'Appearance packages must not define a parallel font-family token contract.',
      },
    ],
  },
  {
    path: 'src/web-ui/src/infrastructure/appearance/compiler/AppearanceCompiler.ts',
    forbidden: [
      {
        code: 'appearance-compiler-typography-reintroduced',
        pattern: /\b(?:fontFamily|fontSize|fontWeight|fontVariantNumeric|lineHeight|letterSpacing)\b|(?:^|\s)fontStyle\s*:/m,
        message: 'AppearanceCompiler must not compile typography properties.',
      },
    ],
  },
  {
    path: 'src/web-ui/src/infrastructure/appearance/schema/AppearancePackageValidator.ts',
    forbidden: [
      {
        code: 'appearance-validator-typography-reintroduced',
        pattern: /\b(?:fontFamilies|fontFamily|fontSize|fontWeight|fontStyle|fontVariantNumeric|lineHeight|letterSpacing)\b/,
        message: 'Appearance package validation must not accept typography properties or globals.',
      },
    ],
  },
  {
    path: 'src/web-ui/src/infrastructure/appearance/appearancePropertyProfiles.ts',
    forbidden: [
      {
        code: 'appearance-profile-typography-reintroduced',
        pattern: /['"](?:fontFamily|fontSize|fontWeight|fontStyle|fontVariantNumeric|lineHeight|letterSpacing)['"]/,
        message: 'Appearance property profiles must not expose typography properties.',
      },
    ],
  },
  {
    path: 'src/web-ui/src/infrastructure/appearance/builtins/composeAppearancePackage.ts',
    forbidden: [
      {
        code: 'appearance-font-global-merge-reintroduced',
        pattern: /\bfontFamilies\b/,
        message: 'Appearance package composition must not merge font-family globals.',
      },
    ],
  },
  {
    path: 'src/web-ui/src/infrastructure/font-preference/types/index.ts',
    forbidden: [
      {
        code: 'flowchat-font-preference-reintroduced',
        pattern: /\bflowChat\s*:/,
        message: 'FontPreference must not expose a FlowChat-specific font scale.',
      },
    ],
  },
  {
    path: 'src/web-ui/src/infrastructure/font-preference/core/FontPreferenceService.ts',
    required: [
      {
        code: 'canonical-font-runtime-missing',
        pattern: /setProperty\(`--openbitfun-font-size-\$\{key\}`/,
        message: 'Global font preference must override canonical --openbitfun-font-size-* primitives.',
      },
    ],
    forbidden: [
      {
        code: 'appearance-font-runtime-reintroduced',
        pattern: /--openbitfun-appearance-token-(?:flowchat-)?font/,
        message: 'FontPreferenceService must not write Appearance or FlowChat font variables.',
      },
      {
        code: 'flowchat-font-runtime-reintroduced',
        pattern: /\bflowChat\b/,
        message: 'FontPreferenceService must not own a FlowChat-specific font preference.',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/src/service/config/types.rs',
    forbidden: [
      {
        code: 'backend-flowchat-font-snapshot-reintroduced',
        pattern: /\bFlowChatFontSnapshot\b|pub struct FontPreferenceSnapshot\s*\{(?:(?!\r?\n\})[\s\S])*?\bpub\s+flow_chat\s*:/,
        message: 'Persisted font preferences must not expose a FlowChat-specific font snapshot.',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/builtin_skills/create-openbitfun-skin/references/appearance-registry.json',
    forbidden: [
      {
        code: 'appearance-registry-flowchat-font-contract-reintroduced',
        pattern: /"flowChatControls"|--openbitfun-appearance-token-flowchat-font/,
        message: 'The distributed Appearance registry must not advertise retired FlowChat typography controls or variables.',
      },
    ],
  },
  {
    path: 'src/crates/assembly/core/builtin_skills/create-openbitfun-skin/scripts/openbitfun_appearance.py',
    forbidden: [
      {
        code: 'standalone-appearance-typography-reintroduced',
        pattern: /\b(?:fontFamilies|validate_font_family)\b|"(?:fontFamily|fontSize|fontWeight|fontWeightBold|fontVariantNumeric|lineHeight|letterSpacing)"|(?:STYLE_PROPERTIES|PAINT_PROPERTIES)\s*=\s*\{[^}]*"fontStyle"|^\s*"fontStyle"\s*:/m,
        message: 'The standalone Appearance validator must not accept typography globals, Style IR, or renderer settings.',
      },
    ],
  },
]);

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function createIssue(relativePath, line, code, message, excerpt = '') {
  return {
    code,
    excerpt: excerpt.trim(),
    line,
    message,
    path: normalizePath(relativePath),
  };
}

function isTestFile(relativePath) {
  return /(?:^|\/)__tests__(?:\/|$)|\.(?:spec|test)\.[^.]+$/i.test(relativePath);
}

function findNegativeTestRanges(text, relativePath) {
  const ranges = [];
  const issues = [];
  const lines = text.split(/\r?\n/);
  let start = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const startMatch = line.match(/typography-audit:\s*negative-test-start\s*--\s*(\S.*)$/);
    if (startMatch) {
      if (!isTestFile(relativePath)) {
        issues.push(createIssue(
          relativePath,
          index + 1,
          'invalid-negative-test-suppression',
          'Retired typography references may only be suppressed in test files.',
          line,
        ));
      } else if (start !== null) {
        issues.push(createIssue(
          relativePath,
          index + 1,
          'nested-negative-test-suppression',
          'Negative-test suppression blocks cannot be nested.',
          line,
        ));
      } else {
        start = index + 1;
      }
      continue;
    }

    if (/typography-audit:\s*negative-test-end\b/.test(line)) {
      if (start === null) {
        issues.push(createIssue(
          relativePath,
          index + 1,
          'orphan-negative-test-suppression',
          'Negative-test suppression end marker has no matching start marker.',
          line,
        ));
      } else {
        ranges.push([start, index + 1]);
        start = null;
      }
    }
  }

  if (start !== null) {
    issues.push(createIssue(
      relativePath,
      start,
      'unclosed-negative-test-suppression',
      'Negative-test suppression block must have an end marker.',
    ));
  }

  return { issues, ranges };
}

function isLineInRanges(line, ranges) {
  return ranges.some(([start, end]) => line >= start && line <= end);
}

function hasLocalTypographyException(lines, lineNumber) {
  const currentLine = lines[lineNumber - 1] ?? '';
  const previousLine = lines[lineNumber - 2] ?? '';
  return [currentLine, previousLine].some(line => (
    /typography-audit:\s*allow\s*--\s*\S.*$/.test(line)
  ));
}

function stripCommentsPreservingLines(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\r\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, line => line.replace(/[^\r\n]/g, ' '));
}

function normalizeCssValue(value) {
  return value
    .replace(/\s*!important\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cssAtRuleRanges(source, atRulePattern) {
  const ranges = [];
  const pattern = new RegExp(`${atRulePattern}\\s*\\{`, 'gi');
  for (const match of source.matchAll(pattern)) {
    const openBrace = (match.index ?? 0) + match[0].lastIndexOf('{');
    let depth = 1;
    for (let index = openBrace + 1; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}') depth -= 1;
      if (depth === 0) {
        ranges.push([openBrace, index]);
        break;
      }
    }
  }
  return ranges;
}

function isBuildOwnedWebFontDeclaration(relativePath, source, offset, property, customProperty) {
  if (!normalizePath(relativePath).startsWith(WEB_FONT_PROFILE_STYLE_ROOT)) return false;

  if (customProperty) {
    return property === 'fontFamily'
      && WEB_FONT_PROFILE_STACK_PROPERTIES.has(customProperty.toLowerCase());
  }

  if (property !== 'fontFamily' && property !== 'fontWeight') return false;
  return cssAtRuleRanges(source, '@font-face').some(([start, end]) => (
    offset >= start && offset <= end
  ));
}

function isStructuralZero(property, value) {
  return (property === 'fontSize' || property === 'lineHeight') && /^0(?:\.0+)?$/.test(value);
}

function isCanonicalTypographyValue(property, rawValue) {
  const value = normalizeCssValue(rawValue);
  if (value === 'inherit') return true;
  if (isStructuralZero(property, value)) return true;
  if (property === 'font') return false;
  if (/^var\(--_[a-z0-9-]+\)$/i.test(value)) return true;
  return CANONICAL_CSS_VALUE_PATTERNS[property]?.test(value) ?? false;
}

function auditCssDeclarations(text, relativePath) {
  const issues = [];
  const lines = text.split(/\r?\n/);
  const source = stripCommentsPreservingLines(text);
  const pattern = /(?:^|[;{}\r\n])\s*(font-family|font-size|font-weight|letter-spacing|line-height|font)\s*:\s*([^;{}\r\n]+)(?:;|(?=\}))/gi;

  for (const match of source.matchAll(pattern)) {
    const cssProperty = match[1].toLowerCase();
    const property = CSS_PROPERTY_TO_JS_PROPERTY[cssProperty];
    const value = match[2].trim();
    const propertyOffset = match[0].indexOf(match[1]);
    const line = lineNumberAt(source, (match.index ?? 0) + Math.max(0, propertyOffset));

    // Template interpolation is runtime-provided. Static raw values inside scripts
    // are still caught because they contain no interpolation marker.
    if (value.includes('${')) continue;
    if (isCanonicalTypographyValue(property, value)) continue;
    if (isBuildOwnedWebFontDeclaration(relativePath, source, match.index ?? 0, property)) continue;
    if (hasLocalTypographyException(lines, line)) continue;

    issues.push(createIssue(
      relativePath,
      line,
      'raw-css-typography',
      `${cssProperty} must use a canonical --openbitfun typography token.`,
      `${cssProperty}: ${value}`,
    ));
  }

  const customPropertyPattern = /(?:^|[;{}\r\n])\s*(--[a-z0-9_-]*(?:font-family|font-size|font-weight|letter-spacing|line-height)[a-z0-9_-]*)\s*:\s*([^;{}\r\n]+)(?:;|(?=\}))/gi;
  for (const match of source.matchAll(customPropertyPattern)) {
    const customProperty = match[1];
    const cssProperty = [
      'font-family',
      'font-size',
      'font-weight',
      'letter-spacing',
      'line-height',
    ]
      .find(candidate => customProperty.toLowerCase().includes(candidate));
    const property = CSS_PROPERTY_TO_JS_PROPERTY[cssProperty];
    const value = match[2].trim();
    const propertyOffset = match[0].indexOf(match[1]);
    const line = lineNumberAt(source, (match.index ?? 0) + Math.max(0, propertyOffset));
    const normalizedValue = normalizeCssValue(value);
    if (
      isCanonicalTypographyValue(property, value)
      || /^var\(--_[a-z0-9-]+\)$/i.test(normalizedValue)
      || isBuildOwnedWebFontDeclaration(
        relativePath,
        source,
        match.index ?? 0,
        property,
        customProperty,
      )
      || hasLocalTypographyException(lines, line)
    ) {
      continue;
    }
    issues.push(createIssue(
      relativePath,
      line,
      'raw-private-typography-token',
      `${customProperty} must resolve to a canonical --openbitfun typography token.`,
      `${customProperty}: ${value}`,
    ));
  }

  return issues;
}

function propertyNameText(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
}

function typographyPropertyFromIdentifier(name, allowComposite = false) {
  if (!name) return null;
  if (TYPOGRAPHY_PROPERTIES.has(name)) return name;
  if (!allowComposite) return null;
  for (const [property, pattern] of COMPOSITE_TYPOGRAPHY_IDENTIFIERS) {
    if (pattern.test(name)) return property;
  }
  return null;
}

function literalValue(node) {
  if (!node) return null;
  if (ts.isNumericLiteral(node)) return { kind: 'number', value: Number(node.text) };
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return null;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: 'string', value: node.text };
  }
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    const sign = node.operator === ts.SyntaxKind.MinusToken ? -1 : 1;
    return { kind: 'number', value: sign * Number(node.operand.text) };
  }
  return null;
}

function isSchemaPropertyMapping(property, value) {
  const mappings = {
    fontFamily: 'font-family',
    fontSize: 'font-size',
    fontWeight: 'font-weight',
    letterSpacing: 'letter-spacing',
    lineHeight: 'line-height',
  };
  return mappings[property] === value;
}

function isRawTypographyLiteral(property, literal) {
  if (!literal) return false;
  if (literal.kind === 'number') {
    return !isStructuralZero(property, String(literal.value));
  }

  const value = literal.value.trim();
  if (isSchemaPropertyMapping(property, value)) return false;
  if (isCanonicalTypographyValue(property, value)) return false;

  switch (property) {
    case 'font':
      return /(?:^|\s)(?:caption|icon|menu|message-box|small-caption|status-bar)(?:\s|$)/i.test(value)
        || /(?:\d|\.)+(?:px|r?em|%|pt)(?:\s|\/|$)/i.test(value)
        || value.includes('/');
    case 'fontFamily':
      return value.length > 0;
    case 'fontSize':
    case 'letterSpacing':
      return /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|r?em|%|pt)?$/i.test(value)
        || /^(?:calc|clamp|min|max)\(/i.test(value);
    case 'fontWeight':
      return /^(?:normal|bold|bolder|lighter|[1-9]00)$/i.test(value);
    case 'lineHeight':
      return /^(?:normal|-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|r?em|%)?)$/i.test(value)
        || /^(?:calc|clamp|min|max)\(/i.test(value);
    default:
      return false;
  }
}

function isFoundationTypographyLiteral(literal) {
  return literal?.kind === 'string'
    && /^var\(--openbitfun-(?:font-(?:family|size|weight)|line-height|letter-spacing)-[a-z0-9-]+\)$/i.test(literal.value.trim());
}

function scriptKindForPath(relativePath) {
  if (relativePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (relativePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (relativePath.endsWith('.js') || relativePath.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function auditScriptTypography(text, relativePath) {
  const issues = [];
  const sourceFile = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(relativePath),
  );

  function report(node, property, literal) {
    if (requiresSemanticRoleConsumption(relativePath) && isFoundationTypographyLiteral(literal)) {
      const start = node.getStart(sourceFile);
      const { line } = sourceFile.getLineAndCharacterOfPosition(start);
      issues.push(createIssue(
        relativePath,
        line + 1,
        'foundation-typography-in-semantic-consumer',
        'Product frontend inline text styles must consume a semantic --openbitfun-type-* role.',
        node.getText(sourceFile),
      ));
      return;
    }
    if (!isRawTypographyLiteral(property, literal)) return;
    const start = node.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(start);
    if (hasLocalTypographyException(text.split(/\r?\n/), line + 1)) return;
    issues.push(createIssue(
      relativePath,
      line + 1,
      'raw-script-typography',
      `${property} must come from a canonical design token or a runtime preference.`,
      node.getText(sourceFile),
    ));
  }

  function visit(node) {
    if (ts.isPropertyAssignment(node)) {
      const property = typographyPropertyFromIdentifier(propertyNameText(node.name));
      if (property) report(node, property, literalValue(node.initializer));
    } else if (ts.isBindingElement(node) && node.initializer) {
      const property = typographyPropertyFromIdentifier(propertyNameText(node.name));
      if (property) report(node, property, literalValue(node.initializer));
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const property = typographyPropertyFromIdentifier(node.name.text, true);
      if (property) report(node, property, literalValue(node.initializer));
    } else if (ts.isJsxAttribute(node)) {
      const property = typographyPropertyFromIdentifier(propertyNameText(node.name));
      if (property) {
        if (node.initializer && ts.isStringLiteral(node.initializer)) {
          report(node, property, literalValue(node.initializer));
        } else if (
          node.initializer
          && ts.isJsxExpression(node.initializer)
          && node.initializer.expression
        ) {
          report(node, property, literalValue(node.initializer.expression));
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return issues;
}

function auditRetiredReferences(text, relativePath) {
  if (SELF_AUDIT_FILES.has(relativePath)) return [];

  const { issues, ranges } = findNegativeTestRanges(text, relativePath);
  for (const { code, pattern } of RETIRED_PATTERNS) {
    const expression = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(expression)) {
      const line = lineNumberAt(text, match.index ?? 0);
      if (isLineInRanges(line, ranges)) continue;
      issues.push(createIssue(
        relativePath,
        line,
        code,
        'Retired typography APIs and variables may appear only inside an explicit negative-test block.',
        match[0],
      ));
    }
  }
  return issues;
}

function requiresSemanticRoleConsumption(relativePath) {
  if (relativePath.startsWith(WEB_FONT_PROFILE_STYLE_ROOT)) return false;

  return (
    relativePath.startsWith(SEMANTIC_ROLE_COMPONENT_STYLE_ROOT)
    && relativePath.endsWith('.module.css')
    && !SEMANTIC_ROLE_COMPONENT_STYLE_EXCEPTIONS.has(relativePath)
  )
    || SEMANTIC_ROLE_PRODUCT_STYLE_ROOTS.some(root => relativePath.startsWith(root));
}

function auditSemanticRoleConsumption(text, relativePath) {
  if (!requiresSemanticRoleConsumption(relativePath)) return [];

  const issues = [];
  const source = stripCommentsPreservingLines(text);
  const lines = text.split(/\r?\n/);
  const governsCompleteProductStyle = COMPLETE_PRODUCT_STYLE_ROOTS.some(root => relativePath.startsWith(root))
    && STYLE_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
  const foundationPattern = governsCompleteProductStyle
    ? /(--openbitfun-(?:font-family|font-size|font-weight|line-height|letter-spacing)-[a-z0-9-]+)/gi
    : /(?:font-family|font-size|font-weight|line-height|letter-spacing)\s*:\s*[^;{}\r\n]*?(--openbitfun-(?:font-family|font-size|font-weight|line-height|letter-spacing)-[a-z0-9-]+)/gi;
  for (const match of source.matchAll(foundationPattern)) {
    const token = match[1];
    const tokenOffset = match[0].lastIndexOf(token);
    const line = lineNumberAt(source, (match.index ?? 0) + Math.max(0, tokenOffset));
    if (hasLocalTypographyException(lines, line)) continue;
    issues.push(createIssue(
      relativePath,
      line,
      'foundation-typography-in-semantic-consumer',
      'Text-bearing public components and migrated product surfaces must consume a semantic --openbitfun-type-* role.',
      token,
    ));
  }

  const hasTypographyDeclaration = /(?:^|[;{}\r\n])\s*(?:font-family|font-size|font-weight|letter-spacing|line-height)\s*:/im.test(source);
  if (hasTypographyDeclaration && !/--openbitfun-type-[a-z0-9-]+-(?:font-family|font-size|font-weight|letter-spacing|line-height)/i.test(source)) {
    issues.push(createIssue(
      relativePath,
      1,
      'semantic-typography-role-missing',
      'A governed text-bearing stylesheet must identify its typography through a semantic --openbitfun-type-* role.',
    ));
  }

  return issues;
}

export function auditTypographyText(text, relativePath, options = {}) {
  const normalizedPath = normalizePath(relativePath);
  const extension = path.extname(normalizedPath).toLowerCase();
  const productionSource = !isTestFile(normalizedPath);
  const issues = auditRetiredReferences(text, normalizedPath);

  if (options.retiredOnly) return issues;
  if (STYLE_EXTENSIONS.has(extension) && productionSource) {
    issues.push(...auditCssDeclarations(text, normalizedPath));
    issues.push(...auditSemanticRoleConsumption(text, normalizedPath));
  }
  if (SCRIPT_EXTENSIONS.has(extension) && productionSource) {
    issues.push(...auditCssDeclarations(text, normalizedPath));
    issues.push(...auditSemanticRoleConsumption(text, normalizedPath));
    issues.push(...auditScriptTypography(text, normalizedPath));
  }

  return issues;
}

function walkFiles(absoluteRoot) {
  if (!fs.existsSync(absoluteRoot)) return [];
  const files = [];
  const stack = [absoluteRoot];

  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

export function auditTypographyFileContractText(text, relativePath) {
  const normalizedPath = normalizePath(relativePath);
  const contract = FILE_CONTRACTS.find(candidate => candidate.path === normalizedPath);
  if (!contract) return [];

  const issues = [];
  for (const rule of contract.required ?? []) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    if (!pattern.test(text)) {
      issues.push(createIssue(normalizedPath, 1, rule.code, rule.message));
    }
  }
  for (const rule of contract.forbidden ?? []) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    const match = text.match(pattern);
    if (match) {
      issues.push(createIssue(
        normalizedPath,
        lineNumberAt(text, match.index ?? 0),
        rule.code,
        rule.message,
        match[0],
      ));
    }
  }

  if (normalizedPath === 'src/web-ui/src/infrastructure/appearance/types/index.ts') {
    const sourceFile = ts.createSourceFile(
      normalizedPath,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const appearanceStyle = sourceFile.statements.find(statement => (
      ts.isInterfaceDeclaration(statement)
      && statement.name.text === 'AppearanceStyle'
    ));
    if (appearanceStyle && ts.isInterfaceDeclaration(appearanceStyle)) {
      for (const member of appearanceStyle.members) {
        const property = propertyNameText(member.name);
        if (!property || !APPEARANCE_STYLE_TYPOGRAPHY_PROPERTIES.has(property)) continue;
        const start = member.getStart(sourceFile);
        const { line } = sourceFile.getLineAndCharacterOfPosition(start);
        issues.push(createIssue(
          normalizedPath,
          line + 1,
          'appearance-style-typography-reintroduced',
          'AppearanceStyle must not expose typography properties.',
          member.getText(sourceFile),
        ));
      }
    }
  }
  return issues;
}

function auditFileContracts(repositoryRoot, scope) {
  if (scope === 'design-system') return [];
  const issues = [];

  for (const relativePath of FORBIDDEN_PATHS) {
    if (fs.existsSync(path.join(repositoryRoot, relativePath))) {
      issues.push(createIssue(
        relativePath,
        1,
        'retired-typography-file',
        'Retired typography ownership file must stay deleted.',
      ));
    }
  }

  for (const contract of FILE_CONTRACTS) {
    const absolutePath = path.join(repositoryRoot, contract.path);
    if (!fs.existsSync(absolutePath)) {
      issues.push(createIssue(
        contract.path,
        1,
        'missing-typography-owner',
        'Typography architecture owner is missing.',
      ));
      continue;
    }

    issues.push(...auditTypographyFileContractText(
      fs.readFileSync(absolutePath, 'utf8'),
      contract.path,
    ));
  }

  return issues;
}

export function auditTypographyRepository(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT);
  const scope = options.scope ?? 'all';
  if (!['all', 'design-system', 'web-ui'].includes(scope)) {
    throw new TypeError(`Unknown typography audit scope: ${scope}`);
  }

  const sourceRoots = scope === 'all'
    ? [...SOURCE_GROUPS['design-system'], ...SOURCE_GROUPS['web-ui']]
    : SOURCE_GROUPS[scope];
  const issues = [];

  for (const sourceRoot of sourceRoots) {
    for (const absolutePath of walkFiles(path.join(repositoryRoot, sourceRoot))) {
      const relativePath = normalizePath(path.relative(repositoryRoot, absolutePath));
      const extension = path.extname(relativePath).toLowerCase();
      if (!STYLE_EXTENSIONS.has(extension) && !SCRIPT_EXTENSIONS.has(extension)) continue;
      issues.push(...auditTypographyText(fs.readFileSync(absolutePath, 'utf8'), relativePath));
    }
  }

  if (scope === 'all') {
    for (const sourceRoot of RETIRED_ONLY_ROOTS) {
      for (const absolutePath of walkFiles(path.join(repositoryRoot, sourceRoot))) {
        const relativePath = normalizePath(path.relative(repositoryRoot, absolutePath));
        const extension = path.extname(relativePath).toLowerCase();
        if (!SCRIPT_EXTENSIONS.has(extension)) continue;
        issues.push(...auditTypographyText(
          fs.readFileSync(absolutePath, 'utf8'),
          relativePath,
          { retiredOnly: true },
        ));
      }
    }
  }

  issues.push(...auditFileContracts(repositoryRoot, scope));
  return issues.sort((left, right) => (
    left.path.localeCompare(right.path)
    || left.line - right.line
    || left.code.localeCompare(right.code)
  ));
}

function parseCliArguments(argv) {
  let scope = 'all';
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      json = true;
    } else if (argument === '--scope') {
      scope = argv[index + 1];
      index += 1;
    } else {
      throw new TypeError(`Unknown typography audit argument: ${argument}`);
    }
  }
  return { json, scope };
}

function printIssues(issues, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ issues }, null, 2)}\n`);
    return;
  }

  if (issues.length === 0) {
    process.stdout.write('Typography token audit passed with zero violations.\n');
    return;
  }

  process.stderr.write(`Typography token audit found ${issues.length} violation(s):\n`);
  for (const issue of issues) {
    const excerpt = issue.excerpt ? ` (${issue.excerpt})` : '';
    process.stderr.write(`- ${issue.path}:${issue.line} [${issue.code}] ${issue.message}${excerpt}\n`);
  }
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  try {
    const { json, scope } = parseCliArguments(process.argv.slice(2));
    const issues = auditTypographyRepository({ scope });
    printIssues(issues, json);
    if (issues.length > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
