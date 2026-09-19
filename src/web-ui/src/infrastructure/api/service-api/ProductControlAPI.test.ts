import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductControlAPI } from './ProductControlAPI';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('./ApiClient', () => ({
  api: { invoke: invokeMock },
}));

describe('ProductControlAPI', () => {
  beforeEach(() => invokeMock.mockReset());

  it('reads discovery pages through the same host adapter with the original query and cursor', async () => {
    const page = { items: [{ id: 'peer.feature' }], cursor: 20, nextCursor: null, totalCount: 21 };
    invokeMock.mockResolvedValueOnce(page);
    await expect(new ProductControlAPI().discover({ action: 'search', query: 'appearance', cursor: 20 }))
      .resolves.toBe(page);
    expect(invokeMock).toHaveBeenCalledWith('product_control_invoke', {
      request: { action: 'search', query: 'appearance', cursor: 20 },
    });
  });

  it('uses stable IDs and the structured Desktop command contract', async () => {
    invokeMock.mockResolvedValueOnce({ effectiveValue: true, revision: 8 });

    await new ProductControlAPI().configure(
      'setting.application.general',
      'prevent-sleep',
      true,
    );

    expect(invokeMock).toHaveBeenCalledWith('product_control_invoke', {
      request: {
        action: 'configure',
        capabilityId: 'setting.application.general',
        optionId: 'prevent-sleep',
        value: true,
      },
    });
  });

  it('does not expose an arbitrary config path or Tauri command escape hatch', () => {
    const api = new ProductControlAPI() as unknown as Record<string, unknown>;

    expect(api.setConfig).toBeUndefined();
    expect(api.invokeCommand).toBeUndefined();
  });
});
