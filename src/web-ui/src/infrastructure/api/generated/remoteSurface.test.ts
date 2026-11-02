import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PEER_CONTROLLER_LOCAL_COMMANDS,
  PEER_HOST_ADVERTISED_CAPABILITIES,
  PEER_HOST_CAPABILITY_IDS,
  REMOTE_SURFACE_REGISTRY_DIGEST,
  RETIRED_COMMAND_PREFIXES,
} from './remoteSurface';

interface RegistryOperation {
  id: string;
  surface: 'tauri_command' | 'host_invoke_only';
  remoteWorkspace: string;
  peer: { kind: string; reason?: string };
  cliPeer: { kind: string; reason?: string };
}

interface RegistryExport {
  schemaVersion: number;
  digest: string;
  retiredCommandPrefixes: Array<{ prefix: string; reason: string }>;
  capabilities: { ids: string[]; desktop: string[]; cli: string[] };
  operations: RegistryOperation[];
}

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../../crates/contracts/product-domains/src/generated/remote-surface-registry.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as RegistryExport;

// The generated TypeScript and the committed registry JSON come from one
// `cargo run --bin export_remote_surface_registry`; `pnpm run capabilities:check`
// regenerates both. These assertions make a half-updated pair fail here, in the
// Web UI suite, instead of at the first peer round trip.
describe('remote surface generated bindings', () => {
  it('carries the registry digest', () => {
    expect(REMOTE_SURFACE_REGISTRY_DIGEST).toBe(registry.digest);
    expect(registry.schemaVersion).toBe(1);
  });

  it('derives the controller-local set from controller_local and host_control_plane rows', () => {
    const derived = new Set(
      registry.operations
        .filter(operation => operation.surface === 'tauri_command')
        .filter(operation => ['controller_local', 'host_control_plane'].includes(operation.peer.kind))
        .map(operation => operation.id),
    );
    expect(PEER_CONTROLLER_LOCAL_COMMANDS).toEqual(derived);
    expect(PEER_CONTROLLER_LOCAL_COMMANDS.size).toBeGreaterThan(100);
  });

  it('keeps operator-only commands forwarded so the peer refusal is explicit', () => {
    const trust = registry.operations.find(operation => operation.id === 'git_trust_repository');
    expect(trust?.peer.kind).toBe('operator_only');
    expect(PEER_CONTROLLER_LOCAL_COMMANDS.has('git_trust_repository')).toBe(false);
    expect(PEER_CONTROLLER_LOCAL_COMMANDS.has('git_get_repository_trust')).toBe(false);
  });

  it('keeps controller-owned anchors local on every surface', () => {
    for (const command of [
      'account_login',
      'account_github_start',
      'account_github_poll',
      'account_github_info',
      'account_logout',
      'peer_mode_ping',
      'dispatch_submit',
      'mark_openbitfun_control_surface_ready',
      'show_main_window',
      'download_update',
      'get_pending_update',
      'install_pending_update',
    ]) {
      expect(PEER_CONTROLLER_LOCAL_COMMANDS.has(command), command).toBe(true);
    }
    for (const command of ['start_dialog_turn', 'product_control_invoke', 'restore_session_view']) {
      expect(PEER_CONTROLLER_LOCAL_COMMANDS.has(command), command).toBe(false);
    }
  });

  it('never lists HostInvoke-only names in the frontend local set', () => {
    for (const operation of registry.operations) {
      if (operation.surface === 'host_invoke_only') {
        expect(PEER_CONTROLLER_LOCAL_COMMANDS.has(operation.id), operation.id).toBe(false);
      }
    }
  });

  it('exposes the capability lists each host kind advertises', () => {
    expect([...PEER_HOST_CAPABILITY_IDS]).toEqual(registry.capabilities.ids);
    expect([...PEER_HOST_ADVERTISED_CAPABILITIES.desktop]).toEqual(registry.capabilities.desktop);
    expect([...PEER_HOST_ADVERTISED_CAPABILITIES.cli]).toEqual(registry.capabilities.cli);
    for (const capability of PEER_HOST_ADVERTISED_CAPABILITIES.cli) {
      // A delivery path, not a feature: Desktop fans out `terminal_event` instead.
      if (capability === 'terminal_cursor_replay_v1') continue;
      expect(PEER_HOST_ADVERTISED_CAPABILITIES.desktop, capability).toContain(capability);
    }
    expect(PEER_HOST_ADVERTISED_CAPABILITIES.desktop).not.toContain('terminal_cursor_replay_v1');
    expect(PEER_HOST_ADVERTISED_CAPABILITIES.cli).not.toContain('miniapp_agent_context_files_v1');
    expect(PEER_HOST_ADVERTISED_CAPABILITIES.desktop).toContain('cancel_tool');
    expect(PEER_HOST_ADVERTISED_CAPABILITIES.cli).toContain('cancel_tool');
  });

  it('exposes the retired command prefixes', () => {
    expect([...RETIRED_COMMAND_PREFIXES]).toEqual(
      registry.retiredCommandPrefixes.map(({ prefix }) => prefix),
    );
    expect(RETIRED_COMMAND_PREFIXES).toContain('lsp_');
  });
});
