import { ComposerSubmission } from '../../model/ComposerSubmission';
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

  private inFlight?: Promise<void>;
  private inFlightMutates: boolean = false;
  private requestSeq: number = 0;

  reset(): void {
    this.generation += 1;
    if (this.timer >= 0) clearTimeout(this.timer);
    this.timer = -1;
    this.inFlight = undefined;
    this.inFlightMutates = false;
    this.remote.threadGoal = new ThreadGoalState();
  }

  async dispatch(request: GoalRequest, submittedDraft?: string): Promise<void> {
    const sessionId = this.remote.activeSession.sessionId;
    if (request.action === GoalAction.Close) {
      this.remote.threadGoal = this.remote.threadGoal.withVisibility(false);
      return;
    }
    if (!sessionId || !this.manager) return;
    const read = request.action === GoalAction.Open || request.action === GoalAction.Read;
    // Any in-flight request already refreshes the goal; a user change never
    // waits behind a refresh, and runs after an earlier change instead of
    // being dropped.
    if (read && this.inFlight) {
      if (request.action === GoalAction.Open) this.remote.threadGoal = this.snapshot(sessionId).withVisibility(true);
      return;
    }
    if (request.action === GoalAction.Read && !this.foreground) return;
    if (!this.remote.supportsHostCapability('thread_goal_v1')) {
      const previous = this.snapshot(sessionId);
      const state = new ThreadGoalState();
      state.sessionId = sessionId;
      state.visible = previous.visible || request.action !== GoalAction.Read;
      state.loaded = previous.loaded;
      state.goal = previous.goal;
      state.failure = 'unsupported';
      this.remote.threadGoal = state;
      return;
    }
    const composer = submittedDraft === undefined ? undefined : this.remote.conversation.prepareComposerSubmission(sessionId, submittedDraft, []);
    const priorChange = this.inFlightMutates ? this.inFlight : undefined;
    this.requestSeq += 1;
    const run = this.run(request, sessionId, read, this.requestSeq, priorChange, composer);
    this.inFlight = run;
    this.inFlightMutates = !read;
    try {
      await run;
    } finally {
      if (this.inFlight === run) {
        this.inFlight = undefined;
        this.inFlightMutates = false;
      }
    }
  }

  private async run(request: GoalRequest, sessionId: string, read: boolean, seq: number,
    priorChange: Promise<void> | undefined, composer: ComposerSubmission | undefined): Promise<void> {
    const generation = this.generation;
    const target = this.manager!.goalTargetGeneration();
    if (priorChange) {
      await priorChange;
      if (!this.current(sessionId, generation, target)) return;
    }
    const previous = this.snapshot(sessionId);
    // Background refreshes of a loaded goal keep the panel interactive.
    const showsProgress = !read || !previous.loaded;
    const state = new ThreadGoalState();
    state.sessionId = sessionId;
    state.visible = previous.visible || request.action === GoalAction.Open;
    state.loaded = previous.loaded;
    state.goal = previous.goal;
    state.busy = showsProgress;
    state.failure = showsProgress ? '' : previous.failure;
    this.remote.threadGoal = state;
    // A refresh superseded by a later change must not publish its snapshot.
    const superseded = (): boolean => read && seq !== this.requestSeq;
    try {
      const response = await this.manager!.threadGoal(sessionId, request.action, request.objective || undefined);
      if (!this.current(sessionId, generation, target) || superseded()) return;
      const next = new ThreadGoalState();
      next.sessionId = sessionId;
      next.visible = this.remote.threadGoal.visible;
      next.loaded = true;
      next.goal = response.goal;
      this.remote.threadGoal = next;
      composer?.commit();
    } catch (_) {
      if (!this.current(sessionId, generation, target) || superseded()) return;
      const failed = new ThreadGoalState();
      failed.sessionId = sessionId;
      failed.visible = this.remote.threadGoal.visible || !read;
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

  private snapshot(sessionId: string): ThreadGoalState {
    return this.remote.threadGoal.sessionId === sessionId ? this.remote.threadGoal : new ThreadGoalState();
  }

  private current(sessionId: string, generation: number, target: number): boolean {
    return this.remote.activeSession.sessionId === sessionId && this.generation === generation &&
      this.manager?.goalTargetGeneration() === target;
  }
}
