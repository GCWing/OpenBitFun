export type FlowChatScrollDirection = 'before' | 'after';

// CSS pixels, not event counts: high-resolution devices can emit a deliberate
// gesture as many fractions. Signed travel cancels jitter instead of adding it.
const WHEEL_INTENT_PX = 4;
const TOUCH_INTENT_PX = 8;
const GESTURE_GAP_MS = 200;

export class FlowChatScrollIntent {
  private x = 0;
  private y = 0;
  private at = -Infinity;

  constructor(private readonly threshold = WHEEL_INTENT_PX) {}

  reset() { this.x = 0; this.y = 0; this.at = -Infinity; }

  travel(x: number, y: number, now: number): FlowChatScrollDirection | undefined {
    if (!Number.isFinite(x) || !Number.isFinite(y)) { this.reset(); return; }
    if (now - this.at > GESTURE_GAP_MS) this.reset();
    this.at = now; this.x += x; this.y += y;
    if (Math.max(Math.abs(this.x), Math.abs(this.y)) < this.threshold) return;
    const direction = Math.abs(this.y) > Math.abs(this.x) ? this.y < 0 ? 'before' : 'after' : undefined;
    this.reset();
    return direction;
  }

  wheel(event: WheelEvent, viewportHeight: number): FlowChatScrollDirection | undefined {
    // Ctrl-wheel is zoom; Shift-wheel commonly maps a vertical wheel to a
    // horizontal code scroller. Neither asks to browse this transcript.
    if (event.defaultPrevented || event.ctrlKey || event.shiftKey) { this.reset(); return; }
    const unit = event.deltaMode === 2 ? viewportHeight : event.deltaMode === 1 ? 16 : 1;
    return this.travel(event.deltaX * unit, event.deltaY * unit, event.timeStamp);
  }
}

export class FlowChatTouchIntent {
  private point: { id: number; x: number; y: number } | null = null;
  private travel = new FlowChatScrollIntent(TOUCH_INTENT_PX);

  start(event: TouchEvent) {
    this.end();
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    if (touch) this.point = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
  }
  end() { this.point = null; this.travel.reset(); }
  move(event: TouchEvent): FlowChatScrollDirection | undefined {
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    const previous = this.point;
    if (event.defaultPrevented || !touch || !previous || previous.id !== touch.identifier) { this.end(); return; }
    this.point = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
    return this.travel.travel(previous.x - touch.clientX, previous.y - touch.clientY, event.timeStamp);
  }
}

export function flowChatKeyScrollDirection(event: KeyboardEvent): FlowChatScrollDirection | undefined {
  if (event.defaultPrevented || event.isComposing) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="listbox"], [role="menu"], [role="slider"], [role="spinbutton"], [role="tablist"], [role="radiogroup"]')) return;
  if (event.key === ' ' && target?.closest('button, [role="button"], [role="checkbox"], [role="radio"], [role="switch"], summary')) return;
  if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) return 'before';
  if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) return 'after';
}

export function isFlowChatScrollbarPress(event: PointerEvent, scroller: HTMLElement): boolean {
  if (event.button !== 0 || event.target !== scroller) return false;
  const rect = scroller.getBoundingClientRect();
  const contentRight = rect.left + scroller.clientLeft + scroller.clientWidth;
  return event.clientX > contentRight && event.clientX <= rect.right
    && event.clientY >= rect.top && event.clientY <= rect.bottom;
}
