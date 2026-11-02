/**
 * The one failure mode `host_invoke` distinguishes: the host answered.
 *
 * A bridge answers every invoke with `{ok, value, error}`, and `ok: false` means
 * the host received the command and declined it — an unknown name, a retired
 * command, a mode it does not have. Everything else that can go wrong on this
 * wire (no connection, an expired room, a timeout, a payload that decodes to
 * nothing) never reached a host at all, and the two must not be described to the
 * user as the same event.
 *
 * This module owns only that distinction, so the palette can ask whether the host
 * spoke without knowing which transport carried the question.
 */

export class HostInvokeRefusal extends Error {
  /** The host's own words for the refusal, exactly as it sent them. */
  readonly hostText: string;
  /** The command the host declined. */
  readonly command: string;

  constructor(command: string, hostText: string) {
    super(hostText.length > 0 ? hostText : `Remote host refused ${command}`);
    this.name = 'HostInvokeRefusal';
    this.command = command;
    this.hostText = hostText;
  }
}

/** Whether this failure is the host declining a command rather than the wire breaking. */
export function isHostInvokeRefusal(err: Object): boolean {
  return err instanceof HostInvokeRefusal;
}

/**
 * The host's own account of a refusal.
 *
 * Kept separate from the shared connection-error wording on purpose: a refused
 * command is about the command, and the shared policy rewrites text that looks
 * like a URL or a permission problem — which is exactly the kind of sentence a
 * refusal needs to keep.
 */
export function hostInvokeRefusalText(err: Object): string {
  return isHostInvokeRefusal(err) ? (err as HostInvokeRefusal).hostText : '';
}
