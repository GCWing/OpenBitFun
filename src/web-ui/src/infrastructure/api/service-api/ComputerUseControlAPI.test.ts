import { beforeEach, expect, it, vi } from 'vitest';
import { computerUseControlAPI, projectControlPointer, type ComputerUseControlPreview } from './ComputerUseControlAPI';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('./ApiClient', () => ({ api: { invoke } }));
beforeEach(() => invoke.mockReset());

it('sends the observed generation with stop and preview to the selected host transport', async () => {
  await computerUseControlAPI.stop(41);
  await computerUseControlAPI.preview(42);
  expect(invoke.mock.calls).toEqual([
    ['computer_use_control_stop', { request: { generation: 41 } }],
    ['computer_use_control_preview', { request: { generation: 42 } }],
  ]);
});

const frame: ComputerUseControlPreview = {
  generation: 1, target: 'fixture', image_base64: '', mime_type: 'image/png', width: 1600, height: 1200,
  origin_x: -800, origin_y: 200, span_width: 800, span_height: 600,
};
it('projects physical coordinates on a negative-origin Retina monitor', () => {
  expect(projectControlPointer(frame, { x: -400, y: 350, click: true }))
    .toEqual({ x: 0.5, y: 0.25, click: true });
});
it('rejects stale/outside coordinates and invalid capture geometry without edge clamping', () => {
  for (const pointer of [{ x: 0, y: 350, click: false }, { x: -801, y: 350, click: false },
    { x: NaN, y: 350, click: false }]) expect(projectControlPointer(frame, pointer)).toBeNull();
  expect(projectControlPointer({ ...frame, span_width: 0 }, { x: -400, y: 350, click: false })).toBeNull();
});
