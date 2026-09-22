// @vitest-environment jsdom
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { useFlowChatViewportOwner, type FlowChatViewportOwnerApi } from './useFlowChatViewportOwner';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('viewport reader travel', () => {
  it('removes registered writes and shifts but keeps intervening reader travel', async () => {
    const host = document.createElement('div');
    const scroller = document.createElement('div');
    const root = createRoot(host);
    let owner!: FlowChatViewportOwnerApi;
    function Harness() {
      owner = useFlowChatViewportOwner(useRef(scroller));
      return null;
    }
    try {
      await act(async () => root.render(<Harness />));
      expect(owner.readReaderScrollPosition()).toBe(0);
      owner.write({ owner: 'layout-correction', topPx: 100 });
      expect(owner.readReaderScrollPosition()).toBe(0);
      owner.claim('user-gesture');
      scroller.scrollTop = 60;
      expect(owner.readReaderScrollPosition()).toBe(-40);
      owner.shift(200);
      expect(owner.readReaderScrollPosition()).toBe(-40);
      scroller.scrollTop -= 30;
      expect(owner.readReaderScrollPosition()).toBe(-70);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('accounts for actual clamped travel and does not count refused writes', async () => {
    const host = document.createElement('div');
    const scroller = document.createElement('div');
    let top = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => top, set: (next: number) => { top = Math.max(0, Math.min(100, next)); },
    });
    const root = createRoot(host);
    let owner!: FlowChatViewportOwnerApi;
    function Harness() {
      owner = useFlowChatViewportOwner(useRef(scroller));
      return null;
    }
    try {
      await act(async () => root.render(<Harness />));
      owner.shift(300);
      expect(top).toBe(100);
      expect(owner.readReaderScrollPosition()).toBe(0);
      owner.claim('user-gesture', { holdForMs: 1000 });
      expect(owner.write({ owner: 'follow-output', topPx: 0 })).toBe(false);
      expect(owner.readReaderScrollPosition()).toBe(0);
      scroller.scrollTop = 80;
      expect(owner.readReaderScrollPosition()).toBe(-20);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
