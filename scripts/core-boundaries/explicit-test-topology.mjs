import { readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

export const agentRuntimeIntegrationTestTargets = [
  { name: 'agent_definition_contracts', path: 'tests/agent_definition_contracts.rs', requiredFeatures: ['agent-runtime'] },
  { name: 'agent_interaction_contracts', path: 'tests/agent_interaction_contracts.rs', requiredFeatures: ['agent-runtime'] },
  { name: 'agent_long_horizon_contracts', path: 'tests/agent_long_horizon_contracts.rs', requiredFeatures: ['agent-runtime'] },
  { name: 'agent_session_contracts', path: 'tests/agent_session_contracts.rs', requiredFeatures: ['agent-runtime'] },
  {
    name: 'native_hook_execution_contracts',
    path: 'tests/native_hook_execution_contracts.rs',
    requiredFeatures: ['native-hook-runtime'],
  },
  {
    name: 'native_hook_settings_contracts',
    path: 'tests/native_hook_settings_contracts.rs',
    requiredFeatures: ['native-hook-settings'],
  },
];

export const agentWorkflowsIntegrationTestTargets = [
  {
    name: 'deep_research_contracts',
    path: 'tests/deep_research_contracts.rs',
    forbidRequiredFeatures: true,
  },
];

export const cliIntegrationTestTargets = [
  { name: 'acp_stdio_cli', path: 'tests/acp_stdio_cli.rs' },
  { name: 'app_server_stdio_cli', path: 'tests/app_server_stdio_cli.rs' },
  { name: 'cli_command_contracts', path: 'tests/cli_command_contracts.rs' },
  { name: 'terminal_process_contracts', path: 'tests/terminal_process_contracts.rs' },
];

export const servicesCoreIntegrationTestTargets = [
  { name: 'markdown_owner_contracts', path: 'tests/markdown_owner_contracts.rs' },
  { name: 'declarative_workspace_instruction_contracts', path: 'tests/declarative_workspace_instruction_contracts.rs' },
  { name: 'runtime_ownership_contracts', path: 'tests/runtime_ownership_contracts.rs' },
  { name: 'local_runtime_ports', path: 'tests/local_runtime_ports.rs' },
  { name: 'permission_store_contracts', path: 'tests/permission_store_contracts.rs' },
  { name: 'workspace_instruction_contracts', path: 'tests/workspace_instruction_contracts.rs' },
  { name: 'session_write_lock_contracts', path: 'tests/session_write_lock_contracts.rs' },
  { name: 'process_runtime_contracts', path: 'tests/process_runtime_contracts.rs' },
  { name: 'service_contracts', path: 'tests/service_contracts.rs' },
  { name: 'storage_owner_contracts', path: 'tests/storage_owner_contracts.rs' },
  { name: 'session_contracts', path: 'tests/session_contracts.rs' },
  { name: 'session_usage_contracts', path: 'tests/session_usage_contracts.rs' },
];

export const servicesIntegrationsIntegrationTestTargets = [
  { name: 'script_tool_runtime', path: 'tests/script_tool_runtime.rs' },
  { name: 'announcement_contracts', path: 'tests/announcement_contracts.rs' },
  { name: 'file_watch_contracts', path: 'tests/file_watch_contracts.rs' },
  { name: 'function_agent_contracts', path: 'tests/function_agent_contracts.rs' },
  { name: 'git_contracts', path: 'tests/git_contracts.rs' },
  {
    name: 'miniapp_loopx_contracts',
    path: 'tests/miniapp_loopx_contracts.rs',
    requiredFeatures: ['miniapp-loopx'],
  },
  { name: 'mcp_contracts', path: 'tests/mcp_contracts.rs' },
  { name: 'mcp_streamable_http_contracts', path: 'tests/mcp_streamable_http_contracts.rs' },
  { name: 'remote_connect_contracts', path: 'tests/remote_connect_contracts.rs' },
  { name: 'remote_ssh_contracts', path: 'tests/remote_ssh_contracts.rs' },
  { name: 'remote_workspace_search_disabled_contracts', path: 'tests/remote_workspace_search_disabled_contracts.rs' },
  { name: 'workspace_search_contracts', path: 'tests/workspace_search_contracts.rs' },
];

export const opencodeAdapterIntegrationTestTargets = [
  { name: 'opencode_mcp_adapter', path: 'tests/opencode_mcp_adapter.rs' },
  { name: 'opencode_source_adapter', path: 'tests/opencode_source_adapter.rs' },
  {
    name: 'opencode_static_source_contracts',
    path: 'tests/opencode_static_source_contracts.rs',
    leaves: [
      'tests/opencode_static_source_contracts/hook_source.rs',
      'tests/opencode_static_source_contracts/opencode_command_adapter.rs',
      'tests/opencode_static_source_contracts/opencode_skill_roots.rs',
      'tests/opencode_static_source_contracts/opencode_subagent_adapter.rs',
      'tests/opencode_static_source_contracts/opencode_workspace_references.rs',
    ],
    forbidRequiredFeatures: true,
  },
  { name: 'tool_source_contracts', path: 'tests/tool_source_contracts.rs' },
];

export const claudeCodeAdapterIntegrationTestTargets = [
  {
    name: 'claude_code_source_contracts',
    path: 'tests/claude_code_source_contracts.rs',
    leaves: [
      'tests/claude_code_source_contracts/command_source.rs',
      'tests/claude_code_source_contracts/hook_source.rs',
      'tests/claude_code_source_contracts/mcp_source.rs',
      'tests/claude_code_source_contracts/subagent_source.rs',
    ],
    forbidRequiredFeatures: true,
  },
];

export const codexAdapterIntegrationTestTargets = [
  {
    name: 'codex_source_contracts',
    path: 'tests/codex_source_contracts.rs',
    leaves: [
      'tests/codex_source_contracts/hook_source.rs',
      'tests/codex_source_contracts/mcp_source.rs',
      'tests/codex_source_contracts/subagent_source.rs',
    ],
    forbidRequiredFeatures: true,
  },
];

export const externalSourcesIntegrationTestTargets = [
  {
    name: 'external_source_coordination_contracts',
    path: 'tests/external_source_coordination_contracts.rs',
    leaves: [
      'tests/external_source_coordination_contracts/control_plane.rs',
      'tests/external_source_coordination_contracts/coordinator_contracts.rs',
      'tests/external_source_coordination_contracts/hook_coordinator.rs',
      'tests/external_source_coordination_contracts/mcp_coordinator.rs',
      'tests/external_source_coordination_contracts/subagent_coordinator.rs',
      'tests/external_source_coordination_contracts/tool_coordinator_contracts.rs',
      'tests/external_source_coordination_contracts/workspace_reference.rs',
    ],
    forbidRequiredFeatures: true,
  },
];

export const coreTypesIntegrationTestTargets = [
  {
    name: 'core_type_contracts',
    path: 'tests/core_type_contracts.rs',
    leaves: [
      'tests/core_type_contracts/agent_identity.rs',
      'tests/core_type_contracts/session_contracts.rs',
      'tests/core_type_contracts/session_usage_contracts.rs',
      'tests/core_type_contracts/surface_contracts.rs',
    ],
    forbidRequiredFeatures: true,
  },
];

export const runtimePortsIntegrationTestTargets = [
  {
    name: 'plugin_runtime_contracts',
    path: 'tests/runtime_port_contracts.rs',
    leaves: [
      'tests/runtime_port_contracts/plugin_runtime_contracts.rs',
      'tests/runtime_port_contracts/plugin_runtime_diagnostics_contracts.rs',
    ],
    requiredFeatures: ['plugin-runtime'],
  },
  {
    name: 'git_port_contracts',
    path: 'tests/git_port_contracts.rs',
    requiredFeatures: ['git-port'],
  },
  {
    name: 'hook_function_runtime_contracts',
    path: 'tests/hook_function_runtime_contracts.rs',
    requiredFeatures: ['hook-function-runtime'],
  },
  {
    name: 'script_tool_port_contracts',
    path: 'tests/script_tool_port_contracts.rs',
    requiredFeatures: ['script-tool-runtime'],
  },
  {
    name: 'session_store_contracts',
    path: 'tests/session_store_contracts.rs',
    requiredFeatures: ['workspace-ports'],
  },
];

export const productDomainsIntegrationTestTargets = [
  {
    name: 'product_domain_contracts',
    path: 'tests/product_domain_contracts.rs',
    leaves: [
      'tests/product_domain_contracts/canvas_contracts.rs',
      'tests/product_domain_contracts/tool_permission_contracts.rs',
    ],
    forbidRequiredFeatures: true,
  },
  {
    name: 'external_source_contracts',
    path: 'tests/external_source_contracts.rs',
    leaves: [
      'tests/external_source_contracts/external_hook_catalog_contracts.rs',
      'tests/external_source_contracts/external_hook_contribution_contracts.rs',
      'tests/external_source_contracts/external_source_contracts.rs',
      'tests/external_source_contracts/plugin_capability_contracts.rs',
      'tests/external_source_contracts/workspace_reference_contracts.rs',
    ],
    requiredFeatures: ['external-sources'],
  },
  {
    name: 'function_agent_contracts',
    path: 'tests/function_agent_contracts.rs',
    requiredFeatures: ['function-agents'],
  },
  {
    name: 'miniapp_contracts',
    path: 'tests/miniapp_contracts.rs',
    requiredFeatures: ['miniapp'],
  },
  {
    name: 'loopx_contracts',
    path: 'tests/loopx_contracts.rs',
    requiredFeatures: ['miniapp'],
  },
  {
    name: 'legacy_migration_contracts',
    path: 'tests/legacy_migration_contracts.rs',
    requiredFeatures: ['legacy-migration'],
  },
  {
    name: 'plugin_source_contracts',
    path: 'tests/plugin_source_contracts.rs',
    requiredFeatures: ['plugin-source'],
  },
];

export const aiAdaptersIntegrationTestTargets = [
  {
    name: 'ai_protocol_contracts',
    path: 'tests/ai_protocol_contracts.rs',
    leaves: [
      'tests/ai_protocol_contracts/model_selector.rs',
      'tests/ai_protocol_contracts/openai_empty_content_parts.rs',
    ],
    forbidRequiredFeatures: true,
  },
  {
    name: 'ai_stream_contracts',
    path: 'tests/ai_stream_contracts.rs',
    leaves: [
      'tests/ai_stream_contracts/common.rs',
      'tests/ai_stream_contracts/stream_processor_anthropic.rs',
      'tests/ai_stream_contracts/stream_processor_openai.rs',
      'tests/ai_stream_contracts/stream_processor_tool_arguments.rs',
      'tests/ai_stream_contracts/stream_replay_regressions.rs',
      'tests/ai_stream_contracts/stream_test_harness.rs',
    ],
    forbidRequiredFeatures: true,
  },
];

export const productCapabilitiesIntegrationTestTargets = [
  {
    name: 'product_capability_contracts',
    path: 'tests/product_capability_contracts.rs',
    leaves: [
      'tests/product_capability_contracts/plugin_product_shape.rs',
      'tests/product_capability_contracts/product_capabilities.rs',
      'tests/product_capability_contracts/product_sdk_assembly.rs',
      'tests/product_capability_contracts/runtime_boundary.rs',
    ],
    forbidRequiredFeatures: true,
  },
];

function decodeBasicTomlKey(token) {
  let decoded = '';
  const simpleEscapes = new Map([
    ['b', '\b'], ['t', '\t'], ['n', '\n'], ['f', '\f'], ['r', '\r'],
    ['"', '"'], ['\\', '\\'],
  ]);
  for (let index = 1; index < token.length - 1; index += 1) {
    if (token[index] !== '\\') {
      decoded += token[index];
      continue;
    }
    index += 1;
    const escape = token[index];
    if (simpleEscapes.has(escape)) {
      decoded += simpleEscapes.get(escape);
      continue;
    }
    if (escape !== 'u' && escape !== 'U') {
      return null;
    }
    const digitCount = escape === 'u' ? 4 : 8;
    const hex = token.slice(index + 1, index + 1 + digitCount);
    if (!new RegExp(`^[0-9a-fA-F]{${digitCount}}$`).test(hex)) {
      return null;
    }
    const codePoint = Number.parseInt(hex, 16);
    if (codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
      return null;
    }
    decoded += String.fromCodePoint(codePoint);
    index += digitCount;
  }
  return decoded;
}

function tomlFieldName(line) {
  const match = line.match(/^([A-Za-z0-9_-]+|'[^']*'|"(?:[^"\\]|\\.)*")\s*=/);
  if (!match) {
    return null;
  }
  const token = match[1];
  if (token.startsWith("'")) {
    return token.slice(1, -1);
  }
  return token.startsWith('"') ? decodeBasicTomlKey(token) : token;
}

function parseTomlStringArrayValue(line) {
  const equalsIndex = line.indexOf('=');
  const value = equalsIndex === -1 ? '' : line.slice(equalsIndex + 1).trim();
  const array = value.match(/^\[(.*)\]\s*(?:#.*)?$/);
  if (!array) {
    return null;
  }
  const inner = array[1];
  const values = [];
  const stringPattern = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
  let cursor = 0;
  for (const match of inner.matchAll(stringPattern)) {
    if (!/^[\s,]*$/.test(inner.slice(cursor, match.index))) {
      return null;
    }
    const token = match[0];
    const decoded = token.startsWith("'")
      ? token.slice(1, -1)
      : decodeBasicTomlKey(token);
    if (decoded === null) {
      return null;
    }
    values.push(decoded);
    cursor = match.index + token.length;
  }
  return /^[\s,]*$/.test(inner.slice(cursor)) ? values : null;
}

function parseExplicitTestTargets(manifestText) {
  const targets = [];
  let current = null;
  const finishCurrent = () => {
    if (current) {
      targets.push(current);
      current = null;
    }
  };

  for (const line of manifestText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '[[test]]') {
      finishCurrent();
      current = {};
      continue;
    }
    if (trimmed.startsWith('[')) {
      finishCurrent();
      continue;
    }
    if (current && tomlFieldName(trimmed) === 'required-features') {
      current.hasRequiredFeatures = true;
      current.requiredFeatures = parseTomlStringArrayValue(trimmed);
    }
    const field = current && trimmed.match(/^(name|path)\s*=\s*"([^"]+)"\s*$/);
    if (field) {
      current[field[1]] = field[2];
    }
  }
  finishCurrent();
  return targets;
}

function packageDisablesAutotests(manifestText) {
  let inPackage = false;
  for (const line of manifestText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inPackage = trimmed === '[package]';
      continue;
    }
    if (inPackage && /^autotests\s*=\s*false\s*$/.test(trimmed)) {
      return true;
    }
  }
  return false;
}

function parseFlatRootModules(root, source, errors) {
  const references = [];
  const lines = source.split(/\r?\n/);
  let valid = true;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (
      line === ''
      || line.startsWith('//!')
      || /^#!\[cfg\(feature = "[A-Za-z0-9_-]+"\)\]$/.test(line)
    ) {
      continue;
    }
    const pathAttribute = line.match(/^#\[path\s*=\s*"([^"]+)"\]$/);
    const moduleDeclaration = lines[index + 1]?.trim().match(/^mod\s+([A-Za-z0-9_]+)\s*;$/);
    if (!pathAttribute || !moduleDeclaration) {
      errors.push(`grouped test root ${root} contains unsupported line ${index + 1}`);
      valid = false;
      continue;
    }
    references.push({ path: pathAttribute[1], moduleName: moduleDeclaration[1] });
    index += 1;
  }
  return valid ? references : [];
}

function skipRustTrivia(source, start) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      const lineEnd = source.indexOf('\n', index + 2);
      index = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source.startsWith('/*', index)) {
          depth += 1;
          index += 2;
        } else if (source.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth > 0) {
        return { index: source.length, error: 'unterminated block comment' };
      }
      continue;
    }
    break;
  }
  return { index };
}

