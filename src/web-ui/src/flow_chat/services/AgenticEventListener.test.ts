import { afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  surface: 'local', text: null as ((event: any) => void) | null,
  tool: null as ((event: any) => void) | null,
}));
vi.mock('@/infrastructure/peer-device/deviceSurface', () => ({ getActiveSurfaceId: () => fixture.surface }));
vi.mock('@/infrastructure/api/service-api/AgentAPI', () => ({ agentAPI: {
  onTextChunk: (listener: (event: any) => void) => { fixture.text = listener; return () => {}; },
  onToolEvent: (listener: (event: any) => void) => { fixture.tool = listener; return () => {}; },
  onPromptSuggestion: () => () => {},
} }));
import { agenticEventListener } from './AgenticEventListener';
afterEach(async () => { await agenticEventListener.stopListening(); fixture.surface = 'local'; });
it('uses records for remote content while local content and remote approvals keep their owners', async () => {
  const onTextChunk = vi.fn(), onToolEvent = vi.fn();
  await agenticEventListener.startListening({ onTextChunk, onToolEvent });
  fixture.text?.({ text: 'local token' });
  fixture.tool?.({ toolEvent: { event_type: 'Completed', result: 'local result' } });
  expect(onTextChunk).toHaveBeenCalledOnce();
  expect(onToolEvent).toHaveBeenCalledOnce();
  fixture.surface = 'peer';
  fixture.text?.({ text: 'duplicate remote token' });
  for (const event_type of ['Started', 'ParamsPartial', 'StreamChunk', 'Completed', 'Failed']) {
    fixture.tool?.({ toolEvent: { event_type, result: 'duplicate remote body' } });
    expect(agenticEventListener.dispatchExternal('agentic://tool-event', { toolEvent: { event_type } })).toBe(true);
  }
  expect(onTextChunk).toHaveBeenCalledOnce();
  expect(onToolEvent).toHaveBeenCalledOnce();
  fixture.tool?.({ toolEvent: { event_type: 'ConfirmationNeeded' } });
  expect(onToolEvent).toHaveBeenCalledTimes(2);
});
it('routes peer prompt suggestions to the registered handler', async () => {
  const onPromptSuggestion = vi.fn();
  await agenticEventListener.startListening({ onPromptSuggestion });
  const payload = { sessionId: 'peer-session', sourceTurnId: 'turn-1', suggestion: 'Run the tests' };
  expect(agenticEventListener.dispatchExternal('agentic://prompt-suggestion', payload)).toBe(true);
  expect(onPromptSuggestion).toHaveBeenCalledExactlyOnceWith(payload);
});
