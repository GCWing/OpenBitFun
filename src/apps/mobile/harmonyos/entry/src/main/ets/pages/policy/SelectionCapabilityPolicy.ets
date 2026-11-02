/**
 * Which selection surface a device can offer over rendered markdown.
 *
 * `SelectionContainer` (API 26) is the only way to make a column of sibling
 * `Text` components one continuous selection, so a handle can be dragged from a
 * paragraph into the list item or code block underneath it. Below 26 the same
 * subtree stays selectable one `Text` at a time through each child's own
 * `copyOption`.
 *
 * The gate is given the device's reported API level instead of reading it, so
 * the boundary stays host-testable and the platform read stays behind a service
 * (see the mobile architecture rules for components).
 */
export class SelectionCapabilityPolicy {
  /** First API level that ships `SelectionContainer`. */
  static readonly CROSS_BLOCK_SELECTION_API_LEVEL: number = 26;

  static supportsCrossBlockSelection(sdkApiVersion: number): boolean {
    // Anything that is not a finite number is not evidence of API 26. A device
    // whose level cannot be measured keeps the fallback path, which still copies
    // the block the user pressed on, instead of risking an API-26 call that the
    // platform would reject.
    if (!Number.isFinite(sdkApiVersion)) {
      return false;
    }
    return sdkApiVersion >= SelectionCapabilityPolicy.CROSS_BLOCK_SELECTION_API_LEVEL;
  }
}