function rustRawStringEnd(source, start) {
  let quoteIndex = start;
  if (source.startsWith('br', start) || source.startsWith('cr', start)) {
    quoteIndex += 2;
  } else if (source[start] === 'r') {
    quoteIndex += 1;
  } else {
    return null;
  }
  let hashCount = 0;
  while (source[quoteIndex] === '#') {
    hashCount += 1;
    quoteIndex += 1;
  }
  if (source[quoteIndex] !== '"') {
    return null;
  }
  const terminator = `"${'#'.repeat(hashCount)}`;
  const closingIndex = source.indexOf(terminator, quoteIndex + 1);
  return closingIndex === -1 ? -1 : closingIndex + terminator.length;
}

function rustCharLiteralEnd(source, start) {
  if (source[start] !== "'") {
    return null;
  }
  let index = start + 1;
  if (source[index] === '\\') {
    index += 1;
    if (source[index] === 'x') {
      if (!/^[0-9A-Fa-f]{2}$/.test(source.slice(index + 1, index + 3))) {
        return null;
      }
      index += 3;
    } else if (source[index] === 'u' && source[index + 1] === '{') {
      const closingBrace = source.indexOf('}', index + 2);
      if (
        closingBrace === -1
        || !/^[0-9A-Fa-f_]+$/.test(source.slice(index + 2, closingBrace))
      ) {
        return null;
      }
      index = closingBrace + 1;
    } else if (source[index] !== undefined && !/[\r\n]/.test(source[index])) {
      index += 1;
    } else {
      return null;
    }
  } else {
    const codePoint = source.codePointAt(index);
    if (codePoint === undefined || source[index] === "'" || /[\r\n]/.test(source[index])) {
      return null;
    }
    index += codePoint > 0xFFFF ? 2 : 1;
  }
  return source[index] === "'" ? index + 1 : null;
}

