/** Maps the product execution levels onto the host's canonical Agents. */
export class HarnessProfilePolicy {
  static agentType(profileId: string): string {
    switch (profileId.trim().toLowerCase()) {
      case 'minimal': return 'minimal';
      case 'ultimate': return 'Ultra';
      case 'creative': return 'Creative';
      default: return 'agentic';
    }
  }
}
