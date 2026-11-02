import { InteractionMailboxAction } from '../model/InteractionMailbox';
import { ChatMessage } from '../model/RemoteModels';
import {
  ChatSessionController,
  ChatSessionControllerCallbacks,
  ChatSessionCursor,
  ChatSessionSnapshot
} from './ChatSessionController';
import { SubagentBranchCache } from './SubagentStreamCoordinator';
import { RemoteSessionManager } from './RemoteSessionManager';

export type RemoteChatPollingCursor = ChatSessionCursor;
export type RemoteChatPollingSnapshot = ChatSessionSnapshot;

export interface RemoteChatPollingStartSnapshot {
  sessionId: string;
  cursor: RemoteChatPollingCursor;
  activeTurn?: ChatMessage;
}

export type RemoteChatPollingLifecycleCallbacks = ChatSessionControllerCallbacks;

export class RemoteChatPollingLifecycleController {
  private readonly controller: ChatSessionController;

  constructor(sessionManager: RemoteSessionManager, callbacks: ChatSessionControllerCallbacks,
    branchCache?: SubagentBranchCache) {
    this.controller = new ChatSessionController(sessionManager, callbacks, {
      initialPollDelayMs: 400,
      branchCache: branchCache
    });
  }

  startActiveSession(snapshot: RemoteChatPollingStartSnapshot): void {
    if (snapshot.sessionId.length === 0) {
      return;
    }
    this.controller.start(snapshot.sessionId, snapshot.cursor, snapshot.activeTurn);
  }

  stop(): void {
    this.controller.stop();
  }

  async dispatchMailbox(action: InteractionMailboxAction): Promise<void> { await this.controller.dispatchMailbox(action); }

  async refreshModelCatalog(): Promise<void> { await this.controller.refreshModelCatalog(); }

  loadOlder(): void { this.controller.loadOlder(); }

  ensureBranchSubscribed(ownerToolCallId: string): void {
    this.controller.ensureBranchSubscribed(ownerToolCallId);
  }

  nudge(): void {
    this.controller.nudge();
  }

  async pollNow(): Promise<void> {
    await this.controller.pollNow();
  }

  updateCursor(cursor: RemoteChatPollingCursor): void {
    this.controller.updateCursor(cursor);
  }

  updateKnownModelCatalogVersion(version: number): void {
    this.controller.updateKnownModelCatalogVersion(version);
  }
}
