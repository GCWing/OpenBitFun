#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  CANONICAL_THEME_COLOR_TOKENS,
  COLOR_DOMAIN_KEYS,
  COLOR_DOMAIN_LABELS,
  COLOR_DOMAIN_CONTRACTS,
  COLOR_DOMAIN_RULES,
  COLOR_EXTENSIONS,
  CONTRACT_VAR_DEFINITION_PATH_PARTS,
  DEFAULT_BASELINE_PATH,
  DEFAULT_ROOT,
  DYNAMIC_VAR_FAMILY_CONTRACTS,
  EXCEPTION_PATH_PARTS,
  FALLBACK_VAR_CONTRACTS,
  PACKAGE_CSS_VAR_DEFINITION_CONTRACTS,
  PACKAGE_CSS_VAR_IMPORT_CONTRACTS,
  REGISTERED_DYNAMIC_VAR_PREFIXES,
  RUNTIME_CONTRACT_VAR_DEFINITION_PATH_PARTS,
  STATIC_CONTRACT_VAR_DEFINITION_PATH_PARTS,
  SURFACE_TOKEN_RENAME_CONTRACTS,
  TOKEN_COMPATIBILITY_ALIAS_CONTRACTS,
  TOKEN_COMPATIBILITY_ALIAS_FAMILY_CONTRACTS,
  TOKEN_ALIAS_SOURCE_PATH_PARTS,
  TOKEN_PATH_PARTS,
} from './theme-css-var-contract.mjs';
import { writeReportJson } from './theme-color-audit-utils.mjs';

const COLOR_PATTERN =
  /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*[-+]?\d*\.?\d+\s*,\s*[-+]?\d*\.?\d+\s*,\s*[-+]?\d*\.?\d+(?:\s*,\s*(?:[-+]?\d*\.?\d+|var\([^)]+\)))?\s*\)|hsla?\(\s*[-+]?\d*\.?\d+(?:deg|rad|turn)?\s*,\s*[-+]?\d*\.?\d+%\s*,\s*[-+]?\d*\.?\d+%(?:\s*,\s*(?:[-+]?\d*\.?\d+|var\([^)]+\)))?\s*\)/g;
