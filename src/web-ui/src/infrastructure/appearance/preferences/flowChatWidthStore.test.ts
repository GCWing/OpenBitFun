import { describe, expect, it, vi } from 'vitest';
import { createFlowChatWidthStore, DEFAULT_FLOW_CHAT_WIDTH, FLOW_CHAT_WIDTH_STORAGE_KEY, MIN_FLOW_CHAT_WIDTH } from './flowChatWidthStore';

function storage(value: string | null = null) {
  let saved = value;
  return { getItem: () => saved, setItem: vi.fn((_key: string, next: string) => { saved = next; }) };
}

describe('FlowChat appearance width preference', () => {
  it('keeps the previous 900px default for existing installs and uses two thirds as the minimum', () => {
    expect(DEFAULT_FLOW_CHAT_WIDTH).toBe(900);
    expect(MIN_FLOW_CHAT_WIDTH).toBe(600);
    const persisted = storage();
    expect(createFlowChatWidthStore(persisted).getState().preferredWidth).toBe(900);
    expect(persisted.setItem).not.toHaveBeenCalled();
  });

  it('round-trips the preference independently of the current pane size', () => {
    const persisted = storage();
    const store = createFlowChatWidthStore(persisted);
    store.getState().setPreferredWidth(1632.4);
    expect(persisted.setItem).toHaveBeenLastCalledWith(FLOW_CHAT_WIDTH_STORAGE_KEY, '1632');
    expect(createFlowChatWidthStore(persisted).getState().preferredWidth).toBe(1632);
    store.getState().setPreferredWidth(100);
    expect(createFlowChatWidthStore(persisted).getState().preferredWidth).toBe(600);
    store.getState().setPreferredWidth(Number.NaN);
    store.getState().setPreferredWidth(Number.POSITIVE_INFINITY);
    expect(store.getState().preferredWidth).toBe(600);
  });

  it.each(['', 'broken', 'null', 'Infinity', '-1', '599'])('retains an unreadable/legacy record %j without rewriting it', value => {
    const persisted = storage(value);
    expect(createFlowChatWidthStore(persisted).getState().preferredWidth).toBe(900);
    expect(persisted.setItem).not.toHaveBeenCalled();
  });

  it('remains usable when reading or writing storage fails', () => {
    const store = createFlowChatWidthStore({ getItem: () => { throw Error('unavailable'); }, setItem: () => { throw Error('unavailable'); } });
    store.getState().setPreferredWidth(1200);
    expect(store.getState().preferredWidth).toBe(1200);
  });
});
