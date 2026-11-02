/**
 * One delegation card's disclosure, keyed by the branch it belongs to.
 *
 * `@Trace` is what the card reads: a component that renders `expanded` is
 * repainted when it changes, wherever the change came from.
 */
@ObservedV2
export class SubagentBranchDisclosure {
  readonly key: string;
  @Trace expanded: boolean = false;

  constructor(key: string) {
    this.key = key;
  }
}

/**
 * Which delegation cards the reader has opened, keyed by branch identity.
 *
 * The card cannot own this itself. Its row is rebuilt whenever the turn it sits
 * in is republished — a launch settling reorders the structured groups of the
 * turn, and the row's keyed subtree is rebuilt with it — and a card that kept
 * its disclosure in its own `@Local` state collapsed under the reader at exactly
 * that moment. Hoisting the boolean to owner state that outlives the row keeps
 * what the reader opened open, which is the same reason the sidebar's workspace
 * disclosure lives in `DeviceDirectoryState` rather than in its row — and it is
 * why this container is observed the same way that one is: `@Trace` on the
 * collection as well as on the entry, so a card that reads a key it has not
 * looked up before is still repainted when that key's entry arrives.
 *
 * The key is the branch, not the view path or the row: a card keeps its
 * disclosure while its worker streams, while the transcript around it changes,
 * and while the list recycles its row — until the session's state itself is
 * replaced. Disclosure deliberately does not survive an app restart; that is a
 * separate promise nothing here makes.
 */
@ObservedV2
export class SubagentBranchExpansionState {
  @Trace disclosures: SubagentBranchDisclosure[] = [];

  isExpanded(key: string): boolean {
    const found = this.find(key);
    return found !== undefined && found.expanded;
  }

  /**
   * Which branches the reader has open, in the order they were opened.
   *
   * Disclosure is the reader's, and this is the only reading of it that outlives
   * a row: it is what a preview states and what a test asserts, in place of
   * looking for the pixels a card happens to draw.
   */
  expandedKeys(): string[] {
    return this.disclosures
      .filter((entry: SubagentBranchDisclosure): boolean => entry.expanded)
      .map((entry: SubagentBranchDisclosure): string => entry.key);
  }

  setExpanded(key: string, expanded: boolean): void {
    if (key.length === 0) return;
    this.ensure(key).expanded = expanded;
  }

  /** Flips one card and answers what it now is, so the caller can act on opening. */
  toggle(key: string): boolean {
    if (key.length === 0) return false;
    const disclosure = this.ensure(key);
    disclosure.expanded = !disclosure.expanded;
    return disclosure.expanded;
  }

  private find(key: string): SubagentBranchDisclosure | undefined {
    return this.disclosures.find((entry: SubagentBranchDisclosure): boolean => entry.key === key);
  }

  private ensure(key: string): SubagentBranchDisclosure {
    const found = this.find(key);
    if (found !== undefined) return found;
    const created = new SubagentBranchDisclosure(key);
    this.disclosures.push(created);
    return created;
  }
}