function rustQuotedLiteralEnd(source, start) {
  let quoteIndex = start;
  if ((source[start] === 'b' || source[start] === 'c') && source[start + 1] === '"') {
    quoteIndex += 1;
  }
  const quote = source[quoteIndex];
  if (quote !== '"') {
    return null;
  }
  let escaped = false;
  for (let index = quoteIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === quote) {
      return index + 1;
    }
  }
  return -1;
}

function matchingRustAttributeBracket(source, openingIndex) {
  const closingForOpening = new Map([['[', ']'], ['(', ')'], ['{', '}']]);
  const stack = [']'];
  let index = openingIndex + 1;
  while (index < source.length) {
    if (source.startsWith('//', index) || source.startsWith('/*', index)) {
      const trivia = skipRustTrivia(source, index);
      if (trivia.error) {
        return { error: trivia.error };
      }
      index = trivia.index;
      continue;
    }
    const rawStringEnd = rustRawStringEnd(source, index);
    if (rawStringEnd !== null) {
      if (rawStringEnd === -1) {
        return { error: 'unterminated raw string in inner attribute' };
      }
      index = rawStringEnd;
      continue;
    }
    const charLiteralEnd = rustCharLiteralEnd(source, index);
    if (charLiteralEnd !== null) {
      index = charLiteralEnd;
      continue;
    }
    const quotedLiteralEnd = rustQuotedLiteralEnd(source, index);
    if (quotedLiteralEnd !== null) {
      if (quotedLiteralEnd === -1) {
        return { error: 'unterminated quoted literal in inner attribute' };
      }
      index = quotedLiteralEnd;
      continue;
    }
    const character = source[index];
    const closing = closingForOpening.get(character);
    if (closing) {
      stack.push(closing);
    } else if (character === ']' || character === ')' || character === '}') {
      if (stack.at(-1) !== character) {
        return { error: 'mismatched delimiter in inner attribute' };
      }
      stack.pop();
      if (stack.length === 0) {
        return { closingIndex: index };
      }
    }
    index += 1;
  }
  return { error: 'unterminated inner attribute' };
}

