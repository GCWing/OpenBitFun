// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { FlowChatScrollIntent, FlowChatTouchIntent, flowChatKeyScrollDirection, isFlowChatScrollbarPress } from './flowChatScrollIntent';

describe('desktop scroll intent, independent of passive layout and device noise', () => {
  it.each([
    {}, { deltaX: 40 }, { deltaX: 40, deltaY: -2 }, { deltaY: 100, ctrlKey: true },
    { deltaY: 100, shiftKey: true },
  ])('ignores non-vertical or non-scroll wheel input %j', init => {
    expect(new FlowChatScrollIntent().wheel(new WheelEvent('wheel', init), 800)).toBeUndefined();
  });
  it('ignores a consumed wheel event', () => {
    const event = new WheelEvent('wheel', { deltaY: -100, cancelable: true }); event.preventDefault();
    expect(new FlowChatScrollIntent().wheel(event, 800)).toBeUndefined();
  });
  it.each([0, 1, 2])('normalizes pixel, line and page wheel modes (%i)', deltaMode => {
    const tracker = new FlowChatScrollIntent();
    expect(tracker.travel(0, Number.NaN, 0)).toBeUndefined();
    expect(tracker.wheel(new WheelEvent('wheel', { deltaY: deltaMode ? -1 : -10, deltaMode }), 800)).toBe('before');
  });
  it('accumulates fractional travel while cancelling oscillation and stale input', () => {
    const tracker = new FlowChatScrollIntent();
    for (let i = 0; i < 50; i++) expect(tracker.travel(0, i % 2 ? -0.75 : 0.75, i * 10)).toBeUndefined();
    tracker.reset();
    for (let i = 0; i < 7; i++) expect(tracker.travel(0, -0.5, 1000 + i * 10)).toBeUndefined();
    expect(tracker.travel(0, -0.5, 1070)).toBe('before');
    for (let i = 0; i < 20; i++) expect(tracker.travel(0, 1, 2000 + i * 250)).toBeUndefined();
    expect(tracker.travel(0, 80, 9000)).toBe('after');
  });
  it('does not accumulate the small vertical component of horizontal gestures', () => {
    const tracker = new FlowChatScrollIntent();
    for (let i = 0; i < 30; i++) expect(tracker.travel(1, 0.1, i * 10)).toBeUndefined();
    expect(tracker.travel(0, -20, 400)).toBe('before');
  });

  const touch = (y: number, x = 0, id = 1) => ({ clientX: x, clientY: y, identifier: id }) as Touch;
  const touchEvent = (touches: Touch[]) => new TouchEvent('touchmove', { touches });
  it('requires a single-finger vertical drag, not an unstarted move or contact jitter', () => {
    const tracker = new FlowChatTouchIntent();
    expect(tracker.move(touchEvent([touch(100)]))).toBeUndefined();
    tracker.start(touchEvent([touch(100)]));
    for (let i = 0; i < 30; i++) expect(tracker.move(touchEvent([touch(i % 2 ? 100 : 101)]))).toBeUndefined();
    expect(tracker.move(touchEvent([touch(85)]))).toBe('after');
    tracker.end();
    expect(tracker.move(touchEvent([touch(50)]))).toBeUndefined();
  });
  it('cancels multi-touch and finger replacement without inventing travel', () => {
    const tracker = new FlowChatTouchIntent();
    tracker.start(touchEvent([touch(100)]));
    expect(tracker.move(touchEvent([touch(50), touch(80, 0, 2)]))).toBeUndefined();
    expect(tracker.move(touchEvent([touch(30)]))).toBeUndefined();
    tracker.start(touchEvent([touch(100)]));
    expect(tracker.move(touchEvent([touch(50, 0, 2)]))).toBeUndefined();
  });

  function keyOn(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
    let direction: ReturnType<typeof flowChatKeyScrollDirection>;
    target.addEventListener('keydown', event => { direction = flowChatKeyScrollDirection(event); }, { once: true });
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
    return direction;
  }
  it.each(['input', 'select', 'textarea'])('does not reinterpret %s navigation as transcript scrolling', tag => {
    const element = document.createElement(tag);
    for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End', ' ']) expect(keyOn(element, key)).toBeUndefined();
  });
  it('keeps empty/plaintext contenteditable and ARIA widget keys with their owner', () => {
    const editor = document.createElement('div'); editor.setAttribute('contenteditable', 'plaintext-only');
    expect(keyOn(editor, 'Home')).toBeUndefined();
    editor.setAttribute('contenteditable', ''); expect(keyOn(editor, 'End')).toBeUndefined();
    const list = document.createElement('div'); list.setAttribute('role', 'listbox');
    const option = document.createElement('div'); list.append(option);
    expect(keyOn(option, 'ArrowUp')).toBeUndefined();
  });
  it('distinguishes button activation and composition from real transcript navigation', () => {
    const button = document.createElement('button');
    expect(keyOn(button, ' ')).toBeUndefined();
    expect(keyOn(button, 'ArrowUp')).toBe('before');
    const body = document.createElement('div');
    expect(keyOn(body, ' ', { isComposing: true })).toBeUndefined();
    expect(keyOn(body, ' ')).toBe('after');
    expect(keyOn(body, ' ', { shiftKey: true })).toBe('before');
    expect(keyOn(body, 'Home', { ctrlKey: true })).toBe('before');
  });
  it('arms only the actual primary-button scrollbar gutter, not content or an overflowing child', () => {
    const scroller = document.createElement('div'), child = document.createElement('div'); scroller.append(child);
    Object.defineProperties(scroller, { clientWidth: { value: 600 }, clientLeft: { value: 0 } });
    scroller.getBoundingClientRect = () => new DOMRect(10, 20, 616, 800);
    const press = (target: HTMLElement, clientX: number, button = 0, clientY = 200) => {
      let result = false;
      scroller.addEventListener('pointerdown', event => { result = isFlowChatScrollbarPress(event, scroller); }, { once: true });
      target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX, clientY, button }));
      return result;
    };
    expect(press(scroller, 615)).toBe(true);
    expect(press(scroller, 610)).toBe(false);
    expect(press(child, 615)).toBe(false);
    expect(press(scroller, 615, 2)).toBe(false);
    expect(press(scroller, 630)).toBe(false);
    expect(press(scroller, 615, 0, 900)).toBe(false);
  });
});
