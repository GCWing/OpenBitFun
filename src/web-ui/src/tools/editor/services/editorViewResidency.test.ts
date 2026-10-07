import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorViewResidency } from './editorViewResidency';

afterEach(() => vi.useRealTimers());
describe('editor view residency', () => {
  it('bounds warm views across hosts, keeps visible split panes and expires inactive views', () => {
    vi.useFakeTimers();
    const residency = new EditorViewResidency(2, 100);
    const suspended: number[] = [];
    const keys = Array.from({ length: 5 }, () => ({}));
    keys.forEach((key, index) => {
      residency.update(key, true, () => suspended.push(index));
      if (index < 3) residency.update(key, false, () => suspended.push(index));
      vi.advanceTimersByTime(1);
    });
    expect(suspended).toEqual([0]);
    vi.advanceTimersByTime(100);
    expect(suspended.sort()).toEqual([0, 1, 2]);
    keys.forEach(key => residency.delete(key));
  });
});
