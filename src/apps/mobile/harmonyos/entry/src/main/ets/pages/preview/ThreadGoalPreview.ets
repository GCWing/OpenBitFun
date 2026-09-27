import { GoalAction, GoalRequest, ThreadGoalState } from '../../model/ThreadGoal';
import { ThreadGoalPanel } from '../components/ThreadGoalPanel';
import { PAGE_BG } from '../components/Theme';

/** Isolated native fixture: all actions remain in memory, with no remote IO. */
@ComponentV2
export struct ThreadGoalPreview {
  @Local state: ThreadGoalState = this.initialState();
  private initialState(): ThreadGoalState {
    const state = new ThreadGoalState();
    state.sessionId = 'goal-preview';
    state.loaded = true;
    state.goal = { sessionId: 'goal-preview', objective: 'Verify mobile goal controls', status: 'active', tokensUsed: 1200 };
    return state;
  }
  build() {
    Column() {
      ThreadGoalPanel({ state: this.state, sessionId: 'goal-preview', connected: true,
        onAction: (request: GoalRequest): void => this.apply(request) })
    }.width('100%').height('100%').justifyContent(FlexAlign.Center).backgroundColor(PAGE_BG)
  }
  private apply(request: GoalRequest): void {
    const next = this.initialState();
    next.goal = this.state.goal;
    next.visible = request.action === GoalAction.Close ? false : request.action === GoalAction.Read ? this.state.visible : true;
    if (request.action === GoalAction.Clear) next.goal = undefined;
    if (request.action === GoalAction.Start || request.action === GoalAction.Edit) {
      next.goal = { sessionId: 'goal-preview', objective: request.objective, status: 'active', tokensUsed: 0 };
    }
    if (next.goal && (request.action === GoalAction.Pause || request.action === GoalAction.Resume)) {
      next.goal = { sessionId: 'goal-preview', objective: next.goal.objective,
        status: request.action === GoalAction.Pause ? 'paused' : 'active', tokensUsed: 1200 };
    }
    this.state = next;
  }
}
