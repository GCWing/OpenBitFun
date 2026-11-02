import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function read(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

const shellEntries = read('../scenes/shell/hooks/useShellEntries.ts');
const terminalSessions = read('../scenes/shell/hooks/useTerminalSessions.ts');
const actionBridge = read('../scenes/terminal/TerminalActionBridge.tsx');
const workspaceItem = read('../components/NavPanel/sections/workspaces/WorkspaceItem.tsx');

describe('terminal cwd wiring', () => {
  it('prefers the session directory over the workspace root', () => {
    expect(shellEntries).toContain('const sessionDirectory = useSessionTerminalDirectory(workspaceId);');
    expect(shellEntries).toContain('defaultDirectory: sessionDirectory,');
    expect(terminalSessions).toContain('workspacePath: directory ?? defaultDirectory ?? workspacePath');
  });

  it('lets an explicit directory win and otherwise follows the session', () => {
    expect(actionBridge).toContain('const workingDirectory = requestedDirectory');
    expect(actionBridge).toContain('?? activeSessionTerminalDirectory(target?.id)');
    expect(actionBridge).toContain('workspacePath: workingDirectory,');
  });

  it('never hard-codes the project root as the terminal cwd', () => {
    // The resolver, not the row, decides the cwd for this workspace scope.
    expect(workspaceItem).toContain("window.dispatchEvent(new CustomEvent('terminal-create-requested'");
    expect(workspaceItem).not.toContain('workingDirectory: workspace.rootPath');
  });
});