function leadingRustInnerAttributes(source) {
  const attributes = [];
  let index = source.charCodeAt(0) === 0xFEFF ? 1 : 0;
  if (source.startsWith('#!', index)) {
    const afterShebangBang = skipRustTrivia(source, index + 2);
    if (!afterShebangBang.error && source[afterShebangBang.index] !== '[') {
      const lineEnd = source.indexOf('\n', index + 2);
      index = lineEnd === -1 ? source.length : lineEnd + 1;
    }
  }
  while (index < source.length) {
    const leadingTrivia = skipRustTrivia(source, index);
    if (leadingTrivia.error) {
      return { attributes, error: leadingTrivia.error };
    }
    index = leadingTrivia.index;
    const attributeStart = index;
    if (source[index] !== '#') {
      break;
    }
    const afterHash = skipRustTrivia(source, index + 1);
    if (afterHash.error) {
      return { attributes, error: afterHash.error };
    }
    if (source[afterHash.index] !== '!') {
      break;
    }
    const afterBang = skipRustTrivia(source, afterHash.index + 1);
    if (afterBang.error) {
      return { attributes, error: afterBang.error };
    }
    if (source[afterBang.index] !== '[') {
      break;
    }
    const matched = matchingRustAttributeBracket(source, afterBang.index);
    if (matched.error) {
      return { attributes, error: matched.error };
    }
    const nameStart = skipRustTrivia(source, afterBang.index + 1);
    if (nameStart.error) {
      return { attributes, error: nameStart.error };
    }
    const nameSource = source.slice(nameStart.index, matched.closingIndex);
    const nameMatch = /^(?:r#)?([A-Za-z_][A-Za-z0-9_]*)/.exec(nameSource);
    if (!nameMatch) {
      return { attributes, error: 'inner attribute has no supported name' };
    }
    attributes.push({
      name: nameMatch[1],
      raw: source.slice(attributeStart, matched.closingIndex + 1).trim(),
    });
    index = matched.closingIndex + 1;
  }
  return { attributes };
}

function validateGroupedLeafCfg(
  leaf,
  leafSource,
  allowedLeafCfgLines,
  errors,
) {
  const scanned = leadingRustInnerAttributes(leafSource);
  if (scanned.error) {
    errors.push(`grouped test leaf ${leaf} has an unsupported crate preamble: ${scanned.error}`);
    return;
  }
  const cfgAttributes = scanned.attributes.filter(
    (attribute) => attribute.name === 'cfg' || attribute.name === 'cfg_attr',
  );
  const allowedLine = allowedLeafCfgLines.get(leaf);
  if (
    allowedLine !== undefined
    && cfgAttributes.length === 1
    && cfgAttributes[0].raw === allowedLine
  ) {
    return;
  }
  if (cfgAttributes.length > 0 || allowedLine !== undefined) {
    errors.push(
      `grouped test leaf ${leaf} has a crate cfg that belongs in its explicit target root`,
    );
  }
}

export function validateExplicitIntegrationTestTopology({
  manifestText,
  expectedTargets,
  topLevelRustFiles,
  rootSources,
  leafRustFiles,
  leafSources,
  allowedLeafCfgLines = new Map(),
}) {
  const errors = [];
  if (!packageDisablesAutotests(manifestText)) {
    errors.push('[package] must keep autotests = false');
  }

  const expectedTargetEntries = expectedTargets.map(({ name, path }) => `${name}=${path}`).sort();
  const actualTargets = parseExplicitTestTargets(manifestText);
  const actualTargetEntries = actualTargets
    .map(({ name, path }) => `${name ?? '<missing-name>'}=${path ?? '<missing-path>'}`)
    .sort();
  if (actualTargetEntries.join('\n') !== expectedTargetEntries.join('\n')) {
    errors.push(`explicit test targets must be exactly: ${expectedTargetEntries.join(', ')}`);
  }
  const targetsWithoutRequiredFeatures = new Set(
    expectedTargets
      .filter(({ forbidRequiredFeatures }) => forbidRequiredFeatures)
      .map(({ name, path }) => `${name}=${path}`),
  );
  for (const { name, path, hasRequiredFeatures } of actualTargets) {
    if (hasRequiredFeatures && targetsWithoutRequiredFeatures.has(`${name}=${path}`)) {
      errors.push(`explicit test target ${name} must not declare required-features`);
    }
  }
  for (const { name, path, requiredFeatures } of expectedTargets) {
    if (requiredFeatures === undefined) {
      continue;
    }
    const actual = actualTargets.find(
      (target) => target.name === name && target.path === path,
    );
    const actualRequiredFeatures = actual?.requiredFeatures;
    if (
      actualRequiredFeatures === null
      || actualRequiredFeatures === undefined
      || [...actualRequiredFeatures].sort().join('\n') !== [...requiredFeatures].sort().join('\n')
    ) {
      errors.push(
        `explicit test target ${name} required-features must be exactly: ${requiredFeatures.join(', ')}`,
      );
    }
  }

  const expectedRoots = expectedTargets.map(({ path }) => path).sort();
  if ([...topLevelRustFiles].sort().join('\n') !== expectedRoots.join('\n')) {
    errors.push(`top-level test roots must be exactly: ${expectedRoots.join(', ')}`);
  }

  const leaves = new Set(leafRustFiles);
  const expectedLeaves = expectedTargets.flatMap(({ leaves: targetLeaves = [] }) => targetLeaves).sort();
  if (
    expectedLeaves.length > 0
    && [...leaves].sort().join('\n') !== expectedLeaves.join('\n')
  ) {
    errors.push(`grouped test leaves must be exactly: ${expectedLeaves.join(', ')}`);
  }
  const referenceCounts = new Map();
  for (const root of expectedRoots) {
    const source = rootSources.get(root);
    if (source === undefined) {
      errors.push(`missing explicit test root: ${root}`);
      continue;
    }
    const wrapperDir = `${root.slice(0, -'.rs'.length)}/`;
    const ownsLeaves = [...leaves].some((leaf) => leaf.startsWith(wrapperDir));
    if (!ownsLeaves) {
      continue;
    }
    for (const reference of parseFlatRootModules(root, source, errors)) {
      const leaf = posix.normalize(posix.join(posix.dirname(root), reference.path));
      if (!leaf.startsWith(wrapperDir)) {
        errors.push(`grouped test root ${root} may only reference leaves under ${wrapperDir}`);
        continue;
      }
      if (!leaves.has(leaf)) {
        errors.push(`test root ${root} references missing leaf: ${leaf}`);
        continue;
      }
      const leafSource = leafSources.get(leaf);
      if (leafSource === undefined) {
        errors.push(`missing grouped test leaf source: ${leaf}`);
        continue;
      }
      validateGroupedLeafCfg(
        leaf,
        leafSource,
        allowedLeafCfgLines,
        errors,
      );
      const expectedModuleName = posix.basename(leaf, '.rs');
      if (reference.moduleName !== expectedModuleName) {
        errors.push(`test leaf ${leaf} must use module name ${expectedModuleName}`);
      }
      referenceCounts.set(leaf, (referenceCounts.get(leaf) ?? 0) + 1);
    }
  }

  for (const leaf of [...leaves].sort()) {
    const count = referenceCounts.get(leaf) ?? 0;
    if (count !== 1) {
      errors.push(`test leaf ${leaf} must be referenced exactly once; found ${count}`);
    }
  }
  return errors;
}

function collectRustFiles(dir, testsDir, files, sources, ignoredDirectories) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const repoPath = `tests/${relative(testsDir, path).replaceAll('\\', '/')}`;
      if (!ignoredDirectories.has(repoPath)) {
        collectRustFiles(path, testsDir, files, sources, ignoredDirectories);
      }
    } else if (entry.isFile() && entry.name.endsWith('.rs')) {
      const repoPath = `tests/${relative(testsDir, path).replaceAll('\\', '/')}`;
      files.push(repoPath);
      sources.set(repoPath, readFileSync(path, 'utf8'));
    }
  }
}

