import { describe, expect, it } from 'vitest';

import { contextPickerOwnsKey } from './chatInputKeyOwnership';

describe('context picker key ownership', () => {
  it('releases navigation and acceptance keys so the open picker handles them', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', 'Tab']) {
      expect(contextPickerOwnsKey({ contextPickerActive: true, key })).toBe(true);
    }
  });

  it('keeps history navigation and send while the picker is closed', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', 'Tab']) {
      expect(contextPickerOwnsKey({ contextPickerActive: false, key })).toBe(false);
    }
  });

  it('leaves typing and caret keys with the editor', () => {
    for (const key of ['a', 'Backspace', 'ArrowLeft', 'ArrowRight', 'Escape']) {
      expect(contextPickerOwnsKey({ contextPickerActive: true, key })).toBe(false);
    }
  });
});
