// @vitest-environment jsdom
import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { useFlowChatViewportOwner, type FlowChatViewportOwnerApi } from './useFlowChatViewportOwner';
import { readFlowChatScrollTop } from './flowChatScrollCoordinates';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('viewport reader travel', () => {
  it('keeps history extent growth out of reader demand and converts existing navigation offsets', async () => {
    const host = document.createElement('div');
    const scroller = document.createElement('div');
    scroller.dataset.flowchatScrollOrigin = 'end';
    let height = 1600;
    Object.defineProperties(scroller, {
      clientHeight: { get: () => 600 },
      scrollHeight: { get: () => height },
    });
    const root = createRoot(host);
    let owner!: FlowChatViewportOwnerApi;
    function Harness() {
      owner = useFlowChatViewportOwner(useRef(scroller));
      return null;
    }
    try {
      await act(async () => root.render(<Harness />));
      expect(readFlowChatScrollTop(scroller)).toBe(1000);
      height += 3000; // Older content extends above the bottom origin.
      expect(owner.readReaderScrollPosition()).toBe(0);
      expect(readFlowChatScrollTop(scroller)).toBe(4000);
      owner.write({ owner: 'one-shot-navigation', topPx: 1000 });
      expect(scroller.scrollTop).toBe(-3000);
      expect(readFlowChatScrollTop(scroller)).toBe(1000);
      expect(owner.readReaderScrollPosition()).toBe(0);
      scroller.scrollTop -= 80;
      expect(owner.readReaderScrollPosition()).toBe(-80);
      height += 1000;
      expect(owner.readReaderScrollPosition()).toBe(-80);
    } finally {
      await act(async () => root.unmount());
    }
  });

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
