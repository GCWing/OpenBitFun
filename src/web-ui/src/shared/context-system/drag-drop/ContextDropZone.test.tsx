/** @vitest-environment jsdom */
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ payload: null as unknown, addContext: vi.fn(), updateValidation: vi.fn() }));
vi.mock('../../services/DragManager', () => ({ dragManager: {
  registerTarget: () => () => {}, getCurrentPayload: () => mocks.payload,
  handleDragEnter: vi.fn(), handleDragLeave: vi.fn(), handleDragOver: vi.fn(),
  handleDrop: (target: { canAccept: (p: unknown) => boolean; onDrop: (p: unknown) => void }) => {
    if (target.canAccept(mocks.payload)) target.onDrop(mocks.payload);
  },
} }));
vi.mock('../../services/ContextRegistry', () => ({ contextRegistry: { getAllTypes: () => ['file'] } }));
vi.mock('../../stores/contextStore', () => ({ useContextStore: (selector: (state: typeof mocks) => unknown) => selector(mocks) }));
import { ContextDropZone } from './ContextDropZone';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement('div');
document.body.appendChild(container);
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); mocks.payload = null; vi.clearAllMocks(); });
function mount(onFiles = vi.fn(), disabled = false, onContextAdded = vi.fn(), onDragStateChange = vi.fn()) {
  function Pane() {
    const ref = useRef<HTMLDivElement>(null);
    return <><div ref={ref}>
      <div data-testid="transcript">History</div>
      <ContextDropZone extendedTargetRef={ref} disabled={disabled} onDragStateChange={onDragStateChange} onExternalFilesDrop={onFiles} onContextAdded={onContextAdded}>
        <div data-testid="composer">Input</div>
      </ContextDropZone>
    </div><div data-testid="other-pane">Editor</div></>;
  }
  root = createRoot(container);
  act(() => root.render(<Pane />));
  return onFiles;
}
function drag(target: string, type: string, types: string[], files: File[] = []) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types, files, dropEffect: 'none' } });
  act(() => { container.querySelector(`[data-testid="${target}"]`)!.dispatchEvent(event); });
  return event;
}
describe('conversation area drops', () => {
  it('handles transcript files, adds composer drops once, and excludes other panes', () => {
    const onFiles = mount(); const file = new File(['hello'], 'notes.txt');
    expect(drag('transcript', 'dragover', ['Files']).defaultPrevented).toBe(true);
    drag('transcript', 'drop', ['Files'], [file]);
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([file]);
    drag('composer', 'drop', ['Files'], [file]);
    expect(onFiles).toHaveBeenCalledTimes(2);
    drag('other-pane', 'drop', ['Files'], [file]);
    expect(onFiles).toHaveBeenCalledTimes(2);
  });
  it('routes internal workspace files through context insertion', () => {
    const onAdded = vi.fn(); mount(vi.fn(), false, onAdded);
    const context = { id: 'file-1', type: 'file', path: '/project/notes.txt' };
    mocks.payload = { dataType: 'file', data: context };
    drag('transcript', 'dragenter', ['application/openbitfun-context']);
    drag('transcript', 'drop', ['application/openbitfun-context']);
    expect(mocks.addContext).toHaveBeenCalledExactlyOnceWith(context);
    expect(onAdded).toHaveBeenCalledExactlyOnceWith(context);
  });
  it('shows accepted drag feedback and clears it on leave, drop and cancellation', () => {
    const onDragStateChange = vi.fn();
    mount(vi.fn(), false, vi.fn(), onDragStateChange);
    drag('transcript', 'dragenter', ['Files']);
    expect(onDragStateChange).toHaveBeenLastCalledWith(true);
    drag('transcript', 'dragleave', ['Files']);
    expect(onDragStateChange).toHaveBeenLastCalledWith(false);
    drag('transcript', 'dragenter', ['Files']);
    drag('transcript', 'drop', ['Files']);
    expect(onDragStateChange).toHaveBeenLastCalledWith(false);
    drag('transcript', 'dragenter', ['Files']);
    act(() => window.dispatchEvent(new Event('dragend')));
    expect(onDragStateChange).toHaveBeenLastCalledWith(false);
    drag('transcript', 'dragenter', ['Files']);
    act(() => window.dispatchEvent(new Event('blur')));
    expect(onDragStateChange).toHaveBeenLastCalledWith(false);
  });
  it('blocks disabled drops without consuming ordinary text drags', () => {
    const onFiles = mount(vi.fn(), true);
    drag('transcript', 'drop', ['Files'], [new File(['x'], 'x.txt')]);
    expect(onFiles).not.toHaveBeenCalled();
    expect(drag('transcript', 'dragover', ['text/plain']).defaultPrevented).toBe(false);
    expect(drag('transcript', 'drop', ['text/plain']).defaultPrevented).toBe(false);
  });
  it('does not claim empty-typed OS file drags (WebKitGTK) so the native pane drop path owns them', () => {
    // On WebKitGTK an OS file drag reports NO dataTransfer types. Claiming it
    // (preventDefault) would make WebKit swallow the drop at the DOM level and
    // stop forwarding it to the native window drag handler. The zone must stay
    // unclaimed so the pane-level native drop path can receive the file.
    function LinuxPane() {
      const ref = useRef<HTMLDivElement>(null);
      return <div ref={ref}>
        <ContextDropZone extendedTargetRef={ref}>
          <div data-testid="composer">Input</div>
        </ContextDropZone>
      </div>;
    }
    root = createRoot(container);
    act(() => root.render(<LinuxPane />));
    expect(drag('composer', 'dragenter', []).defaultPrevented).toBe(false);
    expect(drag('composer', 'dragover', []).defaultPrevented).toBe(false);
    expect(drag('composer', 'drop', []).defaultPrevented).toBe(false);
  });
});
