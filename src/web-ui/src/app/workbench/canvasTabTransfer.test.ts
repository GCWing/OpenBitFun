// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_TAB_DRAG_TYPE, dropSessionTabOnWorkbench, popOutCanvasTab, writeSessionTabDrag } from './canvasTabTransfer';
import { useContentResourceStore } from './contentResourceStore';
import { useSceneStore } from '../stores/sceneStore';
import { clearAgentCanvasForPeerSwitch, switchAgentCanvasScope, useAgentCanvasStore } from '../components/panels/content-canvas/stores';
import { openCanvasContent, openWorkbenchContent } from '@/shared/services/workbenchContentService';
import { getEditorDocument, releaseEditorDocument } from '@/tools/editor/services/EditorDocument';
import { activateSurface } from '@/infrastructure/peer-device/deviceSurface';
import { canvasTabDocumentId } from '../components/panels/content-canvas/types';
import { writeSceneTabDrag, dropSceneTab } from './sceneTabTransfer';
import type { PanelContent } from '@/shared/types/panelContent';

const scope = { surfaceId: 'local', workspacePath: '/project', remoteConnectionId: 'ssh-project' };
const file: PanelContent = { type: 'code-editor', title: 'a.ts', data: { filePath: '/project/a.ts' } };

function dragData(): DataTransfer {
  const data = new Map<string, string>();
  return { get types() { return [...data.keys()]; },
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) ?? '',
  } as DataTransfer;
}

function startDrag(content = file) {
  openCanvasContent('agent', content, { scope });
  const canvas = useAgentCanvasStore.getState();
  const tab = canvas.primaryGroup.tabs[0];
  const transfer = dragData();
  writeSessionTabDrag(transfer, tab.id, 'primary');
  canvas.startDrag(tab.id, 'primary');
  return { tab, transfer, documentId: `canvas:${tab.id}` };
}