function checkExplicitIntegrationTestTopology(root, {
  cratePath,
  expectedTargets,
  ignoredDirectories = [],
  allowedLeafCfgLines = new Map(),
}) {
  const crateDir = join(root, ...cratePath.split('/'));
  const testsDir = join(crateDir, 'tests');
  const manifestPath = join(crateDir, 'Cargo.toml');
  const topLevelRustFiles = [];
  const leafRustFiles = [];
  const rootSources = new Map();
  const leafSources = new Map();
  const ignoredDirectorySet = new Set(ignoredDirectories);

  for (const entry of readdirSync(testsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.rs')) {
      const repoPath = `tests/${entry.name}`;
      topLevelRustFiles.push(repoPath);
      rootSources.set(repoPath, readFileSync(join(testsDir, entry.name), 'utf8'));
    } else if (entry.isDirectory()) {
      const repoPath = `tests/${entry.name}`;
      if (!ignoredDirectorySet.has(repoPath)) {
        collectRustFiles(
          join(testsDir, entry.name),
          testsDir,
          leafRustFiles,
          leafSources,
          ignoredDirectorySet,
        );
      }
    }
  }

  return validateExplicitIntegrationTestTopology({
    manifestText: readFileSync(manifestPath, 'utf8'),
    expectedTargets,
    topLevelRustFiles,
    rootSources,
    leafRustFiles,
    leafSources,
    allowedLeafCfgLines,
  }).map((message) => ({ path: manifestPath, line: 1, message }));
}

