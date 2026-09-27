import { CommandStatusResponse } from './RemoteModels';

export enum GoalAction { Open = 'open', Close = 'close', Read = 'read', Start = 'start', Edit = 'edit', Pause = 'pause', Resume = 'resume', Clear = 'clear' }
export interface RemoteThreadGoal {
  sessionId: string;
  objective: string;
  status: string;
  tokensUsed?: number;
  tokenBudget?: number;
}
export interface ThreadGoalResponse extends CommandStatusResponse { goal?: RemoteThreadGoal; }
export class ThreadGoalState {
  sessionId: string = '';
  visible: boolean = false;
  busy: boolean = false;
  loaded: boolean = false;
  goal?: RemoteThreadGoal;
  failure: string = '';
  withVisibility(visible: boolean): ThreadGoalState {
    const next = new ThreadGoalState();
    next.sessionId = this.sessionId; next.visible = visible; next.busy = this.busy;
    next.loaded = this.loaded; next.goal = this.goal; next.failure = this.failure;
    return next;
  }
}
export class GoalRequest {
  action: GoalAction;
  objective: string;
  constructor(action: GoalAction, objective: string = '') { this.action = action; this.objective = objective; }
}
export function parseGoalCommand(text: string): GoalRequest | undefined {
  const match = text.trim().match(/^\/goal(?=\s|$)\s*([\s\S]*)$/i);
  if (!match) return undefined;
  const objective = match[1].trim();
  switch (objective.toLowerCase()) {
    case '': case 'edit': return new GoalRequest(GoalAction.Open);
    case 'pause': return new GoalRequest(GoalAction.Pause);
    case 'resume': return new GoalRequest(GoalAction.Resume);
    case 'clear': return new GoalRequest(GoalAction.Clear);
    default: return new GoalRequest(GoalAction.Start, objective);
  }
}