describe('canvas-to-workbench view transfer', () => {
  beforeEach(() => {
    activateSurface('local');
    clearAgentCanvasForPeerSwitch();
    useContentResourceStore.setState({ resources: {} });
    useSceneStore.getState().resetForPeerSwitch();
  });
  afterEach(() => {
    for (const tab of useAgentCanvasStore.getState().getAllTabs()) releaseEditorDocument(canvasTabDocumentId(tab));
    for (const resource of Object.values(useContentResourceStore.getState().resources)) releaseEditorDocument(resource.documentId);
    clearAgentCanvasForPeerSwitch();
    useContentResourceStore.setState({ resources: {} });
    activateSurface('local');
  });

  it('moves a dirty file at the drop position with the same document and captured origin', () => {
    useSceneStore.getState().openScene('git');
    useSceneStore.getState().openScene('terminal');
    const { tab, transfer, documentId } = startDrag();
    const document = getEditorDocument(documentId, scope, '/project/a.ts');
    document.capture('unsaved edit', true, 'saved');
    useAgentCanvasStore.getState().setTabDirty(tab.id, 'primary', true);
    useAgentCanvasStore.getState().setTabFileDeletedFromDisk(tab.id, 'primary', true);
    const id = dropSessionTabOnWorkbench(transfer, { tabId: 'terminal', placement: 'before' });
    expect(id).not.toBeNull();
    expect(useSceneStore.getState().openTabs.map(tab => tab.id)).toEqual(['git', `content:${id}`, 'terminal']);
    expect(useSceneStore.getState().activeTabId).toBe(`content:${id}`);
    expect(useContentResourceStore.getState().resources[id!]).toMatchObject({ documentId, scope, isDirty: true, fileMissing: true });
    expect(getEditorDocument(documentId, scope)).toBe(document);
    expect(document.snapshot).toEqual({ content: 'unsaved edit', isDirty: true, savedContent: 'saved' });
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
    expect(useAgentCanvasStore.getState().closedTabs).toHaveLength(0);
    expect(useAgentCanvasStore.getState().draggingTabId).toBeNull();
  });

  it('transfers a terminal view without replacing its runtime identity or recording a close', () => {
    const { transfer } = startDrag({ type: 'terminal', title: 'Build', data: { sessionId: 'pty-existing' },
      metadata: { terminalCloseBehavior: 'detach' } });
    const id = dropSessionTabOnWorkbench(transfer)!;
    expect(useContentResourceStore.getState().resources[id]).toMatchObject({ target: { kind: 'terminal', sessionId: 'pty-existing' },
      content: { metadata: { terminalCloseBehavior: 'detach' } } });
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
    expect(useAgentCanvasStore.getState().closedTabs).toHaveLength(0);
  });

  it('retains pinned status when popping out through the shared menu action', () => {
    const { tab } = startDrag();
    useAgentCanvasStore.getState().togglePinTab(tab.id, 'primary');
    const id = popOutCanvasTab('agent', tab.id, 'primary');
    expect(useSceneStore.getState().openTabs.find(tab => tab.contentId === id)?.pinned).toBe(true);
  });

  it('preserves the destination draft when reusing an already open main file', () => {
    const id = openWorkbenchContent(file, { scope });
    useContentResourceStore.getState().update(id, { isDirty: true });
    const { transfer } = startDrag();
    expect(dropSessionTabOnWorkbench(transfer)).toBe(id);
    expect(useContentResourceStore.getState().resources[id].isDirty).toBe(true);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs).toHaveLength(0);
    expect(Object.values(useContentResourceStore.getState().resources)).toHaveLength(1);
  });

  it('retains an independently edited source instead of discarding a conflicting draft', () => {
    openWorkbenchContent(file, { scope });
    const { tab, transfer } = startDrag();
    useAgentCanvasStore.getState().setTabDirty(tab.id, 'primary', true);
    dropSessionTabOnWorkbench(transfer);
    expect(useAgentCanvasStore.getState().primaryGroup.tabs[0]).toMatchObject({ id: tab.id, isDirty: true });
  });

  it('leaves the source in place when a drag is canceled', () => {
    const { tab, transfer } = startDrag();
    useAgentCanvasStore.getState().endDrag();
    expect(dropSessionTabOnWorkbench(transfer)).toBeNull();
    expect(useAgentCanvasStore.getState().primaryGroup.tabs[0].id).toBe(tab.id);
    expect(useSceneStore.getState().openTabs).toHaveLength(0);
  });

  it.each(['missing-source', 'different-device-epoch', 'foreign-payload', 'malformed-payload'])('rejects a stale or unrelated drag: %s', reason => {
    const { tab, transfer } = startDrag();
    if (reason === 'missing-source') useAgentCanvasStore.getState().detachTab(tab.id, 'primary');
    if (reason === 'different-device-epoch') { activateSurface('peer'); activateSurface('local'); }
    if (reason === 'foreign-payload') transfer.setData(SESSION_TAB_DRAG_TYPE, JSON.stringify({ tabId: 'unrelated' }));
    if (reason === 'malformed-payload') transfer.setData(SESSION_TAB_DRAG_TYPE, '{');
    expect(dropSessionTabOnWorkbench(transfer)).toBeNull();
    expect(useSceneStore.getState().openTabs).toHaveLength(0);
    expect(useAgentCanvasStore.getState().draggingTabId).toBeNull();
  });
  it('moves a dirty pinned file both ways without changing its resource, document or origin', async () => {
    const resourceId = openWorkbenchContent(file, { scope });
    const document = getEditorDocument(resourceId, scope, '/project/a.ts');
    document.capture('draft', true, 'saved');
    useContentResourceStore.getState().update(resourceId, { isDirty: true, fileMissing: true });
    useSceneStore.getState().togglePinScene(`content:${resourceId}`);
    const resource = useContentResourceStore.getState().resources[resourceId];
    for (const pane of ['secondary', 'primary'] as const) {
      const transfer = dragData();
      writeSceneTabDrag(transfer, `content:${resourceId}`);
      expect(await dropSceneTab(transfer, pane)).toBe(true);
      expect(useContentResourceStore.getState().resources[resourceId]).toBe(resource);
      expect(resource).toMatchObject({ isDirty: true, fileMissing: true, scope });
      expect(useSceneStore.getState().openTabs[0]).toMatchObject({ pane, pinned: true });
      expect(getEditorDocument(resourceId, scope)).toBe(document);
      expect(document.snapshot?.content).toBe('draft');
    }
  });

  it('moves a terminal without entering the canvas close/restore lifecycle', async () => {
    const id = openWorkbenchContent({ type: 'terminal', title: 'Build', data: { sessionId: 'pty-existing' } }, { scope });
    const resource = useContentResourceStore.getState().resources[id];
    const transfer = dragData();
    writeSceneTabDrag(transfer, `content:${id}`);
    expect(await dropSceneTab(transfer, 'secondary')).toBe(true);
    expect(useContentResourceStore.getState().resources[id]).toBe(resource);
    expect(useAgentCanvasStore.getState().closedTabs).toHaveLength(0);
  });

  it('keeps legacy canvas document IDs readable', () => {
    expect(canvasTabDocumentId({ id: 'legacy-tab' })).toBe('canvas:legacy-tab');
  });
});