export function checkAgentRuntimeIntegrationTestTopology(root) {
  return checkExplicitIntegrationTestTopology(root, {
    cratePath: 'src/crates/execution/agent-runtime',
    expectedTargets: agentRuntimeIntegrationTestTargets,
  });
}

export function checkCliIntegrationTestTopology(root) {
  return checkExplicitIntegrationTestTopology(root, {
    cratePath: 'src/apps/cli',
    expectedTargets: cliIntegrationTestTargets,
    ignoredDirectories: ['tests/support'],
  });
}

export function checkServicesCoreIntegrationTestTopology(root) {
  return checkExplicitIntegrationTestTopology(root, {
    cratePath: 'src/crates/services/services-core',
    expectedTargets: servicesCoreIntegrationTestTargets,
  });
}

export function checkServicesIntegrationsIntegrationTestTopology(root) {
  return checkExplicitIntegrationTestTopology(root, {
    cratePath: 'src/crates/services/services-integrations',
    expectedTargets: servicesIntegrationsIntegrationTestTargets,
    allowedLeafCfgLines: new Map([[
      'tests/remote_ssh_contracts/remote_ssh_disabled_contracts.rs',
      '#![cfg(not(feature = "remote-ssh-concrete"))]',
    ]]),
  });
}

export function checkOpencodeAdapterIntegrationTestTopology(root) {
  return checkExplicitIntegrationTestTopology(root, {
    cratePath: 'src/crates/adapters/opencode-adapter',
    expectedTargets: opencodeAdapterIntegrationTestTargets,
    ignoredDirectories: ['tests/fixtures'],
  });
}

