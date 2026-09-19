import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface FooterSurfaceContract {
  source: string;
  marker: string;
  stylesheet?: string;
  selector?: string;
}

const footerSurfaces: FooterSurfaceContract[] = [
  {
    source: '../../infrastructure/update/AppUpdatePanel.tsx',
    marker: 'className="openbitfun-update-details__footer"',
  },
  {
    source: '../../app/components/RemoteConnectDialog/RemoteConnectDisclaimer.tsx',
    marker: 'className="openbitfun-remote-disclaimer__actions"',
    stylesheet: '../../app/components/RemoteConnectDialog/RemoteConnectDisclaimer.scss',
    selector: '.openbitfun-remote-disclaimer__actions',
  },
  {
    source: '../../app/components/MCPInteractionDialog/MCPInteractionDialog.tsx',
    marker: 'className="mcp-interaction-dialog__actions"',
    stylesheet: '../../app/components/MCPInteractionDialog/MCPInteractionDialog.scss',
    selector: '.mcp-interaction-dialog__actions',
  },
  {
    source: '../../app/components/panels/TerminalEditModal.tsx',
    marker: 'className="terminal-edit-dialog__footer"',
    stylesheet: '../../app/components/panels/TerminalEditModal.scss',
    selector: '.terminal-edit-dialog__footer',
  },
  {
    source: '../../app/components/NavPanel/sections/workspaces/WorkspaceProjectPermissionsDialog.tsx',
    marker: 'className="workspace-project-permissions-dialog__footer"',
    stylesheet: '../../app/components/NavPanel/sections/workspaces/WorkspaceProjectPermissionsDialog.scss',
    selector: '&__footer',
  },
  {
    source: '../../infrastructure/config/components/QuickActionsConfig.tsx',
    marker: 'className="quick-actions-config__modal-footer"',
    stylesheet: '../../infrastructure/config/components/QuickActionsConfig.scss',
    selector: '&__modal-footer',
  },
  {
    source: '../../app/scenes/skills/SkillsScene.tsx',
    marker: 'className="openbitfun-skills-scene__modal-form-actions"',
    stylesheet: '../../app/scenes/skills/SkillsScene.scss',
    selector: '&__modal-form-actions',
  },
  {
    source: '../../app/scenes/miniapps/components/MiniAppDetailModal.tsx',
    marker: 'className="miniapp-detail-modal__footer"',
    stylesheet: '../../app/scenes/miniapps/components/MiniAppDetailModal.scss',
    selector: '&__footer',
  },
  {
    source: '../../features/ssh-remote/SSHConnectionDialog.tsx',
    marker: 'className="ssh-connection-dialog__actions"',
    stylesheet: '../../features/ssh-remote/SSHConnectionDialog.scss',
    selector: '&__actions',
  },
  {
    source: '../../infrastructure/config/components/RuntimeSettingsPages.tsx',
    marker: 'className="openbitfun-debug-config__modal-footer"',
  },
  {
    source: '../../infrastructure/config/components/HooksConfig.tsx',
    marker: '<DialogFooter separator>',
  },
  {
    source: '../../app/components/GalleryLayout/GalleryDetailModal.tsx',
    marker: 'className="gallery-detail-modal__actions"',
    stylesheet: '../../app/components/GalleryLayout/GalleryDetailModal.scss',
    selector: '&__actions',
  },
  {
    source: '../../app/components/NavPanel/sections/workspaces/WorkspaceRelatedPathsDialog.tsx',
    marker: 'className="workspace-related-paths-dialog__footer"',
    stylesheet: '../../app/components/NavPanel/sections/workspaces/WorkspaceRelatedPathsDialog.scss',
    selector: '&__footer',
  },
  {
    source: '../../features/ssh-remote/SSHAuthPromptDialog.tsx',
    marker: 'className="ssh-auth-prompt-dialog__actions"',
    stylesheet: '../../features/ssh-remote/SSHAuthPromptDialog.scss',
    selector: '&__actions',
  },
];

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function ruleBlock(stylesheet: string, selector: string): string {
  const selectorIndex = stylesheet.indexOf(selector);
  expect(selectorIndex, `missing ${selector}`).toBeGreaterThanOrEqual(0);
  const blockStart = stylesheet.indexOf('{', selectorIndex);
  let depth = 0;
  for (let index = blockStart; index < stylesheet.length; index += 1) {
    if (stylesheet[index] === '{') depth += 1;
    if (stylesheet[index] === '}') depth -= 1;
    if (depth === 0) return stylesheet.slice(blockStart + 1, index);
  }
  throw new Error(`unterminated rule for ${selector}`);
}

describe('Dialog footer composition contract', () => {
  it.each(footerSurfaces)('$source keeps terminal actions outside DialogBody', ({ source, marker }) => {
    const component = read(source);
    const markerIndex = component.indexOf(marker);
    const footerIndex = component.lastIndexOf('<DialogFooter', markerIndex);
    const bodyOpenIndex = component.lastIndexOf('<DialogBody', footerIndex);
    const bodyCloseIndex = component.lastIndexOf('</DialogBody>', footerIndex);

    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(footerIndex).toBeGreaterThanOrEqual(0);
    expect(bodyCloseIndex).toBeGreaterThan(bodyOpenIndex);
  });

  it.each(footerSurfaces.filter((surface) => surface.stylesheet))(
    '$stylesheet leaves footer edge spacing to design tokens',
    ({ stylesheet, selector }) => {
      const block = ruleBlock(read(stylesheet!), selector!);
      expect(block).not.toMatch(/\b(?:padding|margin|border(?:-(?:top|bottom|block(?:-start|-end)?))?)\s*:/);
    },
  );

  it('restores the standard inset when a dialog has no local edge-spacing owner', () => {
    const workspaceManager = read('../../tools/workspace/components/WorkspaceManager.tsx');
    expect(workspaceManager).toContain('<DialogBody>');
    expect(workspaceManager).not.toContain('<DialogBody inset="none">');
  });
});
