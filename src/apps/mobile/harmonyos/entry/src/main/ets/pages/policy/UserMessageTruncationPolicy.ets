/**
 * Long user messages are read as a truncated preview with an inline affordance
 * that opens the whole message.
 *
 * The rule is frozen at eight lines or 360 characters, whichever comes first,
 * with an ellipsis the bubble appends after the cut. The policy is deliberately
 * width-agnostic: the bubble's own width changes with the posture and with the
 * fold, and measuring the message by its content — the way the composer and the
 * markdown parser already measure text — keeps one rule for compact and wide
 * instead of a line count that silently moves with the window.
 *
 * A message is never shown as truncated when the cut would hide nothing but
 * trailing whitespace, so the preview and the ellipsis agree with
 * `shouldTruncate` by construction.
 */
export class UserMessageTruncationPolicy {
  /** Frozen visual threshold: the preview keeps at most this many lines. */
  static readonly MAX_PREVIEW_LINES: number = 8;
  /** Frozen visual threshold: the preview keeps at most this many characters. */
  static readonly MAX_PREVIEW_CHARS: number = 360;
  /** Appended after the cut, before the inline full-text affordance. */
  static readonly ELLIPSIS: string = '...';

  /**
   * One line-ending convention for counting, the same one `MarkdownParser`
   * applies to message text: CRLF collapses to LF so a Windows-authored
   * message does not spend two characters per line break.
   */
  static normalize(text: string): string {
    return text.replace(/\r\n/g, '\n');
  }

  static shouldTruncate(text: string): boolean {
    return UserMessageTruncationPolicy.cutIndex(
      UserMessageTruncationPolicy.normalize(text)
    ) >= 0;
  }

  /**
   * The text the truncated bubble renders, ending in the ellipsis. A message
   * that is not truncated is returned normalized and otherwise untouched, so a
   * caller can render this unconditionally.
   *
   * Trailing whitespace is dropped before the ellipsis: a character cut can
   * land just past a line break, and an ellipsis that starts a line of its own
   * reads as a separate paragraph rather than as the end of the sentence.
   */
  static truncatedPreview(text: string): string {
    const normalized = UserMessageTruncationPolicy.normalize(text);
    const cut = UserMessageTruncationPolicy.cutIndex(normalized);
    if (cut < 0) {
      return normalized;
    }
    const body = normalized.substring(0, cut).replace(/[ \t\n]+$/, '');
    return body + UserMessageTruncationPolicy.ELLIPSIS;
  }

  /**
   * Where the preview stops, or -1 when the whole message is shown. Line and
   * character limits compete: whichever is reached first wins, so a long
   * one-liner and a tall short-line message both stop at a readable amount.
   */
  private static cutIndex(normalized: string): number {
    const cut = UserMessageTruncationPolicy.limitIndex(normalized);
    if (cut < 0 || normalized.substring(cut).trim().length === 0) {
      return -1;
    }
    return cut;
  }

  private static limitIndex(normalized: string): number {
    const lineCut = UserMessageTruncationPolicy.lineCutIndex(normalized);
    if (normalized.length <= UserMessageTruncationPolicy.MAX_PREVIEW_CHARS) {
      return lineCut;
    }
    const charCut = UserMessageTruncationPolicy.MAX_PREVIEW_CHARS;
    if (lineCut < 0) {
      return charCut;
    }
    return Math.min(lineCut, charCut);
  }

  /**
   * The index of the line break that starts the ninth line, which is the cut
   * that leaves eight whole lines in the preview. A message of eight lines or
   * fewer has no such break and is not truncated for being tall.
   */
  private static lineCutIndex(normalized: string): number {
    let lineBreaks: number = 0;
    for (let index: number = 0; index < normalized.length; index += 1) {
      if (normalized.charAt(index) !== '\n') {
        continue;
      }
      lineBreaks += 1;
      if (lineBreaks === UserMessageTruncationPolicy.MAX_PREVIEW_LINES) {
        return index;
      }
    }
    return -1;
  }
}