export function checkClaudeCodeAdapterIntegrationTestTopology(root) {
  return checkExplicitIntegrationTestTopology(root, {
    cratePath: 'src/crates/adapters/claude-code-adapter',
    expectedTargets: claudeCodeAdapterIntegrationTestTargets,
  });
}

export function checkCodexAdapterIntegrationTestTopology(root) {
  return checkExplicitIntegrationTestTopology(root, {
    cratePath: 'src/crates/adapters/codex-adapter',
    expectedTargets: codexAdapterIntegrationTestTargets,
  });
}

export function checkExternalSourcesIntegrationTestTopology(root) {
  return checkExplicitIntegrationTestTopology(root, {
    cratePath: 'src/crates/assembly/external-sources',
    expectedTargets: externalSourcesIntegrationTestTargets,
  });
}

export function checkExternalSourceIntegrationTestTopologies(root) {
  return [
    ...checkOpencodeAdapterIntegrationTestTopology(root),
    ...checkClaudeCodeAdapterIntegrationTestTopology(root),
    ...checkCodexAdapterIntegrationTestTopology(root),
    ...checkExternalSourcesIntegrationTestTopology(root),
  ];
}

export function checkServiceIntegrationTestTopologies(root) {
  return [
    ...checkServicesCoreIntegrationTestTopology(root),
    ...checkServicesIntegrationsIntegrationTestTopology(root),
  ];
}

export function checkBuildGraphContractIntegrationTestTopologies(root) {
  const topologies = [
    ['src/crates/contracts/core-types', coreTypesIntegrationTestTargets],
    ['src/crates/contracts/runtime-ports', runtimePortsIntegrationTestTargets],
    ['src/crates/contracts/product-domains', productDomainsIntegrationTestTargets],
    ['src/crates/execution/agent-workflows', agentWorkflowsIntegrationTestTargets],
    [
      'src/crates/adapters/ai-adapters',
      aiAdaptersIntegrationTestTargets,
      ['tests/common', 'tests/fixtures'],
    ],
    ['src/crates/assembly/product-capabilities', productCapabilitiesIntegrationTestTargets],
  ];
  return topologies.flatMap(([cratePath, expectedTargets, ignoredDirectories]) => (
    checkExplicitIntegrationTestTopology(root, {
      cratePath,
      expectedTargets,
      ignoredDirectories,
    })
  ));
}

export function checkReviewedIntegrationTestTopologies(root) {
  return [
    ...checkServiceIntegrationTestTopologies(root),
    ...checkBuildGraphContractIntegrationTestTopologies(root),
  ];
}
