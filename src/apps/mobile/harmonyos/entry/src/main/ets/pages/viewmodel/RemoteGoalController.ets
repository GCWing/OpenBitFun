import { GoalAction, GoalRequest, ThreadGoalState } from '../../model/ThreadGoal';
import { RemoteSessionManager } from '../../services/RemoteSessionManager';
import { RemotePageState } from '../state/RemotePageState';

/** Goal state belongs to the executing host, never the mobile cache. */
export class RemoteGoalController {
  private foreground: boolean = true;
  setForeground(active: boolean): void {
    this.foreground = active;
    if (active && this.remote.threadGoal.sessionId) void this.dispatch(new GoalRequest(GoalAction.Read));
  }
  private timer: number = -1;
  private generation: number = 0;
  private readonly remote: RemotePageState;
  private readonly manager?: RemoteSessionManager;
  constructor(remote: RemotePageState, manager?: RemoteSessionManager) { this.remote = remote; this.manager = manager; }

  reset(): void {
    this.generation += 1;
    if (this.timer >= 0) clearTimeout(this.timer);
    this.timer = -1;
    this.remote.threadGoal = new ThreadGoalState();
  }

  async dispatch(request: GoalRequest, submittedDraft?: string): Promise<void> {
    const sessionId = this.remote.activeSession.sessionId;
    if (request.action === GoalAction.Close) {
      this.remote.threadGoal = this.remote.threadGoal.withVisibility(false);
      return;
    }
    if (!sessionId || !this.manager) return;
    const previous = this.remote.threadGoal.sessionId === sessionId ? this.remote.threadGoal : new ThreadGoalState();
    if (previous.busy) {
      if (request.action === GoalAction.Open) this.remote.threadGoal = previous.withVisibility(true);
      return;
    }
    if (request.action === GoalAction.Read && !this.foreground) return;
    const state = new ThreadGoalState();
    state.sessionId = sessionId;
    state.visible = previous.visible || request.action === GoalAction.Open;
    state.loaded = previous.loaded;
    state.goal = previous.goal;
    if (!this.remote.supportsHostCapability('thread_goal_v1')) {
      state.failure = 'unsupported';
      state.visible = state.visible || request.action !== GoalAction.Read;
      this.remote.threadGoal = state;
      return;
    }
    const composer = submittedDraft === undefined ? undefined : this.remote.conversation.prepareComposerSubmission(sessionId, submittedDraft, []);
    const generation = this.generation;
    const target = this.manager.goalTargetGeneration();
    state.busy = true;
    this.remote.threadGoal = state;
    try {
      const response = await this.manager.threadGoal(sessionId, request.action, request.objective || undefined);
      if (!this.current(sessionId, generation, target)) return;
      const next = new ThreadGoalState();
      next.sessionId = sessionId;
      next.visible = this.remote.threadGoal.visible;
      next.loaded = true;
      next.goal = response.goal;
      this.remote.threadGoal = next;
      composer?.commit();
    } catch (_) {
      if (!this.current(sessionId, generation, target)) return;
      const failed = new ThreadGoalState();
      failed.sessionId = sessionId;
      failed.visible = this.remote.threadGoal.visible || request.action !== GoalAction.Read;
      failed.goal = previous.goal;
      failed.loaded = previous.loaded;
      failed.failure = 'failed';
      this.remote.threadGoal = failed;
    }
    if (!this.current(sessionId, generation, target)) return;
    if (this.timer >= 0) clearTimeout(this.timer);
    this.timer = setTimeout((): void => {
      this.timer = -1;
      if (this.current(sessionId, generation, target)) {
        void this.dispatch(new GoalRequest(GoalAction.Read));
      }
    }, 5000);
  }

  private current(sessionId: string, generation: number, target: number): boolean {
    return this.remote.activeSession.sessionId === sessionId && this.generation === generation &&
      this.manager?.goalTargetGeneration() === target;
  }
}
