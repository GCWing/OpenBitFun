// Physical crate layout rules. Package names remain stable; this file only
// owns where workspace crates live under src/crates.

export const crateLayoutRules = [
  { crateName: 'config-contracts', layer: 'contracts', path: 'src/crates/contracts/config-contracts' },
  { crateName: 'core-types', layer: 'contracts', path: 'src/crates/contracts/core-types' },
  { crateName: 'events', layer: 'contracts', path: 'src/crates/contracts/events' },
  { crateName: 'product-domains', layer: 'contracts', path: 'src/crates/contracts/product-domains' },
  { crateName: 'runtime-ports', layer: 'contracts', path: 'src/crates/contracts/runtime-ports' },

  { crateName: 'agent-runtime', layer: 'execution', path: 'src/crates/execution/agent-runtime' },
  { crateName: 'agent-workflows', layer: 'execution', path: 'src/crates/execution/agent-workflows' },
  { crateName: 'agent-stream', layer: 'execution', path: 'src/crates/execution/agent-stream' },
  { crateName: 'agent-tools', layer: 'execution', path: 'src/crates/execution/tool-contracts' },
  { crateName: 'plugin-runtime-client', layer: 'execution', path: 'src/crates/execution/plugin-runtime-client' },
  { crateName: 'runtime-services', layer: 'execution', path: 'src/crates/execution/runtime-services' },
  { crateName: 'tool-packs', layer: 'execution', path: 'src/crates/execution/tool-provider-groups' },
  { crateName: 'tool-runtime', layer: 'execution', path: 'src/crates/execution/tool-execution' },

  { crateName: 'agent-content', layer: 'assembly', path: 'src/crates/assembly/agent-content' },
  { crateName: 'product-capabilities', layer: 'assembly', path: 'src/crates/assembly/product-capabilities' },
  { crateName: 'external-sources', layer: 'assembly', path: 'src/crates/assembly/external-sources' },

  { crateName: 'services-core', layer: 'services', path: 'src/crates/services/services-core' },
  { crateName: 'services-integrations', layer: 'services', path: 'src/crates/services/services-integrations' },
  { crateName: 'legacy-migration-adapters', layer: 'services', path: 'src/crates/services/legacy-migration-adapters' },
  { crateName: 'legacy-migration', layer: 'services', path: 'src/crates/services/legacy-migration' },
  { crateName: 'miniapp-market-service', layer: 'services', path: 'src/crates/services/miniapp-market-service' },
  { crateName: 'skin-market-service', layer: 'services', path: 'src/crates/services/skin-market-service' },
  { crateName: 'relay-service', layer: 'services', path: 'src/crates/services/relay-service' },
  { crateName: 'page-function-runtime', layer: 'services', path: 'src/crates/services/page-function-runtime' },
  { crateName: 'terminal', layer: 'services', path: 'src/crates/services/terminal' },

  { crateName: 'acp', layer: 'interfaces', path: 'src/crates/interfaces/acp' },
  { crateName: 'app-server', layer: 'interfaces', path: 'src/crates/interfaces/app-server' },
  { crateName: 'app-server-client', layer: 'interfaces', path: 'src/crates/interfaces/app-server-client' },
  { crateName: 'app-server-protocol', layer: 'interfaces', path: 'src/crates/interfaces/app-server-protocol' },
  { crateName: 'sdk-host', layer: 'interfaces', path: 'src/crates/interfaces/sdk-host' },
  { crateName: 'agent-runtime-ipc', layer: 'adapters', path: 'src/crates/adapters/agent-runtime-ipc' },
  { crateName: 'ai-adapters', layer: 'adapters', path: 'src/crates/adapters/ai-adapters' },
  { crateName: 'claude-code-adapter', layer: 'adapters', path: 'src/crates/adapters/claude-code-adapter' },
  { crateName: 'codex-adapter', layer: 'adapters', path: 'src/crates/adapters/codex-adapter' },
  { crateName: 'opencode-adapter', layer: 'adapters', path: 'src/crates/adapters/opencode-adapter' },
  { crateName: 'dsh-adapter', layer: 'adapters', path: 'src/crates/adapters/dsh-adapter' },
  { crateName: 'pi-adapter', layer: 'adapters', path: 'src/crates/adapters/pi-adapter' },
  { crateName: 'opencode-plugin-host', layer: 'adapters', path: 'src/crates/adapters/opencode-plugin-host' },
  { crateName: 'static-hook-support', layer: 'adapters', path: 'src/crates/adapters/static-hook-support' },
  { crateName: 'transport', layer: 'adapters', path: 'src/crates/adapters/transport' },
  { crateName: 'webdriver', layer: 'adapters', path: 'src/crates/adapters/webdriver' },

  { crateName: 'core', layer: 'assembly', path: 'src/crates/assembly/core' },
];

export const crateLayoutLayerNames = [
  'interfaces',
  'assembly',
  'adapters',
  'services',
  'execution',
  'contracts',
];

const crateLayoutByName = new Map(crateLayoutRules.map((rule) => [rule.crateName, rule]));

export function crateLayoutRuleForName(crateName) {
  return crateLayoutByName.get(crateName);
}

export function cratePathForName(crateName) {
  return crateLayoutRuleForName(crateName)?.path;
}
