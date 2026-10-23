import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopCardAPI, isDesktopPinned } from './DesktopCardAPI';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('./ApiClient', () => ({ api: { invoke } }));

const legacyCard = {
  id: 'card-1', title: 'Note', template: { kind: 'note', text: 'hello' },
  visible: true, alwaysOnTop: true, createdAtMs: 1, updatedAtMs: 1,
};

describe('DesktopCardAPI desktop pinning compatibility', () => {
  const cards = new DesktopCardAPI();
  beforeEach(() => invoke.mockReset());

  it.each([undefined, false])('refuses an unsupported host without mutating its window (%s)', async supported => {
    invoke.mockResolvedValue({ ...legacyCard, desktopPinningSupported: supported });
    await expect(cards.setDesktopPinned('card-1', true)).rejects.toThrow('requires a Windows host');
    expect(invoke.mock.calls).toEqual([['desktop_card_get', { request: { cardId: 'card-1' } }]]);
  });

  it.each([true, false])('negotiates before sending the additive request (%s)', async pinned => {
    const result = { ...legacyCard, alwaysOnTop: false, desktopPinned: pinned };
    invoke.mockResolvedValueOnce({ ...legacyCard, desktopPinningSupported: true }).mockResolvedValueOnce(result);
    await expect(cards.setDesktopPinned('card-1', pinned)).resolves.toEqual(result);
    expect(invoke.mock.calls).toEqual([
      ['desktop_card_get', { request: { cardId: 'card-1' } }],
      ['desktop_card_set_always_on_top', { request: { cardId: 'card-1', alwaysOnTop: false, desktopPinned: pinned } }],
    ]);
  });

  it('keeps the old always-on-top payload unchanged', async () => {
    invoke.mockResolvedValue(legacyCard);
    await cards.setAlwaysOnTop('card-1', true);
    expect(invoke).toHaveBeenCalledWith('desktop_card_set_always_on_top', {
      request: { cardId: 'card-1', alwaysOnTop: true },
    });
  });

  it.each([{ supported: true }, { supported: false }, {}])(
    'reads the pinning capability from the list payload without dropping cards (%o)',
    async payload => {
      invoke.mockResolvedValue({
        enabled: true,
        cards: [{ ...legacyCard, desktopPinned: true }],
        ...('supported' in payload ? { desktopPinningSupported: payload.supported } : {}),
      });
      const list = await cards.list();
      expect(invoke).toHaveBeenCalledWith('desktop_card_list', { request: {} });
      expect(list.desktopPinningSupported).toBe('supported' in payload ? payload.supported : false);
      expect(list.cards).toHaveLength(1);
      expect(list.cards[0].desktopPinned).toBe(true);
    },
  );

  it('treats desktop pinning and global topmost as exclusive', () => {
    expect(isDesktopPinned({ desktopPinned: true, alwaysOnTop: false })).toBe(true);
    expect(isDesktopPinned({ desktopPinned: true, alwaysOnTop: true })).toBe(false);
    expect(isDesktopPinned({ alwaysOnTop: false })).toBe(false);
  });
});