const CSS_NAMED_COLORS = new Set(`
  aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue
  blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson
  cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta
  darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray
  darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick
  floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey
  honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon
  lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink
  lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime
  limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen
  mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose
  moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen
  paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red
  rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue
  slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white
  whitesmoke yellow yellowgreen
`.trim().split(/\s+/));
const CSS_NAMED_COLOR_PATTERN = new RegExp(
  `(?:^|[^\\w-])(${Array.from(CSS_NAMED_COLORS).sort((a, b) => b.length - a.length).join('|')})(?![\\w-])`,
  'gi',
);
const COMMON_NAMED_COLOR_RGB = new Map([
  ['black', [0, 0, 0]],
  ['silver', [192, 192, 192]],
  ['gray', [128, 128, 128]],
  ['grey', [128, 128, 128]],
  ['white', [255, 255, 255]],
  ['maroon', [128, 0, 0]],
  ['red', [255, 0, 0]],
  ['purple', [128, 0, 128]],
  ['fuchsia', [255, 0, 255]],
  ['magenta', [255, 0, 255]],
  ['green', [0, 128, 0]],
  ['lime', [0, 255, 0]],
  ['olive', [128, 128, 0]],
  ['yellow', [255, 255, 0]],
  ['navy', [0, 0, 128]],
  ['blue', [0, 0, 255]],
  ['teal', [0, 128, 128]],
  ['aqua', [0, 255, 255]],
  ['cyan', [0, 255, 255]],
  ['orange', [255, 165, 0]],
  ['rebeccapurple', [102, 51, 153]],
]);
const STYLE_SOURCE_EXTENSIONS = new Set(['.css', '.less', '.sass', '.scss']);
const MARKUP_SOURCE_EXTENSIONS = new Set(['.html', '.svg']);
const CSS_DECLARATION_PATTERN =
  /(?:^|[;{])\s*((?:--|\$)?[a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*([^;{}]+)/gm;
const CSS_COLOR_ATTRIBUTE_PATTERN = new RegExp(
  `(?:^|[^\\w-])(?:color|fill|stroke|stop-color|flood-color|lighting-color)\\s*=\\s*['"](${Array.from(CSS_NAMED_COLORS).join('|')})['"]`,
  'gi',
);
const SCRIPT_COLOR_VALUE_PATTERN = new RegExp(
  `(?:^|[,{;\\s])(?:color|backgroundColor|borderColor|outlineColor|caretColor|textDecorationColor|fill|stroke)\\s*:\\s*['"\\x60](${Array.from(CSS_NAMED_COLORS).join('|')})['"\\x60]`,
  'gi',
);
const RGB_CHANNEL_SOURCE = '(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)';
const RAW_RGB_CHANNEL_DEFINITION_PATTERN = new RegExp(
  `(?:^|[;{])\\s*(?:--|\\$)[a-zA-Z_][a-zA-Z0-9_-]*\\s*:\\s*(${RGB_CHANNEL_SOURCE}\\s*,\\s*${RGB_CHANNEL_SOURCE}\\s*,\\s*${RGB_CHANNEL_SOURCE})\\s*(?=;|})`,
  'gm',
);
const TOKEN_ALIAS_DEFINITION_PATTERN =
  /(?:^|[;{\s])(\$[a-zA-Z0-9_-]+|--[a-zA-Z0-9_-]+)\s*:\s*(#[0-9a-fA-F]{3,8}\b|rgba?\(\s*[-+]?\d*\.?\d+\s*,\s*[-+]?\d*\.?\d+\s*,\s*[-+]?\d*\.?\d+(?:\s*,\s*(?:[-+]?\d*\.?\d+|var\([^)]+\)))?\s*\)|hsla?\(\s*[-+]?\d*\.?\d+(?:deg|rad|turn)?\s*,\s*[-+]?\d*\.?\d+%\s*,\s*[-+]?\d*\.?\d+%(?:\s*,\s*(?:[-+]?\d*\.?\d+|var\([^)]+\)))?\s*\))/gm;
const CSS_VAR_USAGE_PATTERN = /var\(\s*(--[a-zA-Z0-9_-]+)/g;
const CSS_VAR_DEFINITION_PATTERN = /(^|[;{\s])(--[a-zA-Z0-9_-]+)\s*:/g;
const VAR_FALLBACK_PATTERN = /var\(\s*(--[a-zA-Z0-9_-]+)\s*,/g;
const CSS_VAR_SET_PROPERTY_PATTERN = /\.setProperty\(\s*['"`](--[a-zA-Z0-9_-]+)/g;
const CSS_VAR_INLINE_STYLE_PATTERN = /['"`](--[a-zA-Z0-9_-]+)['"`]\s*:/g;
const CSS_VAR_DYNAMIC_SET_PATTERN = /\.setProperty\(\s*`(--[a-zA-Z0-9_-]*)\$\{/g;
const CSS_VAR_COLOR_RAMP_PATTERN = /colorRamp\(\s*['"`](--[a-zA-Z0-9_-]+)['"`]/g;
const CSS_VAR_LITERAL_PATTERN = /['"`](--[a-zA-Z0-9_-]+)['"`]/g;
const GENERATED_WIDGET_APPEARANCE_PAYLOAD_PATH = 'infrastructure/appearance/adapters/widgetAppearanceVariables.ts';
const REPORT_ROW_LIMIT = 100;
const COLOR_DOMAIN_CONTRACT_BY_KEY = new Map(COLOR_DOMAIN_CONTRACTS.map(contract => [contract.key, contract]));
const FALLBACK_VAR_CONTRACT_BY_KEY = new Map(FALLBACK_VAR_CONTRACTS.map(contract => [contract.key, contract]));
const VENDORED_GENUI_EXCLUSIONS = [
  'src/tools/generative-ui/components/openui',
  'src/tools/generative-ui/components/openuiLibrary.tsx',
  'src/tools/generative-ui/components/vendor',
];
const TOKEN_COMPATIBILITY_ALIAS_BY_KEY = new Map(
  TOKEN_COMPATIBILITY_ALIAS_CONTRACTS.map(contract => [contract.key, contract]),
);

function resolveCompatibilityAliasContract(name) {
  const explicit = TOKEN_COMPATIBILITY_ALIAS_BY_KEY.get(name);
  if (explicit) {
    return explicit;
  }

  const family = TOKEN_COMPATIBILITY_ALIAS_FAMILY_CONTRACTS.find(contract => (
    name.startsWith(contract.prefix)
    && name.length > contract.prefix.length
  ));
  if (!family) {
    return null;
  }

  return {
    key: name,
    canonical: `${family.canonicalPrefix}${name.slice(family.prefix.length)}`,
    owner: family.owner,
    reason: family.reason,
    removal: family.removal,
    familyPrefix: family.prefix,
    canonicalPrefix: family.canonicalPrefix,
  };
}

function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    json: false,
    reportJson: null,
    baselinePath: undefined,
    noBaseline: false,
    packageContracts: [],
    excludePaths: [],
    top: 15,
    budget: 120,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--report-json') {
      options.reportJson = argv[++index];
      if (!options.reportJson) {
        throw new Error('--report-json requires an output path');
      }
    } else if (arg.startsWith('--report-json=')) {
      options.reportJson = arg.slice('--report-json='.length);
      if (!options.reportJson) {
        throw new Error('--report-json requires an output path');
      }
    } else if (arg === '--baseline') {
      options.baselinePath = argv[++index];
      if (!options.baselinePath) {
        throw new Error('--baseline requires a baseline path');
      }
    } else if (arg.startsWith('--baseline=')) {
      options.baselinePath = arg.slice('--baseline='.length);
      if (!options.baselinePath) {
        throw new Error('--baseline requires a baseline path');
      }
    } else if (arg === '--no-baseline') {
      options.noBaseline = true;
    } else if (arg === '--package-contract') {
      const packageName = argv[++index];
      if (!packageName) {
        throw new Error('--package-contract requires a package name');
      }
      options.packageContracts.push(packageName);
    } else if (arg.startsWith('--package-contract=')) {
      const packageName = arg.slice('--package-contract='.length);
      if (!packageName) {
        throw new Error('--package-contract requires a package name');
      }
      options.packageContracts.push(packageName);
    } else if (arg === '--exclude') {
      const excludePath = argv[++index];
      if (!excludePath) {
        throw new Error('--exclude requires a root-relative path');
      }
      options.excludePaths.push(excludePath);
    } else if (arg.startsWith('--exclude=')) {
      const excludePath = arg.slice('--exclude='.length);
      if (!excludePath) {
        throw new Error('--exclude requires a root-relative path');
      }
      options.excludePaths.push(excludePath);
    } else if (arg === '--root') {
      options.root = argv[++index] ?? DEFAULT_ROOT;
    } else if (arg === '--top') {
      options.top = Number(argv[++index] ?? options.top);
    } else if (arg === '--budget') {
      options.budget = Number(argv[++index] ?? options.budget);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  // The checked-in OpenUI/Harmony resources are vendored renderer payloads;
  // their upstream palette and fallback variables are audited by their own
  // source boundary rather than Web UI app-token budgets. Apply this only to
  // the repository's real Web UI root so fixture roots remain explicit.
  if (path.resolve(options.root) === path.resolve(DEFAULT_ROOT)) {
    for (const exclusion of VENDORED_GENUI_EXCLUSIONS) {
      if (!options.excludePaths.includes(exclusion)) options.excludePaths.push(exclusion);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/audit-theme-colors.mjs [options]

Options:
  --root <path>          Directory to scan. Default: ${DEFAULT_ROOT}
  --top <number>         Number of top rows to print. Default: 15
  --budget <number>      Unique app color budget for the summary. Default: 120
  --baseline <path>      Enforce a theme color governance baseline.
  --no-baseline          Disable baseline enforcement.
  --package-contract <name>
                         Treat a declared design-system package as an external CSS variable owner.
  --exclude <path>       Exclude an explicit root-relative file or directory. Repeatable.
  --json                 Print machine-readable JSON instead of text.
  --report-json <path>   Write the machine-readable report to a file.
`);
}

function walkFiles(root) {
  const result = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && COLOR_EXTENSIONS.has(path.extname(entry.name))) {
        result.push(fullPath);
      }
    }
  }

  return result.sort();
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function normalizeRootRelativePath(filePath) {
  return normalizePath(path.normalize(filePath))
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
}

function isExplicitlyExcluded(rootRelativePath, excludePaths) {
  const normalizedPath = normalizeRootRelativePath(rootRelativePath);
  return excludePaths.some((excludePath) => {
    const normalizedExclude = normalizeRootRelativePath(excludePath);
    return normalizedPath === normalizedExclude || normalizedPath.startsWith(`${normalizedExclude}/`);
  });
}

function isAuditTestFile(relativePath) {
  return (
    /(^|\/)__tests__\//.test(relativePath)
    || /\.(?:test|spec)\.[a-z0-9]+$/i.test(relativePath)
  );
}

function isGeneratedBuildArtifact(rootRelativePath) {
  return (
    rootRelativePath === 'generated/version.ts'
    || rootRelativePath === 'generated/version-injection.html'
    || rootRelativePath.startsWith('public/monaco-editor/')
  );
}

function isTokenFile(relativePath) {
  return TOKEN_PATH_PARTS.some(part => relativePath.includes(part));
}

function isTokenAliasSourceFile(relativePath) {
  return TOKEN_ALIAS_SOURCE_PATH_PARTS.some(part => relativePath.includes(part));
}

function isContractVarDefinitionFile(relativePath) {
  return CONTRACT_VAR_DEFINITION_PATH_PARTS.some(part => relativePath.includes(part));
}

function isStaticContractVarDefinitionFile(relativePath) {
  return STATIC_CONTRACT_VAR_DEFINITION_PATH_PARTS.some(part => relativePath.includes(part));
}

function isRuntimeContractVarDefinitionFile(relativePath) {
  return RUNTIME_CONTRACT_VAR_DEFINITION_PATH_PARTS.some(part => relativePath.includes(part));
}

function isExceptionFile(relativePath) {
  return EXCEPTION_PATH_PARTS.some(part => relativePath.toLowerCase().includes(part.toLowerCase()));
}

function isGeneratedWidgetAppearancePayloadFile(relativePath) {
  return relativePath.endsWith(GENERATED_WIDGET_APPEARANCE_PAYLOAD_PATH);
}

function collectGeneratedWidgetPayloadVarNames(content) {
  const namesBlock = /export const WIDGET_APPEARANCE_VARIABLE_NAMES = \[([\s\S]*?)\] as const;/.exec(content)?.[1];
  if (namesBlock) {
    const names = collectMatches(namesBlock, CSS_VAR_LITERAL_PATTERN).map(match => match[1]);
    if (names.length === 0) {
      throw new Error('WIDGET_APPEARANCE_VARIABLE_NAMES must not be empty.');
    }
    return names;
  }

  if (/Object\.values\(themeCssVariables\)/.test(content)) {
    const themeContract = PACKAGE_CSS_VAR_DEFINITION_CONTRACTS.find(
      contract => contract.packageName === '@openbitfun/theme-openbitfun',
    );
    if (themeContract?.variables.length) return [...themeContract.variables];
  }

  throw new Error('Unable to parse WIDGET_APPEARANCE_VARIABLE_NAMES or resolve it from the canonical theme contract.');
}

function pathMatchesPart(relativePath, pathPart) {
  const normalizedPath = relativePath.toLowerCase();
  const normalizedPart = pathPart.toLowerCase();
  return (
    normalizedPath === normalizedPart
    || normalizedPath.endsWith(`/${normalizedPart}`)
    || normalizedPath.startsWith(`${normalizedPart}/`)
    || normalizedPath.startsWith(`${normalizedPart}.`)
    || normalizedPath.includes(`/${normalizedPart}/`)
    || normalizedPath.includes(`/${normalizedPart}.`)
  );
}

function getColorDomain(relativePath) {
  const rule = COLOR_DOMAIN_RULES.find(entry => (
    (!entry.extensions || entry.extensions.includes(path.extname(relativePath).toLowerCase()))
    && entry.pathParts.some(part => pathMatchesPart(relativePath, part))
  ));
  return rule?.key ?? 'appUi';
}

function incrementMap(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function addToSetMap(map, key, value) {
  const values = map.get(key) ?? new Set();
  values.add(value);
  map.set(key, values);
}

function collectMatches(content, pattern) {
  pattern.lastIndex = 0;
  return Array.from(content.matchAll(pattern));
}

function collectNamedColorValues(content, relativePath) {
  const colors = [];
  const extension = path.extname(relativePath).toLowerCase();

  if (STYLE_SOURCE_EXTENSIONS.has(extension)) {
    for (const declaration of collectMatches(content, CSS_DECLARATION_PATTERN)) {
      if (declaration[1].toLowerCase() === 'content') continue;
      const valueWithoutUrls = declaration[2].replace(/url\((?:"[^"]*"|'[^']*'|[^)]*)\)/gi, ' ');
      for (const match of collectMatches(valueWithoutUrls, CSS_NAMED_COLOR_PATTERN)) {
        colors.push(match[1].toLowerCase());
      }
    }
  }

  if (STYLE_SOURCE_EXTENSIONS.has(extension) || MARKUP_SOURCE_EXTENSIONS.has(extension)) {
    for (const match of collectMatches(content, CSS_COLOR_ATTRIBUTE_PATTERN)) {
      colors.push(match[1].toLowerCase());
    }
  }

  if (!STYLE_SOURCE_EXTENSIONS.has(extension) && !MARKUP_SOURCE_EXTENSIONS.has(extension)) {
    for (const match of collectMatches(content, SCRIPT_COLOR_VALUE_PATTERN)) {
      colors.push(match[1].toLowerCase());
    }
  }

  return colors;
}

function collectRawRgbChannelValues(content) {
  return collectMatches(content, RAW_RGB_CHANNEL_DEFINITION_PATTERN).map((match) => {
    const channels = match[1].split(',').map(channel => Number(channel.trim()));
    return `rgb(${channels.join(', ')})`;
  });
}

function collectColorValues(content, relativePath) {
  return [
    ...collectMatches(content, COLOR_PATTERN).map(match => match[0]),
    ...collectNamedColorValues(content, relativePath),
    ...collectRawRgbChannelValues(content),
  ];
}

function collectImportedPackageNames(files, cwd) {
  const packageNames = new Set();
  for (const file of files) {
    const relativePath = normalizePath(path.relative(cwd, file));
    const content = createAuditContent(fs.readFileSync(file, 'utf8'), relativePath);
    for (const contract of PACKAGE_CSS_VAR_IMPORT_CONTRACTS) {
      if (!content.includes(contract.specifier)) continue;
      for (const packageName of contract.packageNames) {
        packageNames.add(packageName);
      }
    }
  }
  return packageNames;
}

function contractOwnerMatchesRoot(contract, rootRelativePath) {
  return String(contract.owner ?? '')
    .split(';')
    .map(owner => owner.trim())
    .filter(Boolean)
    .some(owner => (
      owner === rootRelativePath
      || owner.startsWith(`${rootRelativePath}/`)
      || rootRelativePath.startsWith(`${owner}/`)
    ));
}

function colorRampPrefix(name) {
  return name.endsWith('-') ? name : `${name}-`;
}

function previousNonWhitespace(chars) {
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index];
    if (!/\s/.test(char)) {
      return char;
    }
  }
  return null;
}

function isRegexLiteralStart(chars) {
  const previous = previousNonWhitespace(chars);
  return previous == null || '([{=,:;!?&|+-*~^<>'.includes(previous);
}

function stripCommentsForAudit(content, { stripLineComments = true } = {}) {
  const result = [];
  let state = 'code';
  let regexCharClass = false;
  let returnState = 'code';
  let commentReturnState = 'code';
  let templateExpressionDepth = 0;
  const templateReturnStates = [];

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (state === 'line-comment') {
      if (char === '\n' || char === '\r') {
        state = commentReturnState;
        result.push(char);
      } else {
        result.push(' ');
      }
      continue;
    }

    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        result.push(' ', ' ');
        index += 1;
        state = commentReturnState;
      } else {
        result.push(char === '\n' || char === '\r' ? char : ' ');
      }
      continue;
    }

    if (state === 'regex') {
      result.push(char);
      if (char === '\\') {
        index += 1;
        if (index < content.length) {
          result.push(content[index]);
        }
        continue;
      }
      if (char === '[') {
        regexCharClass = true;
      } else if (char === ']') {
        regexCharClass = false;
      } else if (char === '/' && !regexCharClass) {
        state = returnState;
      }
      continue;
    }

    if (state === 'single-quote' || state === 'double-quote') {
      result.push(char);
      if (char === '\\') {
        index += 1;
        if (index < content.length) {
          result.push(content[index]);
        }
        continue;
      }
      if (
        (state === 'single-quote' && char === "'")
        || (state === 'double-quote' && char === '"')
      ) {
        state = returnState;
      }
      continue;
    }

    if (state === 'template') {
      result.push(char);
      if (char === '\\') {
        index += 1;
        if (index < content.length) {
          result.push(content[index]);
        }
        continue;
      }
      if (char === '$' && next === '{') {
        result.push(next);
        index += 1;
        templateExpressionDepth = 1;
        state = 'template-expression';
        continue;
      }
      if (char === '`') {
        state = templateReturnStates.pop() ?? 'code';
      }
      continue;
    }

    if (state === 'template-expression') {
      if (char === '{') {
        templateExpressionDepth += 1;
        result.push(char);
        continue;
      }
      if (char === '}') {
        templateExpressionDepth -= 1;
        result.push(char);
        if (templateExpressionDepth <= 0) {
          templateExpressionDepth = 0;
          state = 'template';
        }
        continue;
      }
    }

    if (char === '/' && next === '*') {
      result.push(' ', ' ');
      index += 1;
      commentReturnState = state;
      state = 'block-comment';
      continue;
    }

    if (stripLineComments && char === '/' && next === '/') {
      result.push(' ', ' ');
      index += 1;
      commentReturnState = state;
      state = 'line-comment';
      continue;
    }

    if (char === '/' && isRegexLiteralStart(result)) {
      regexCharClass = false;
      returnState = state;
      state = 'regex';
      result.push(char);
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      if (char === '`') {
        templateReturnStates.push(state);
        state = 'template';
      } else {
        returnState = state;
        state = char === "'" ? 'single-quote' : 'double-quote';
      }
      result.push(char);
      continue;
    }

    result.push(char);
  }

  return result.join('');
}

function createAuditContent(content, relativePath) {
  const withoutComments = stripCommentsForAudit(content, {
    stripLineComments: !relativePath.endsWith('.css'),
  });
  return withoutComments.replace(/&#(?:x[0-9a-f]+|\d+);/gi, match => ' '.repeat(match.length));
}

function parseColor(color) {
  const trimmed = color.trim().toLowerCase();
  const named = COMMON_NAMED_COLOR_RGB.get(trimmed);
  if (named) {
    return { r: named[0], g: named[1], b: named[2], a: 1 };
  }

  const hex = /^#([0-9a-f]{3,8})$/.exec(trimmed);
  if (hex) {
    const raw = hex[1];
    const expanded = raw.length === 3 || raw.length === 4
      ? raw.split('').map(char => char + char).join('')
      : raw;
    const rgbHex = expanded.slice(0, 6);
    const alphaHex = expanded.length === 8 ? expanded.slice(6, 8) : null;
    return {
      r: parseInt(rgbHex.slice(0, 2), 16),
      g: parseInt(rgbHex.slice(2, 4), 16),
      b: parseInt(rgbHex.slice(4, 6), 16),
      a: alphaHex ? Math.round((parseInt(alphaHex, 16) / 255) * 1000) / 1000 : 1,
    };
  }

  const rgb = /^rgba?\(\s*([-+]?\d*\.?\d+)\s*,\s*([-+]?\d*\.?\d+)\s*,\s*([-+]?\d*\.?\d+)(?:\s*,\s*([-+]?\d*\.?\d+))?\s*\)$/.exec(trimmed);
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
  }

  return null;
}

function canonicalColorKey(color) {
  const parsed = parseColor(color);
  if (!parsed) {
    return null;
  }
  return `${parsed.r},${parsed.g},${parsed.b},${parsed.a}`;
}

function colorDistance(a, b) {
  return Math.sqrt(
    (a.r - b.r) ** 2 +
    (a.g - b.g) ** 2 +
    (a.b - b.b) ** 2
  );
}

function colorPairKey(left, right) {
  return [left, right].sort((a, b) => a.localeCompare(b)).join(' <-> ');
}

function buildNearColorPairRow({ a, b, distance, alphaDiff, colorFiles }) {
  const aFiles = Array.from(colorFiles.get(a.color) ?? []).sort();
  const bFiles = Array.from(colorFiles.get(b.color) ?? []).sort();
  return {
    key: colorPairKey(a.color, b.color),
    a: a.color,
    b: b.color,
    distance,
    alphaDiff,
    count: a.count + b.count,
    files: Array.from(new Set([...aFiles, ...bFiles])).sort().slice(0, 8),
    filesByColor: {
      [a.color]: aFiles.slice(0, 5),
      [b.color]: bFiles.slice(0, 5),
    },
  };
}

function buildNearColorPairs(colorCounts, colorFiles) {
  const parsed = Array.from(colorCounts.entries())
    .map(([color, count]) => ({ color, count, parsed: parseColor(color) }))
    .filter(entry => entry.parsed);

  const indistinguishable = [];
  const near = [];

  for (let left = 0; left < parsed.length; left += 1) {
    for (let right = left + 1; right < parsed.length; right += 1) {
      const a = parsed[left];
      const b = parsed[right];
      const alphaDiff = Math.abs(a.parsed.a - b.parsed.a);
      const distance = colorDistance(a.parsed, b.parsed);
      if (distance <= 2 && alphaDiff <= 0.003) {
        indistinguishable.push(buildNearColorPairRow({ a, b, distance, alphaDiff, colorFiles }));
      } else if (distance <= 10 && alphaDiff <= 0.03) {
        near.push(buildNearColorPairRow({ a, b, distance, alphaDiff, colorFiles }));
      }
    }
  }

  const byImpact = (a, b) => b.count - a.count || a.distance - b.distance;
  indistinguishable.sort(byImpact);
  near.sort(byImpact);
  return {
    indistinguishableTotal: indistinguishable.length,
    nearTotal: near.length,
    indistinguishable: indistinguishable.slice(0, 50),
    near: near.slice(0, 50),
  };
}

function topEntries(map, limit) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function collectTokenAliasDefinitions(files, cwd) {
  const definitionsByColorKey = new Map();

  for (const token of CANONICAL_THEME_COLOR_TOKENS) {
    const colorKey = canonicalColorKey(token.value);
    if (colorKey) {
      addToSetMap(definitionsByColorKey, colorKey, token.cssVariable);
    }
  }

  for (const file of files) {
    const relativePath = normalizePath(path.relative(cwd, file));
    if (!isTokenAliasSourceFile(relativePath)) {
      continue;
    }
    const content = createAuditContent(fs.readFileSync(file, 'utf8'), relativePath);
    for (const match of collectMatches(content, TOKEN_ALIAS_DEFINITION_PATTERN)) {
      const colorKey = canonicalColorKey(match[2]);
      if (!colorKey) {
        continue;
      }
      addToSetMap(definitionsByColorKey, colorKey, match[1]);
    }
  }

  return definitionsByColorKey;
}

function buildTokenAliasLiteralRows({
  tokenAliasLiteralCounts,
  tokenAliasLiteralFiles,
  tokenAliasLiteralExamples,
  tokenAliasDefinitionsByColorKey,
  limit,
}) {
  return Array.from(tokenAliasLiteralCounts.entries())
    .map(([colorKey, count]) => ({
      key: Array.from(tokenAliasLiteralExamples.get(colorKey) ?? []).sort().join(' | '),
      count,
      aliases: Array.from(tokenAliasDefinitionsByColorKey.get(colorKey) ?? []).sort(),
      files: Array.from(tokenAliasLiteralFiles.get(colorKey) ?? []).sort().slice(0, 5),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function sumMapValues(map) {
  return Array.from(map.values()).reduce((sum, count) => sum + count, 0);
}

function getValueByPath(value, dottedPath) {
  return dottedPath.split('.').reduce((current, segment) => {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    return current[segment];
  }, value);
}

function resolveBaselinePath(options) {
  if (options.noBaseline) {
    return null;
  }
  if (options.baselinePath !== undefined) {
    return path.resolve(options.baselinePath);
  }

  const root = path.resolve(options.root);
  const defaultRoot = path.resolve(DEFAULT_ROOT);
  const defaultBaselinePath = path.resolve(DEFAULT_BASELINE_PATH);
  if (root === defaultRoot && fs.existsSync(defaultBaselinePath)) {
    return defaultBaselinePath;
  }

  return null;
}

function readBaseline(baselinePath) {
  try {
    return JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse ${normalizePath(path.relative(process.cwd(), baselinePath))}: ${error.message}`);
  }
}

function validateAllowlistEntry(category, entry, index, baselineLabel) {
  const prefix = `${baselineLabel} allowlists.${category}[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return [`${prefix} must be an object`];
  }
  const failures = [];
  for (const field of ['key', 'owner', 'reason']) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
      failures.push(`${prefix}.${field} must be a non-empty string`);
    }
  }
  return failures;
}

function evaluateAllowlistCategory({ report, baseline, baselineLabel, category, reportField }) {
  const findings = report[reportField] ?? [];
  if (!Array.isArray(findings)) {
    return [];
  }

  const failures = [];
  const allowlists = baseline.allowlists ?? {};
  const entries = allowlists[category];
  if (!Array.isArray(entries)) {
    if (findings.length === 0) {
      return [];
    }
    return [`${baselineLabel} allowlists.${category} must be an array because ${reportField} has findings`];
  }

  const findingKeys = new Set(findings.map(entry => entry.key));
  const allowlistKeys = new Set();
  entries.forEach((entry, index) => {
    failures.push(...validateAllowlistEntry(category, entry, index, baselineLabel));
    if (typeof entry?.key === 'string') {
      allowlistKeys.add(entry.key);
    }
  });

  for (const key of findingKeys) {
    if (!allowlistKeys.has(key)) {
      failures.push(`${category} is missing allowlist entry for ${key}`);
    }
  }
  for (const key of allowlistKeys) {
    if (!findingKeys.has(key)) {
      failures.push(`${category} allowlist entry ${key} is stale; remove it from ${baselineLabel}.`);
    }
  }

  return failures;
}

function applyBaseline(report, options) {
  const baselinePath = resolveBaselinePath(options);
  const baselineSummary = {
    path: baselinePath ? normalizePath(path.relative(process.cwd(), baselinePath)) : null,
    enforced: false,
    failures: [],
  };
  report.summary.baseline = baselineSummary;

  if (!baselinePath) {
    return baselineSummary;
  }

  if (!fs.existsSync(baselinePath)) {
    baselineSummary.failures.push(`Missing ${baselineSummary.path}`);
    baselineSummary.enforced = true;
    return baselineSummary;
  }

  const baseline = readBaseline(baselinePath);
  baselineSummary.enforced = true;
  const baselineLabel = baselineSummary.path;

  if (baseline.version !== 1) {
    baselineSummary.failures.push(`${baselineLabel} must use version 1`);
  }
  if (!baseline.budgets || typeof baseline.budgets !== 'object' || Array.isArray(baseline.budgets)) {
    baselineSummary.failures.push(`${baselineLabel} must define a budgets object`);
    return baselineSummary;
  }

  for (const [metricPath, budget] of Object.entries(baseline.budgets)) {
    if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
      baselineSummary.failures.push(`${baselineLabel} ${metricPath} budget must be an object`);
      continue;
    }
    if (typeof budget.max !== 'number') {
      baselineSummary.failures.push(`${baselineLabel} ${metricPath}.max must be a number`);
      continue;
    }
    const actual = getValueByPath(report, metricPath);
    if (typeof actual !== 'number') {
      baselineSummary.failures.push(`${baselineLabel} references unknown numeric metric ${metricPath}`);
      continue;
    }
    if (actual > budget.max) {
      baselineSummary.failures.push(`${metricPath} has ${actual} candidate(s), baseline is ${budget.max}`);
    } else if (actual < budget.max) {
      baselineSummary.failures.push(`${metricPath} has ${actual} candidate(s), below baseline ${budget.max}; lower ${baselineLabel}.`);
    }
  }

  baselineSummary.failures.push(...evaluateAllowlistCategory({
    report,
    baseline,
    baselineLabel,
    category: 'nonContractDynamicInputs',
    reportField: 'nonContractDynamicInputVars',
  }));
  baselineSummary.failures.push(...evaluateAllowlistCategory({
    report,
    baseline,
    baselineLabel,
    category: 'nonContractCssPrivate',
    reportField: 'nonContractCssPrivateVars',
  }));
  baselineSummary.failures.push(...evaluateAllowlistCategory({
    report,
    baseline,
    baselineLabel,
    category: 'runtimeOnlyRequiredContract',
    reportField: 'runtimeOnlyRequiredContractVars',
  }));
  return baselineSummary;
}

function audit(options) {
  const root = path.resolve(options.root);
  const checksFullThemeSourceRoot = root === path.resolve(DEFAULT_ROOT);
  const rootRelativePath = normalizePath(path.relative(process.cwd(), root));
  const files = walkFiles(root);
  const cwd = process.cwd();
  const fileEntries = files.map(file => ({
    file,
    relativePath: normalizePath(path.relative(cwd, file)),
    rootRelativePath: normalizePath(path.relative(root, file)),
  }));
  const rootRelativePathByRelativePath = new Map(
    fileEntries.map(entry => [entry.relativePath, entry.rootRelativePath]),
  );
  const ignoredTestFiles = fileEntries.filter(entry => isAuditTestFile(entry.relativePath));
  const ignoredGeneratedFiles = fileEntries.filter(entry => (
    !isAuditTestFile(entry.relativePath)
    && isGeneratedBuildArtifact(entry.rootRelativePath)
  ));
  const ignoredExplicitFiles = fileEntries.filter(entry => (
    !isAuditTestFile(entry.relativePath)
    && !isGeneratedBuildArtifact(entry.rootRelativePath)
    && isExplicitlyExcluded(entry.rootRelativePath, options.excludePaths)
  ));
  const auditedFiles = fileEntries
    .filter(entry => (
      !isAuditTestFile(entry.relativePath)
      && !isGeneratedBuildArtifact(entry.rootRelativePath)
      && !isExplicitlyExcluded(entry.rootRelativePath, options.excludePaths)
    ))
    .map(entry => entry.file);
  const importedPackageNames = collectImportedPackageNames(auditedFiles, cwd);
  for (const packageName of options.packageContracts) {
    if (!PACKAGE_CSS_VAR_DEFINITION_CONTRACTS.some(contract => contract.packageName === packageName)) {
      throw new Error(`Unknown package CSS variable contract: ${packageName}`);
    }
    importedPackageNames.add(packageName);
  }
  const tokenAliasDefinitionsByColorKey = collectTokenAliasDefinitions(auditedFiles, cwd);

  const colorCounts = new Map();
  const componentColorCounts = new Map();
  const componentColorFiles = new Map();
  const fallbackTokenCounts = new Map();
  const fallbackTokenFiles = new Map();
  const varUsageCounts = new Map();
  const varDefinitionCounts = new Map();
  const varDefinitionKinds = new Map();
  const varDefinitionFiles = new Map();
  const varUsageFileCounts = new Map();
  const contractVarDefinitions = new Set();
  const staticContractVarDefinitions = new Set();
  const runtimeContractVarDefinitions = new Set();
  const varUsageFiles = new Map();
  const dynamicDefinitionPrefixes = new Set();
  const dynamicDefinitionFiles = new Map();
  const fileColorCounts = new Map();
  const componentFileColorCounts = new Map();
  const exceptionColorCounts = new Map();
  const tokenColorCounts = new Map();
  const colorDomainCounts = new Map();
  const colorDomainFiles = new Map();
  const colorDomainColorFiles = new Map();
  const tokenAliasLiteralCounts = new Map();
  const tokenAliasLiteralFiles = new Map();
  const tokenAliasLiteralExamples = new Map();
  const generatedWidgetPayloadVarCounts = new Map();
  const generatedWidgetPayloadVarFiles = new Map();

  let colorOccurrences = 0;
  let componentColorOccurrences = 0;
  let fallbackOccurrences = 0;

  for (const file of auditedFiles) {
    const relativePath = normalizePath(path.relative(cwd, file));
    const content = createAuditContent(fs.readFileSync(file, 'utf8'), relativePath);
    const tokenFile = isTokenFile(relativePath);
    const exceptionFile = isExceptionFile(relativePath);
    const colorDomain = getColorDomain(relativePath);
    const colors = collectColorValues(content, relativePath);

    if (colors.length > 0) {
      fileColorCounts.set(relativePath, colors.length);
      addToSetMap(colorDomainFiles, colorDomain, relativePath);
    }

    for (const color of colors) {
      colorOccurrences += 1;
      incrementMap(colorCounts, color);
      const domainCounts = colorDomainCounts.get(colorDomain) ?? new Map();
      incrementMap(domainCounts, color);
      colorDomainCounts.set(colorDomain, domainCounts);
      const domainColorFiles = colorDomainColorFiles.get(colorDomain) ?? new Map();
      addToSetMap(domainColorFiles, color, relativePath);
      colorDomainColorFiles.set(colorDomain, domainColorFiles);
      if (tokenFile) {
        incrementMap(tokenColorCounts, color);
      } else if (exceptionFile) {
        incrementMap(exceptionColorCounts, color);
      } else if (colorDomain === 'appUi') {
        componentColorOccurrences += 1;
        incrementMap(componentColorCounts, color);
        addToSetMap(componentColorFiles, color, relativePath);
        incrementMap(componentFileColorCounts, relativePath);

        const colorKey = canonicalColorKey(color);
        if (colorKey && tokenAliasDefinitionsByColorKey.has(colorKey)) {
          incrementMap(tokenAliasLiteralCounts, colorKey);
          addToSetMap(tokenAliasLiteralFiles, colorKey, relativePath);
          addToSetMap(tokenAliasLiteralExamples, colorKey, color.trim().toLowerCase());
        }
      }
    }

    for (const match of collectMatches(content, CSS_VAR_USAGE_PATTERN)) {
      incrementMap(varUsageCounts, match[1]);
      addToSetMap(varUsageFiles, match[1], relativePath);
      const fileCounts = varUsageFileCounts.get(match[1]) ?? new Map();
      incrementMap(fileCounts, relativePath);
      varUsageFileCounts.set(match[1], fileCounts);
    }

    for (const match of collectMatches(content, CSS_VAR_DEFINITION_PATTERN)) {
      incrementMap(varDefinitionCounts, match[2]);
      addToSetMap(varDefinitionKinds, match[2], 'css');
      addToSetMap(varDefinitionFiles, match[2], relativePath);
      if (isContractVarDefinitionFile(relativePath)) {
        contractVarDefinitions.add(match[2]);
      }
      if (isStaticContractVarDefinitionFile(relativePath)) {
        staticContractVarDefinitions.add(match[2]);
      }
    }

    for (const match of collectMatches(content, CSS_VAR_SET_PROPERTY_PATTERN)) {
      incrementMap(varDefinitionCounts, match[1]);
      addToSetMap(varDefinitionKinds, match[1], 'runtime');
      addToSetMap(varDefinitionFiles, match[1], relativePath);
      if (isContractVarDefinitionFile(relativePath)) {
        contractVarDefinitions.add(match[1]);
      }
      if (isRuntimeContractVarDefinitionFile(relativePath)) {
        runtimeContractVarDefinitions.add(match[1]);
      }
    }

    for (const match of collectMatches(content, CSS_VAR_INLINE_STYLE_PATTERN)) {
      incrementMap(varDefinitionCounts, match[1]);
      addToSetMap(varDefinitionKinds, match[1], 'inline-style');
      addToSetMap(varDefinitionFiles, match[1], relativePath);
      if (isContractVarDefinitionFile(relativePath)) {
        contractVarDefinitions.add(match[1]);
      }
    }

    for (const match of collectMatches(content, CSS_VAR_DYNAMIC_SET_PATTERN)) {
      dynamicDefinitionPrefixes.add(match[1]);
      addToSetMap(dynamicDefinitionFiles, match[1], relativePath);
    }

    for (const match of collectMatches(content, CSS_VAR_COLOR_RAMP_PATTERN)) {
      const prefix = colorRampPrefix(match[1]);
      dynamicDefinitionPrefixes.add(prefix);
      addToSetMap(dynamicDefinitionFiles, prefix, relativePath);
    }

    if (isGeneratedWidgetAppearancePayloadFile(relativePath)) {
      for (const name of collectGeneratedWidgetPayloadVarNames(content)) {
        incrementMap(generatedWidgetPayloadVarCounts, name);
        addToSetMap(generatedWidgetPayloadVarFiles, name, relativePath);
        incrementMap(varDefinitionCounts, name);
        addToSetMap(varDefinitionKinds, name, 'widget-host-contract');
        addToSetMap(varDefinitionFiles, name, relativePath);
        contractVarDefinitions.add(name);
      }
    }

    for (const match of collectMatches(content, VAR_FALLBACK_PATTERN)) {
      fallbackOccurrences += 1;
      incrementMap(fallbackTokenCounts, match[1]);
      addToSetMap(fallbackTokenFiles, match[1], relativePath);
    }
  }

  for (const contract of PACKAGE_CSS_VAR_DEFINITION_CONTRACTS) {
    if (!importedPackageNames.has(contract.packageName)) continue;
    for (const name of contract.variables) {
      incrementMap(varDefinitionCounts, name);
      addToSetMap(varDefinitionKinds, name, 'package-contract');
      addToSetMap(varDefinitionFiles, name, contract.owner);
      contractVarDefinitions.add(name);
    }
  }

  const definedVars = new Set(varDefinitionCounts.keys());
  const getDefinitionKinds = name => Array.from(varDefinitionKinds.get(name) ?? ['unknown']).sort();
  const getExplicitDefinitionKind = name => (
    definedVars.has(name) ? getDefinitionKinds(name).join('+') : null
  );
  const getDynamicDefinitionPrefix = name => (
    Array.from(dynamicDefinitionPrefixes).find(prefix => name.startsWith(prefix)) ?? null
  );
  const getDefinitionKind = name => {
    if (definedVars.has(name)) {
      return getDefinitionKinds(name).join('+');
    }
    const dynamicPrefix = getDynamicDefinitionPrefix(name);
    return dynamicPrefix ? `dynamic-family:${dynamicPrefix}*` : null;
  };
  const unresolvedVarEntries = Array.from(varUsageCounts.entries())
    .filter(([name]) => !getDefinitionKind(name))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const undefinedVars = unresolvedVarEntries
    .slice(0, REPORT_ROW_LIMIT)
    .map(([key, count]) => ({ key, count }));
  const fallbackOnlyEntries = unresolvedVarEntries
    .filter(([name]) => fallbackTokenCounts.has(name));
  const fallbackOnlyVars = fallbackOnlyEntries
    .slice(0, REPORT_ROW_LIMIT)
    .map(([key, count]) => ({ key, count }));
  const unresolvedRequiredEntries = unresolvedVarEntries
    .filter(([name]) => !fallbackTokenCounts.has(name));
  const unresolvedRequiredVars = unresolvedRequiredEntries
    .slice(0, REPORT_ROW_LIMIT)
    .map(([key, count]) => ({
      key,
      count,
      files: Array.from(varUsageFiles.get(key) ?? []).slice(0, 5),
    }));
  const dynamicDefinedVars = Array.from(varUsageCounts.entries())
    .map(([key, count]) => ({ key, count, kind: getDefinitionKind(key) }))
    .filter(entry => entry.kind && entry.kind !== 'css')
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, REPORT_ROW_LIMIT);
  const requiresExactDynamicFamilyDefinitions = staticContractVarDefinitions.size > 0;
  const dynamicFamilyUnexportedEntries = requiresExactDynamicFamilyDefinitions
    ? Array.from(varUsageCounts.entries())
      .map(([key, count]) => {
        const prefix = getDynamicDefinitionPrefix(key);
        return {
          key,
          count,
          prefix,
          files: Array.from(varUsageFiles.get(key) ?? []).sort().slice(0, 5),
        };
      })
      .filter(entry => entry.prefix && !definedVars.has(entry.key))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    : [];
  const dynamicFamilyUnexportedVars = dynamicFamilyUnexportedEntries
    .slice(0, REPORT_ROW_LIMIT);
  const unregisteredDynamicFamilyEntries = Array.from(dynamicDefinitionPrefixes)
    .filter(prefix => !REGISTERED_DYNAMIC_VAR_PREFIXES.has(prefix))
    .sort((a, b) => a.localeCompare(b))
    .map(prefix => ({
      key: prefix,
      files: Array.from(dynamicDefinitionFiles.get(prefix) ?? []).sort().slice(0, 5),
    }));
  const staleRegisteredDynamicFamilyEntries = checksFullThemeSourceRoot
    ? DYNAMIC_VAR_FAMILY_CONTRACTS
      .filter(contract => contractOwnerMatchesRoot(contract, rootRelativePath))
      .map(contract => contract.prefix)
      .filter(prefix => !dynamicDefinitionPrefixes.has(prefix))
      .sort((a, b) => a.localeCompare(b))
      .map(prefix => ({ key: prefix }))
    : [];
  const nonContractDefinedEntries = Array.from(varUsageCounts.entries())
    .filter(([name]) => definedVars.has(name) && !contractVarDefinitions.has(name))
    .map(([key, count]) => ({
      key,
      count,
      definitionKinds: getDefinitionKinds(key),
      definitionFiles: Array.from(varDefinitionFiles.get(key) ?? []).slice(0, 5),
      usageFiles: Array.from(varUsageFiles.get(key) ?? []).slice(0, 5),
      usageFileCount: (varUsageFiles.get(key) ?? new Set()).size,
    }))
    .filter(entry => entry.usageFileCount > 1)
    .sort((a, b) => b.usageFileCount - a.usageFileCount || b.count - a.count || a.key.localeCompare(b.key));
  const nonContractDefinedVars = nonContractDefinedEntries;
  const nonContractDynamicInputEntries = nonContractDefinedEntries
    .filter(entry => entry.definitionKinds.some(kind => kind === 'inline-style' || kind === 'runtime'));
  const nonContractDynamicInputVars = nonContractDynamicInputEntries;
  const nonContractCssPrivateEntries = nonContractDefinedEntries
    .filter(entry => (
      entry.definitionKinds.includes('css')
      && !entry.definitionKinds.some(kind => kind === 'inline-style' || kind === 'runtime')
    ));
  const nonContractCssPrivateVars = nonContractCssPrivateEntries;
  const runtimeOnlyRequiredContractEntries = Array.from(varUsageCounts.entries())
    .filter(([name]) => (
      runtimeContractVarDefinitions.has(name)
      && !staticContractVarDefinitions.has(name)
      && !getDefinitionKinds(name).includes('package-contract')
      && !fallbackTokenCounts.has(name)
    ))
    .map(([key, count]) => ({
      key,
      count,
      definitionFiles: Array.from(varDefinitionFiles.get(key) ?? []).slice(0, 5),
      usageFiles: Array.from(varUsageFiles.get(key) ?? []).slice(0, 5),
      usageFileCount: (varUsageFiles.get(key) ?? new Set()).size,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const runtimeOnlyRequiredContractVars = runtimeOnlyRequiredContractEntries
    .slice(0, REPORT_ROW_LIMIT);
  const getRootRelativeFiles = files => Array.from(files)
    .map(file => rootRelativePathByRelativePath.get(file) ?? file)
    .sort()
    .slice(0, 5);
  const getUsageCountByPredicate = (name, predicate) => {
    const fileCounts = varUsageFileCounts.get(name) ?? new Map();
    return Array.from(fileCounts.entries())
      .filter(([file]) => predicate(file))
      .reduce((total, [, count]) => total + count, 0);
  };
  const staticContractUsageEntries = Array.from(staticContractVarDefinitions)
    .map(key => {
      const usageFiles = varUsageFiles.get(key) ?? new Set();
      const payloadFiles = generatedWidgetPayloadVarFiles.get(key) ?? new Set();
      const externalUsageFiles = new Set(
        Array.from(usageFiles).filter(file => !isStaticContractVarDefinitionFile(file)),
      );
      for (const file of payloadFiles) {
        externalUsageFiles.add(file);
      }
      return {
        key,
        count: (
          getUsageCountByPredicate(key, file => !isStaticContractVarDefinitionFile(file))
          + (generatedWidgetPayloadVarCounts.get(key) ?? 0)
        ),
        internalUsageCount: getUsageCountByPredicate(key, file => isStaticContractVarDefinitionFile(file)),
        definitionFiles: getRootRelativeFiles(varDefinitionFiles.get(key) ?? new Set()),
        usageFiles: getRootRelativeFiles(externalUsageFiles),
        externalUsageFileCount: externalUsageFiles.size,
      };
    })
    .sort((a, b) => (
      b.externalUsageFileCount - a.externalUsageFileCount
      || b.count - a.count
      || a.key.localeCompare(b.key)
    ));
  const staticContractExternalUsageVars = staticContractUsageEntries
    .filter(entry => entry.externalUsageFileCount > 0);
  const staticContractInternalOnlyVars = staticContractUsageEntries
    .filter(entry => entry.externalUsageFileCount === 0)
    .sort((a, b) => b.internalUsageCount - a.internalUsageCount || a.key.localeCompare(b.key));
  const staticContractLowExternalUsageVars = staticContractExternalUsageVars
    .filter(entry => entry.externalUsageFileCount <= 2)
    .sort((a, b) => (
      a.externalUsageFileCount - b.externalUsageFileCount
      || b.count - a.count
      || a.key.localeCompare(b.key)
    ));

  const nearPairs = buildNearColorPairs(componentColorCounts, componentColorFiles);
  const uniqueComponentColors = componentColorCounts.size;
  const tokenAliasLiteralRows = buildTokenAliasLiteralRows({
    tokenAliasLiteralCounts,
    tokenAliasLiteralFiles,
    tokenAliasLiteralExamples,
    tokenAliasDefinitionsByColorKey,
    limit: options.top,
  });
  const colorDomainScopes = Object.fromEntries(COLOR_DOMAIN_KEYS.map(key => {
    const counts = colorDomainCounts.get(key) ?? new Map();
    const filesWithColors = colorDomainFiles.get(key) ?? new Set();
    return [key, {
      occurrences: sumMapValues(counts),
      filesWithColors: filesWithColors.size,
      uniqueColors: counts.size,
      topColors: topEntries(counts, options.top),
    }];
  }));
  const colorDomainNearPairEntries = Object.fromEntries(COLOR_DOMAIN_KEYS.map(key => {
    const counts = colorDomainCounts.get(key) ?? new Map();
    const filesByColor = colorDomainColorFiles.get(key) ?? new Map();
    return [key, buildNearColorPairs(counts, filesByColor)];
  }));
  const specializedColorDomainKeys = COLOR_DOMAIN_KEYS.filter(key => key !== 'appUi');
  const colorDomainNearPairs = {
    indistinguishableTotal: specializedColorDomainKeys.reduce(
      (total, key) => total + colorDomainNearPairEntries[key].indistinguishableTotal,
      0,
    ),
    nearTotal: specializedColorDomainKeys.reduce(
      (total, key) => total + colorDomainNearPairEntries[key].nearTotal,
      0,
    ),
    ...colorDomainNearPairEntries,
  };
  const fallbackVars = Array.from(fallbackTokenCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({
      key,
      count,
      files: Array.from(fallbackTokenFiles.get(key) ?? []).sort().slice(0, 5),
    }));
  const compatibilityAliasEntries = Array.from(varUsageCounts.entries())
    .map(([key, count]) => {
      const contract = resolveCompatibilityAliasContract(key);
      if (!contract) {
        return null;
      }
      return {
        key,
        count,
        canonical: contract.canonical,
        familyPrefix: contract.familyPrefix ?? null,
        files: Array.from(varUsageFiles.get(key) ?? []).sort().slice(0, 5),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const compatibilityAliasFamilyEntries = TOKEN_COMPATIBILITY_ALIAS_FAMILY_CONTRACTS
    .map(contract => {
      const usedEntries = Array.from(varUsageCounts.entries())
        .filter(([key]) => key.startsWith(contract.prefix) && key.length > contract.prefix.length);
      const usageCount = usedEntries.reduce((total, [, count]) => total + count, 0);
      const usedUnique = usedEntries.length;
      const isDefined = (
        dynamicDefinitionPrefixes.has(contract.prefix)
        || Array.from(definedVars).some(key => key.startsWith(contract.prefix))
      );
      const canonicalIsDefined = (
        dynamicDefinitionPrefixes.has(contract.canonicalPrefix)
        || Array.from(definedVars).some(key => key.startsWith(contract.canonicalPrefix))
      );
      return {
        key: contract.prefix,
        canonical: contract.canonicalPrefix,
        count: usageCount,
        usedUnique,
        defined: isDefined,
        canonicalDefined: canonicalIsDefined,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  const missingCompatibilityAliasCanonicalEntries = compatibilityAliasEntries
    .filter(entry => entry.familyPrefix && !getDefinitionKind(entry.canonical))
    .map(entry => ({
      key: entry.key,
      canonical: entry.canonical,
      count: entry.count,
      files: entry.files,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const generatedWidgetPayloadVars = Array.from(generatedWidgetPayloadVarCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({
      key,
      count,
      definitionKind: getExplicitDefinitionKind(key),
      files: Array.from(generatedWidgetPayloadVarFiles.get(key) ?? []).sort().slice(0, 5),
    }));
  const hasGeneratedWidgetPayloadContract = generatedWidgetPayloadVars.length > 0;
  const generatedWidgetPayloadCompatibilityAliases = generatedWidgetPayloadVars
    .map(entry => {
      const contract = resolveCompatibilityAliasContract(entry.key);
      if (!contract || contract.familyPrefix) {
        return null;
      }
      return {
        ...entry,
        canonical: contract.canonical,
        canonicalDefinitionKind: getExplicitDefinitionKind(contract.canonical),
        familyPrefix: null,
        canonicalPrefix: null,
        owner: contract.owner,
        reason: contract.reason,
        removal: contract.removal,
        internalUsageCount: varUsageCounts.get(entry.key) ?? 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const generatedWidgetPayloadCompatibilityFamilies = generatedWidgetPayloadVars
    .map(entry => {
      const contract = resolveCompatibilityAliasContract(entry.key);
      if (!contract?.familyPrefix) {
        return null;
      }
      return {
        ...entry,
        canonical: contract.canonical,
        familyPrefix: contract.familyPrefix,
        canonicalPrefix: contract.canonicalPrefix,
        canonicalDefinitionKind: getExplicitDefinitionKind(contract.canonical),
        owner: contract.owner,
        reason: contract.reason,
        removal: contract.removal,
        internalUsageCount: varUsageCounts.get(entry.key) ?? 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const generatedWidgetPayloadExternalOnlyCompatibility = [
    ...generatedWidgetPayloadCompatibilityAliases,
    ...generatedWidgetPayloadCompatibilityFamilies,
  ]
    .filter(entry => entry.internalUsageCount === 0)
    .map(entry => ({
      key: entry.key,
      canonical: entry.canonical,
      familyPrefix: entry.familyPrefix,
      canonicalPrefix: entry.canonicalPrefix,
      count: entry.count,
      owner: entry.owner,
      reason: entry.reason,
      removal: entry.removal,
      canonicalDefinitionKind: entry.canonicalDefinitionKind,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const generatedWidgetPayloadUndefinedVars = generatedWidgetPayloadVars
    .filter(entry => !entry.definitionKind)
    .sort((a, b) => a.key.localeCompare(b.key));
  const generatedWidgetPayloadVarNames = new Set(generatedWidgetPayloadVars.map(entry => entry.key));
  const canonicalThemeVariableNames = new Set(
    PACKAGE_CSS_VAR_DEFINITION_CONTRACTS.find(
      contract => contract.packageName === '@openbitfun/theme-openbitfun',
    )?.variables ?? [],
  );
  const generatedWidgetPayloadMissingCanonicalThemeVars = hasGeneratedWidgetPayloadContract
    ? [...canonicalThemeVariableNames]
      .filter(name => !generatedWidgetPayloadVarNames.has(name))
      .sort()
    : [];
  const generatedWidgetPayloadNonCanonicalVars = hasGeneratedWidgetPayloadContract
    ? [...generatedWidgetPayloadVarNames]
      .filter(name => !canonicalThemeVariableNames.has(name))
      .sort()
    : [];
  const generatedWidgetPayloadMissingCompatibilityCanonicals = [
    ...generatedWidgetPayloadCompatibilityAliases,
    ...generatedWidgetPayloadCompatibilityFamilies,
  ]
    .filter(entry => !entry.canonicalDefinitionKind)
    .map(({ key, canonical, count, files }) => ({ key, canonical, count, files }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const generatedWidgetPayloadUnexportedCompatibilityCanonicals = [
    ...generatedWidgetPayloadCompatibilityAliases,
    ...generatedWidgetPayloadCompatibilityFamilies,
  ]
    .filter(entry => entry.canonicalDefinitionKind && !generatedWidgetPayloadVarNames.has(entry.canonical))
    .map(({ key, canonical, count, files }) => ({ key, canonical, count, files }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const staleCompatibilityAliasEntries = checksFullThemeSourceRoot
    ? TOKEN_COMPATIBILITY_ALIAS_CONTRACTS
      .map(contract => ({
        key: contract.key,
        canonical: contract.canonical,
        definitionKind: getDefinitionKind(contract.key),
        canonicalDefinitionKind: getDefinitionKind(contract.canonical),
      }))
      .filter(entry => !entry.definitionKind || !entry.canonicalDefinitionKind)
      .sort((a, b) => a.key.localeCompare(b.key))
    : [];
  const staleCompatibilityAliasFamilyEntries = checksFullThemeSourceRoot
    ? compatibilityAliasFamilyEntries
      .filter(entry => !entry.canonicalDefined)
      .map(entry => ({ key: entry.key, canonical: entry.canonical }))
    : [];
  const uncontractedFallbackVars = fallbackVars
    .filter(entry => !FALLBACK_VAR_CONTRACT_BY_KEY.has(entry.key))
    .map(entry => ({
      key: entry.key,
      count: entry.count,
      files: entry.files,
    }));
  const staleFallbackContractEntries = checksFullThemeSourceRoot
    ? FALLBACK_VAR_CONTRACTS
      .filter(contract => !fallbackTokenCounts.has(contract.key))
      .map(contract => ({ key: contract.key }))
      .sort((a, b) => a.key.localeCompare(b.key))
    : [];
  const missingColorDomainContractEntries = COLOR_DOMAIN_RULES
    .filter(rule => !COLOR_DOMAIN_CONTRACT_BY_KEY.has(rule.key))
    .map(rule => ({ key: rule.key }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const staleColorDomainContractEntries = COLOR_DOMAIN_CONTRACTS
    .filter(contract => !COLOR_DOMAIN_KEYS.includes(contract.key))
    .map(contract => ({ key: contract.key }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const activeUncontractedColorDomainEntries = Object.entries(colorDomainScopes)
    .filter(([key, scope]) => (
      key !== 'appUi'
      && scope.occurrences > 0
      && !COLOR_DOMAIN_CONTRACT_BY_KEY.has(key)
    ))
    .map(([key, scope]) => ({ key, count: scope.occurrences }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const surfaceTokenRenameEntries = SURFACE_TOKEN_RENAME_CONTRACTS
    .map(contract => {
      const usageCount = varUsageCounts.get(contract.key) ?? 0;
      const definitionCount = varDefinitionCounts.get(contract.key) ?? 0;
      const files = new Set([
        ...Array.from(varUsageFiles.get(contract.key) ?? []),
        ...Array.from(varDefinitionFiles.get(contract.key) ?? []),
      ]);
      return {
        key: contract.key,
        canonical: contract.canonical,
        usageCount,
        definitionCount,
        count: usageCount + definitionCount,
        files: Array.from(files).sort().slice(0, 5),
      };
    })
    .filter(entry => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const missingSurfaceTokenRenameCanonicalEntries = checksFullThemeSourceRoot
    ? SURFACE_TOKEN_RENAME_CONTRACTS
      .map(contract => ({
        key: contract.key,
        canonical: contract.canonical,
        canonicalDefinitionKind: getDefinitionKind(contract.canonical),
      }))
      .filter(entry => !entry.canonicalDefinitionKind)
      .sort((a, b) => a.key.localeCompare(b.key))
    : [];

  return {
    root: normalizePath(path.relative(cwd, root)) || '.',
    filesScanned: auditedFiles.length,
    ignoredTestFiles: ignoredTestFiles.length,
    ignoredGeneratedFiles: ignoredGeneratedFiles.length,
    ignoredExplicitFiles: ignoredExplicitFiles.length,
    explicitExclusions: options.excludePaths.map(normalizeRootRelativePath).sort(),
    filesWithColors: fileColorCounts.size,
    colorOccurrences,
    packageCssContracts: {
      importedPackages: [...importedPackageNames].sort(),
      importedPackageUnique: importedPackageNames.size,
    },
    uniqueColors: colorCounts.size,
    colorScopes: {
      appUi: {
        occurrences: componentColorOccurrences,
        filesWithColors: componentFileColorCounts.size,
        uniqueColors: componentColorCounts.size,
      },
      token: {
        occurrences: sumMapValues(tokenColorCounts),
        uniqueColors: tokenColorCounts.size,
      },
      exception: {
        occurrences: sumMapValues(exceptionColorCounts),
        uniqueColors: exceptionColorCounts.size,
      },
    },
    colorDomainScopes,
    colorDomainNearPairs,
    componentColorOccurrences,
    componentFilesWithColors: componentFileColorCounts.size,
    uniqueComponentColors,
    tokenUniqueColors: tokenColorCounts.size,
    exceptionUniqueColors: exceptionColorCounts.size,
    fallbackOccurrences,
    fallbackUniqueTokens: fallbackVars.length,
    budget: {
      uniqueAppColorBudget: options.budget,
      uniqueComponentColors,
      overBudgetBy: Math.max(0, uniqueComponentColors - options.budget),
    },
    topColors: topEntries(colorCounts, options.top),
    topComponentColors: topEntries(componentColorCounts, options.top),
    topFiles: topEntries(fileColorCounts, options.top),
    topFallbackTokens: fallbackVars.slice(0, options.top).map(({ key, count }) => ({ key, count })),
    fallbackVars,
    fallbackContracts: {
      registeredUnique: FALLBACK_VAR_CONTRACTS.length,
      uncontractedUnique: uncontractedFallbackVars.length,
      staleRegisteredUnique: staleFallbackContractEntries.length,
    },
    uncontractedFallbackVars,
    staleFallbackContracts: staleFallbackContractEntries,
    compatibilityAliases: {
      registeredUnique: TOKEN_COMPATIBILITY_ALIAS_CONTRACTS.length,
      usedUnique: compatibilityAliasEntries.length,
      occurrences: compatibilityAliasEntries.reduce((total, entry) => total + entry.count, 0),
      staleRegisteredUnique: staleCompatibilityAliasEntries.length,
      familyRegisteredUnique: TOKEN_COMPATIBILITY_ALIAS_FAMILY_CONTRACTS.length,
      familyUsedUnique: compatibilityAliasFamilyEntries.filter(entry => entry.usedUnique > 0).length,
      familyOccurrences: compatibilityAliasFamilyEntries.reduce((total, entry) => total + entry.count, 0),
      staleRegisteredFamilyUnique: staleCompatibilityAliasFamilyEntries.length,
      missingCanonicalUnique: missingCompatibilityAliasCanonicalEntries.length,
      top: compatibilityAliasEntries.slice(0, options.top),
      families: compatibilityAliasFamilyEntries,
    },
    generatedWidgetPayload: {
      present: hasGeneratedWidgetPayloadContract,
      varUnique: generatedWidgetPayloadVars.length,
      occurrences: generatedWidgetPayloadVars.reduce((total, entry) => total + entry.count, 0),
      missingCanonicalThemeUnique: generatedWidgetPayloadMissingCanonicalThemeVars.length,
      nonCanonicalUnique: generatedWidgetPayloadNonCanonicalVars.length,
      undefinedUnique: generatedWidgetPayloadUndefinedVars.length,
      compatibilityAliasUnique: generatedWidgetPayloadCompatibilityAliases.length,
      compatibilityAliasOccurrences: generatedWidgetPayloadCompatibilityAliases.reduce(
        (total, entry) => total + entry.count,
        0,
      ),
      compatibilityAliasFamilyUnique: generatedWidgetPayloadCompatibilityFamilies.length,
      compatibilityAliasFamilyOccurrences: generatedWidgetPayloadCompatibilityFamilies.reduce(
        (total, entry) => total + entry.count,
        0,
      ),
      externalOnlyCompatibilityUnique: generatedWidgetPayloadExternalOnlyCompatibility.length,
      externalOnlyCompatibilityOccurrences: generatedWidgetPayloadExternalOnlyCompatibility.reduce(
        (total, entry) => total + entry.count,
        0,
      ),
      missingCompatibilityCanonicalUnique: generatedWidgetPayloadMissingCompatibilityCanonicals.length,
      unexportedCompatibilityCanonicalUnique: generatedWidgetPayloadUnexportedCompatibilityCanonicals.length,
      topCompatibilityAliases: generatedWidgetPayloadCompatibilityAliases.slice(0, options.top),
      topCompatibilityFamilies: generatedWidgetPayloadCompatibilityFamilies.slice(0, options.top),
      externalOnlyCompatibility: generatedWidgetPayloadExternalOnlyCompatibility.slice(0, REPORT_ROW_LIMIT),
      undefinedVars: generatedWidgetPayloadUndefinedVars.slice(0, REPORT_ROW_LIMIT),
      missingCanonicalThemeVars: generatedWidgetPayloadMissingCanonicalThemeVars.slice(0, REPORT_ROW_LIMIT),
      nonCanonicalVars: generatedWidgetPayloadNonCanonicalVars.slice(0, REPORT_ROW_LIMIT),
      missingCompatibilityCanonicals: generatedWidgetPayloadMissingCompatibilityCanonicals.slice(0, REPORT_ROW_LIMIT),
      unexportedCompatibilityCanonicals: generatedWidgetPayloadUnexportedCompatibilityCanonicals.slice(
        0,
        REPORT_ROW_LIMIT,
      ),
    },
    staleCompatibilityAliases: staleCompatibilityAliasEntries,
    staleCompatibilityAliasFamilies: staleCompatibilityAliasFamilyEntries,
    missingCompatibilityAliasCanonicals: missingCompatibilityAliasCanonicalEntries,
    colorDomainContracts: {
      registeredUnique: COLOR_DOMAIN_CONTRACTS.length,
      missingRegisteredUnique: missingColorDomainContractEntries.length,
      staleRegisteredUnique: staleColorDomainContractEntries.length,
      activeUncontractedUnique: activeUncontractedColorDomainEntries.length,
    },
    missingColorDomainContracts: missingColorDomainContractEntries,
    staleColorDomainContracts: staleColorDomainContractEntries,
    activeUncontractedColorDomains: activeUncontractedColorDomainEntries,
    surfaceTokenRenames: {
      registeredUnique: SURFACE_TOKEN_RENAME_CONTRACTS.length,
      activeUnique: surfaceTokenRenameEntries.length,
      activeOccurrences: surfaceTokenRenameEntries.reduce((total, entry) => total + entry.count, 0),
      missingCanonicalUnique: missingSurfaceTokenRenameCanonicalEntries.length,
      active: surfaceTokenRenameEntries.slice(0, REPORT_ROW_LIMIT),
      missingCanonicals: missingSurfaceTokenRenameCanonicalEntries.slice(0, REPORT_ROW_LIMIT),
    },
    tokenAliasLiterals: {
      occurrences: sumMapValues(tokenAliasLiteralCounts),
      uniqueColors: tokenAliasLiteralCounts.size,
      top: tokenAliasLiteralRows,
    },
    undefinedVars,
    cssVarDefinitions: {
      definedUnique: definedVars.size,
      contractDefinedUnique: contractVarDefinitions.size,
      staticContractDefinedUnique: staticContractVarDefinitions.size,
      runtimeContractDefinedUnique: runtimeContractVarDefinitions.size,
      dynamicFamilyPrefixes: Array.from(dynamicDefinitionPrefixes).sort(),
      dynamicFamilyUnexportedUnique: dynamicFamilyUnexportedEntries.length,
      unregisteredDynamicFamilyUnique: unregisteredDynamicFamilyEntries.length,
      staleRegisteredDynamicFamilyUnique: staleRegisteredDynamicFamilyEntries.length,
      unresolvedUnique: unresolvedVarEntries.length,
      fallbackOnlyUnique: fallbackOnlyEntries.length,
      unresolvedRequiredUnique: unresolvedRequiredEntries.length,
      runtimeOnlyRequiredContractUnique: runtimeOnlyRequiredContractEntries.length,
      staticContractExternalUsageUnique: staticContractExternalUsageVars.length,
      staticContractInternalOnlyUnique: staticContractInternalOnlyVars.length,
      staticContractLowExternalUsageUnique: staticContractLowExternalUsageVars.length,
      nonContractCrossFileUnique: nonContractDefinedEntries.length,
      nonContractDynamicInputUnique: nonContractDynamicInputEntries.length,
      nonContractCssPrivateUnique: nonContractCssPrivateEntries.length,
    },
    staticContractInternalOnlyVars: staticContractInternalOnlyVars.slice(0, REPORT_ROW_LIMIT),
    staticContractLowExternalUsageVars: staticContractLowExternalUsageVars.slice(0, REPORT_ROW_LIMIT),
    dynamicDefinedVars,
    dynamicFamilyUnexportedVars,
    unregisteredDynamicFamilies: unregisteredDynamicFamilyEntries,
    staleRegisteredDynamicFamilies: staleRegisteredDynamicFamilyEntries,
    nonContractDefinedVars,
    nonContractDynamicInputVars,
    nonContractCssPrivateVars,
    runtimeOnlyRequiredContractVars,
    fallbackOnlyVars,
    unresolvedRequiredVars,
    nearPairs,
    summary: {
      baseline: {
        path: null,
        enforced: false,
        failures: [],
      },
    },
  };
}

function printText(report) {
  const printRows = rows => rows.map(row => `  ${row.count.toString().padStart(5)}  ${row.key}`).join('\n') || '  none';

  console.log(`Theme color audit: ${report.root}`);
  console.log(`Files scanned: ${report.filesScanned}`);
  console.log(`Ignored test files: ${report.ignoredTestFiles}`);
  console.log(`Ignored generated files: ${report.ignoredGeneratedFiles}`);
  console.log(`Ignored explicitly excluded files: ${report.ignoredExplicitFiles}`);
  console.log(`Files with colors: ${report.filesWithColors}`);
  console.log(`Color occurrences: ${report.colorOccurrences}`);
  console.log(`Unique colors: ${report.uniqueColors}`);
  console.log(`Component/non-token color occurrences: ${report.componentColorOccurrences}`);
  console.log(`Files with component/non-token colors: ${report.componentFilesWithColors}`);
  console.log(`Unique component/non-token colors: ${report.uniqueComponentColors}`);
  console.log(`Unique component color budget: ${report.budget.uniqueAppColorBudget}`);
  console.log(`Over budget by: ${report.budget.overBudgetBy}`);
  console.log(`Fallback var occurrences: ${report.fallbackOccurrences}`);
  console.log(`Fallback var unique tokens: ${report.fallbackUniqueTokens}`);
  console.log(`Token-equivalent app literal occurrences: ${report.tokenAliasLiterals.occurrences}`);
  console.log(`Token-equivalent app literal unique colors: ${report.tokenAliasLiterals.uniqueColors}`);
  console.log(
    `Compatibility aliases: registered=${report.compatibilityAliases.registeredUnique}, ` +
    `used=${report.compatibilityAliases.usedUnique}, ` +
    `occurrences=${report.compatibilityAliases.occurrences}, ` +
    `stale=${report.compatibilityAliases.staleRegisteredUnique}, ` +
    `families=${report.compatibilityAliases.familyRegisteredUnique}, ` +
    `staleFamilies=${report.compatibilityAliases.staleRegisteredFamilyUnique}, ` +
    `missingCanonicals=${report.compatibilityAliases.missingCanonicalUnique}`
  );
  console.log(
    `Generated widget payload: vars=${report.generatedWidgetPayload.varUnique}, ` +
    `missingCanonicalTheme=${report.generatedWidgetPayload.missingCanonicalThemeUnique}, ` +
    `nonCanonical=${report.generatedWidgetPayload.nonCanonicalUnique}, ` +
    `undefined=${report.generatedWidgetPayload.undefinedUnique}, ` +
    `compatAliases=${report.generatedWidgetPayload.compatibilityAliasUnique}, ` +
    `compatAliasFamilies=${report.generatedWidgetPayload.compatibilityAliasFamilyUnique}, ` +
    `externalOnlyCompat=${report.generatedWidgetPayload.externalOnlyCompatibilityUnique}, ` +
    `missingCompatCanonicals=${report.generatedWidgetPayload.missingCompatibilityCanonicalUnique}, ` +
    `unexportedCompatCanonicals=${report.generatedWidgetPayload.unexportedCompatibilityCanonicalUnique}`
  );
  console.log(
    `Fallback contracts: registered=${report.fallbackContracts.registeredUnique}, ` +
    `uncontracted=${report.fallbackContracts.uncontractedUnique}, ` +
    `stale=${report.fallbackContracts.staleRegisteredUnique}`
  );
  console.log(
    `Color domain contracts: registered=${report.colorDomainContracts.registeredUnique}, ` +
    `missing=${report.colorDomainContracts.missingRegisteredUnique}, ` +
    `stale=${report.colorDomainContracts.staleRegisteredUnique}, ` +
    `activeUncontracted=${report.colorDomainContracts.activeUncontractedUnique}`
  );
  console.log(
    `Surface token renames: registered=${report.surfaceTokenRenames.registeredUnique}, ` +
    `active=${report.surfaceTokenRenames.activeUnique}, ` +
    `occurrences=${report.surfaceTokenRenames.activeOccurrences}, ` +
    `missingCanonicals=${report.surfaceTokenRenames.missingCanonicalUnique}`
  );

  console.log('\nTop colors:');
  console.log(printRows(report.topColors));

  console.log('\nTop component/non-token colors:');
  console.log(printRows(report.topComponentColors));

  console.log('\nColor domain scopes:');
  for (const key of COLOR_DOMAIN_KEYS) {
    const scope = report.colorDomainScopes[key];
    if (!scope || scope.occurrences === 0) {
      continue;
    }
    console.log(
      `  ${COLOR_DOMAIN_LABELS[key].padEnd(18)} ` +
      `occurrences=${scope.occurrences.toString().padStart(4)}  ` +
      `unique=${scope.uniqueColors.toString().padStart(4)}  ` +
      `files=${scope.filesWithColors.toString().padStart(3)}`
    );
  }

  console.log('\nSpecialized color-domain near pairs:');
  let printedDomainNearPairs = false;
  for (const key of COLOR_DOMAIN_KEYS.filter(domainKey => domainKey !== 'appUi')) {
    const pairs = report.colorDomainNearPairs[key];
    if (!pairs || (pairs.indistinguishableTotal === 0 && pairs.nearTotal === 0)) {
      continue;
    }
    printedDomainNearPairs = true;
    console.log(
      `  ${COLOR_DOMAIN_LABELS[key].padEnd(18)} ` +
      `indistinguishable=${pairs.indistinguishableTotal.toString().padStart(4)}  ` +
      `near=${pairs.nearTotal.toString().padStart(4)}`
    );
    for (const pair of pairs.indistinguishable.slice(0, 3)) {
      console.log(
        `    indistinguishable ${pair.a} <-> ${pair.b}  ` +
        `distance=${pair.distance.toFixed(2)}  alphaDiff=${pair.alphaDiff.toFixed(3)}  ` +
        `combined=${pair.count}`
      );
    }
    for (const pair of pairs.near.slice(0, 3)) {
      console.log(
        `    near ${pair.a} <-> ${pair.b}  ` +
        `distance=${pair.distance.toFixed(2)}  alphaDiff=${pair.alphaDiff.toFixed(3)}  ` +
        `combined=${pair.count}`
      );
    }
  }
  if (!printedDomainNearPairs) {
    console.log('  none');
  }

  console.log('\nTop files:');
  console.log(printRows(report.topFiles));

  console.log('\nTop fallback tokens:');
  console.log(printRows(report.topFallbackTokens));

  console.log('\nUncontracted fallback tokens:');
  console.log(printRows(report.uncontractedFallbackVars.slice(0, 10)));

  console.log('\nStale fallback token contracts:');
  console.log(printRows(report.staleFallbackContracts.slice(0, 10).map(row => ({ ...row, count: 1 }))));

  console.log('\nTop compatibility alias usage:');
  if (report.compatibilityAliases.top.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.compatibilityAliases.top.slice(0, 10)) {
      console.log(
        `  ${row.count.toString().padStart(5)}  ${row.key} -> ${row.canonical}  files=${row.files.join(', ')}`
      );
    }
  }

  console.log('\nCompatibility alias families:');
  if (report.compatibilityAliases.families.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.compatibilityAliases.families) {
      console.log(
        `  ${row.count.toString().padStart(5)}  ${row.key}* -> ${row.canonical}*  ` +
        `usedUnique=${row.usedUnique}  defined=${row.defined}  canonicalDefined=${row.canonicalDefined}`
      );
    }
  }

  console.log('\nStale compatibility aliases:');
  if (report.staleCompatibilityAliases.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.staleCompatibilityAliases.slice(0, 10)) {
      console.log(`  ${row.key} -> ${row.canonical}`);
    }
  }

  console.log('\nStale compatibility alias families:');
  if (report.staleCompatibilityAliasFamilies.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.staleCompatibilityAliasFamilies.slice(0, 10)) {
      console.log(`  ${row.key}* -> ${row.canonical}*`);
    }
  }

  console.log('\nMissing compatibility alias family canonicals:');
  if (report.missingCompatibilityAliasCanonicals.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.missingCompatibilityAliasCanonicals.slice(0, 10)) {
      console.log(
        `  ${row.key} -> ${row.canonical}  ` +
        `count=${row.count}  files=${row.files.join(', ')}`
      );
    }
  }

  console.log('\nGenerated widget payload compatibility aliases:');
  if (report.generatedWidgetPayload.topCompatibilityAliases.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.generatedWidgetPayload.topCompatibilityAliases.slice(0, 10)) {
      console.log(
        `  ${row.count.toString().padStart(5)}  ${row.key} -> ${row.canonical}  ` +
        `canonicalDefined=${Boolean(row.canonicalDefinitionKind)}`
      );
    }
  }

  console.log('\nGenerated widget payload compatibility families:');
  if (report.generatedWidgetPayload.topCompatibilityFamilies.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.generatedWidgetPayload.topCompatibilityFamilies.slice(0, 10)) {
      console.log(
        `  ${row.count.toString().padStart(5)}  ${row.key} -> ${row.canonical}  ` +
        `canonicalDefined=${Boolean(row.canonicalDefinitionKind)}`
      );
    }
  }

  console.log('\nGenerated widget payload external-only compatibility:');
  if (report.generatedWidgetPayload.externalOnlyCompatibility.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.generatedWidgetPayload.externalOnlyCompatibility.slice(0, 10)) {
      const family = row.familyPrefix ? `  family=${row.familyPrefix}*` : '';
      console.log(
        `  ${row.count.toString().padStart(5)}  ${row.key} -> ${row.canonical}${family}  ` +
        `canonicalDefined=${Boolean(row.canonicalDefinitionKind)}`
      );
    }
  }

  console.log('\nGenerated widget payload undefined vars:');
  console.log(printRows(report.generatedWidgetPayload.undefinedVars.slice(0, 10)));

  console.log('\nGenerated widget payload missing compatibility canonicals:');
  if (report.generatedWidgetPayload.missingCompatibilityCanonicals.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.generatedWidgetPayload.missingCompatibilityCanonicals.slice(0, 10)) {
      console.log(
        `  ${row.key} -> ${row.canonical}  ` +
        `count=${row.count}  files=${row.files.join(', ')}`
      );
    }
  }

  console.log('\nGenerated widget payload unexported compatibility canonicals:');
  if (report.generatedWidgetPayload.unexportedCompatibilityCanonicals.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.generatedWidgetPayload.unexportedCompatibilityCanonicals.slice(0, 10)) {
      console.log(
        `  ${row.key} -> ${row.canonical}  ` +
        `count=${row.count}  files=${row.files.join(', ')}`
      );
    }
  }

  console.log('\nColor domain contract gaps:');
  const colorDomainGapRows = [
    ...report.missingColorDomainContracts.map(row => ({ ...row, count: 1 })),
    ...report.staleColorDomainContracts.map(row => ({ ...row, count: 1 })),
    ...report.activeUncontractedColorDomains,
  ];
  console.log(printRows(colorDomainGapRows.slice(0, 10)));

  console.log('\nSurface token rename debt:');
  if (report.surfaceTokenRenames.active.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.surfaceTokenRenames.active.slice(0, 10)) {
      console.log(
        `  ${row.key} -> ${row.canonical}  ` +
        `count=${row.count}  definitions=${row.definitionCount}  usages=${row.usageCount}  ` +
        `files=${row.files.join(', ')}`
      );
    }
  }

  console.log('\nSurface token rename missing canonicals:');
  if (report.surfaceTokenRenames.missingCanonicals.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.surfaceTokenRenames.missingCanonicals.slice(0, 10)) {
      console.log(`  ${row.key} -> ${row.canonical}`);
    }
  }

  console.log('\nTop token-equivalent app literals:');
  if (report.tokenAliasLiterals.top.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.tokenAliasLiterals.top) {
      console.log(
        `  ${row.count.toString().padStart(5)}  ${row.key}  ` +
        `aliases=${row.aliases.join(', ')}  files=${row.files.join(', ')}`
      );
    }
  }

  console.log('\nUnresolved CSS vars before fallback classification (top):');
  console.log(printRows(report.undefinedVars));
  console.log(
    `\nCSS var definition coverage: defined=${report.cssVarDefinitions.definedUnique}, ` +
    `contractDefined=${report.cssVarDefinitions.contractDefinedUnique}, ` +
    `staticContract=${report.cssVarDefinitions.staticContractDefinedUnique}, ` +
    `runtimeContract=${report.cssVarDefinitions.runtimeContractDefinedUnique}, ` +
    `dynamicFamilies=${report.cssVarDefinitions.dynamicFamilyPrefixes.length}, ` +
    `unregisteredDynamicFamilies=${report.cssVarDefinitions.unregisteredDynamicFamilyUnique}, ` +
    `staleRegisteredDynamicFamilies=${report.cssVarDefinitions.staleRegisteredDynamicFamilyUnique}, ` +
    `unresolved=${report.cssVarDefinitions.unresolvedUnique}, ` +
    `fallbackOnly=${report.cssVarDefinitions.fallbackOnlyUnique}, ` +
    `requiredMissing=${report.cssVarDefinitions.unresolvedRequiredUnique}, ` +
    `runtimeOnlyRequired=${report.cssVarDefinitions.runtimeOnlyRequiredContractUnique}, ` +
    `staticContractExternal=${report.cssVarDefinitions.staticContractExternalUsageUnique}, ` +
    `staticContractInternalOnly=${report.cssVarDefinitions.staticContractInternalOnlyUnique}, ` +
    `staticContractLowExternal=${report.cssVarDefinitions.staticContractLowExternalUsageUnique}, ` +
    `dynamicFamilyUnexported=${report.cssVarDefinitions.dynamicFamilyUnexportedUnique}, ` +
    `nonContractCrossFile=${report.cssVarDefinitions.nonContractCrossFileUnique}, ` +
    `nonContractDynamicInputs=${report.cssVarDefinitions.nonContractDynamicInputUnique}, ` +
    `nonContractCssPrivate=${report.cssVarDefinitions.nonContractCssPrivateUnique}`
  );

  console.log('\nDynamic/runtime-defined CSS vars (top):');
  console.log(
    report.dynamicDefinedVars
      .slice(0, 10)
      .map(row => `  ${row.count.toString().padStart(5)}  ${row.key}  ${row.kind}`)
      .join('\n') || '  none'
  );

  console.log('\nUnregistered dynamic CSS var families:');
  if (report.unregisteredDynamicFamilies.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.unregisteredDynamicFamilies.slice(0, 10)) {
      console.log(`  ${row.key}  definitions=${row.files.join(', ')}`);
    }
  }

  console.log('\nStale registered dynamic CSS var families:');
  console.log(printRows(report.staleRegisteredDynamicFamilies.slice(0, 10).map(row => ({ ...row, count: 1 }))));

  console.log('\nDynamic-family CSS vars without exact export (top):');
  if (report.dynamicFamilyUnexportedVars.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.dynamicFamilyUnexportedVars.slice(0, 10)) {
      console.log(
        `  ${row.count.toString().padStart(5)}  ${row.key}  ` +
        `prefix=${row.prefix}  files=${row.files.join(', ')}`
      );
    }
  }

  console.log('\nFallback-only unresolved CSS vars (top):');
  console.log(printRows(report.fallbackOnlyVars.slice(0, 10)));

  console.log('\nNon-contract CSS vars used across files (top):');
  if (report.nonContractDefinedVars.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.nonContractDefinedVars.slice(0, 10)) {
      console.log(
        `  ${row.count.toString().padStart(5)}  ${row.key}  ` +
        `usageFiles=${row.usageFileCount}  kinds=${row.definitionKinds.join('+')}  ` +
        `definitions=${row.definitionFiles.join(', ')}`
      );
    }
  }

  console.log('\nNon-contract dynamic input CSS vars (top):');
  if (report.nonContractDynamicInputVars.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.nonContractDynamicInputVars.slice(0, 10)) {
      console.log(
        `  ${row.count.toString().padStart(5)}  ${row.key}  ` +
        `usageFiles=${row.usageFileCount}  definitions=${row.definitionFiles.join(', ')}`
      );
    }
  }

  console.log('\nNon-contract component-private CSS vars (top):');
  if (report.nonContractCssPrivateVars.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.nonContractCssPrivateVars.slice(0, 10)) {
      console.log(
        `  ${row.count.toString().padStart(5)}  ${row.key}  ` +
        `usageFiles=${row.usageFileCount}  definitions=${row.definitionFiles.join(', ')}`
      );
    }
  }

  console.log('\nRequired unresolved CSS vars (top):');
  if (report.unresolvedRequiredVars.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.unresolvedRequiredVars.slice(0, 10)) {
      console.log(`  ${row.count.toString().padStart(5)}  ${row.key}  files=${row.files.join(', ')}`);
    }
  }

  console.log('\nRuntime-only contract CSS vars without fallback (top):');
  if (report.runtimeOnlyRequiredContractVars.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.runtimeOnlyRequiredContractVars.slice(0, 10)) {
      console.log(
        `  ${row.count.toString().padStart(5)}  ${row.key}  ` +
        `usageFiles=${row.usageFileCount}  definitions=${row.definitionFiles.join(', ')}`
      );
    }
  }

  console.log('\nStatic contract internal-only CSS vars (top):');
  if (report.staticContractInternalOnlyVars.length === 0) {
    console.log('  none');
  } else {
    for (const row of report.staticContractInternalOnlyVars.slice(0, 10)) {
      console.log(
        `  ${row.internalUsageCount.toString().padStart(5)}  ${row.key}  ` +
        `definitions=${row.definitionFiles.join(', ')}`
      );
    }
  }

  console.log(`\nIndistinguishable component color pairs (total=${report.nearPairs.indistinguishableTotal}, sample):`);
  if (report.nearPairs.indistinguishableTotal === 0) {
    console.log('  none');
  } else {
    for (const pair of report.nearPairs.indistinguishable.slice(0, 10)) {
      console.log(`  ${pair.a} <-> ${pair.b}  distance=${pair.distance.toFixed(2)}  alphaDiff=${pair.alphaDiff.toFixed(3)}  combined=${pair.count}`);
    }
  }

  console.log(`\nNear component color pairs needing evidence (total=${report.nearPairs.nearTotal}, sample):`);
  if (report.nearPairs.nearTotal === 0) {
    console.log('  none');
  } else {
    for (const pair of report.nearPairs.near.slice(0, 10)) {
      console.log(`  ${pair.a} <-> ${pair.b}  distance=${pair.distance.toFixed(2)}  alphaDiff=${pair.alphaDiff.toFixed(3)}  combined=${pair.count}`);
    }
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const report = audit(options);
  const baselineSummary = applyBaseline(report, options);
  if (options.reportJson) {
    writeReportJson(report, options.reportJson);
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printText(report);
  }
  if (baselineSummary.failures.length > 0) {
    console.error('\nTheme color audit baseline failures:');
    for (const failure of baselineSummary.failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
