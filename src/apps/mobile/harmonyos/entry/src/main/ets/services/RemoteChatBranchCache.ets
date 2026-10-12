import { ChatMessage } from '../model/RemoteModels';
import { RemoteChatCache } from './RemoteChatCache';
import { SubagentBranchCache } from './SubagentStreamCoordinator';

/**
 * Child-branch transcripts in the phone's own transcript cache.
 *
 * This is the storage the parent session's transcript already uses: transcripts
 * scoped per controlled desktop and session id, every failure swallowed because
 * a cache is reconstructible from the desktop, and one clear on sign-out. A
 * child session is an ordinary session on its own stream id, so it is stored
 * under its own id — which is also the id the parent's launching item names, and
 * therefore the key that maps a stored child back to the parent and the branch
 * that owns it. No second store, no second schema, and no second lifecycle to
 * keep in step with the parent's.
 */
export class RemoteChatBranchCache implements SubagentBranchCache {
  private readonly cache: RemoteChatCache;

  constructor(cache: RemoteChatCache) {
    this.cache = cache;
  }

  async loadBranch(sessionId: string): Promise<ChatMessage[]> {
    return await this.cache.load(sessionId);
  }

  /**
   * A child's transcript is authoritative for the child, the same way the parent
   * transcript is: the reducer's projection is complete at every change, so it
   * replaces the stored rows rather than appending to them.
   */
  async saveBranch(sessionId: string, messages: ChatMessage[]): Promise<void> {
    await this.cache.replaceSnapshot(sessionId, messages);
  }
}
