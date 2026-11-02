/**
 * Keys the '@' reference picker consumes while it is open.
 */
const CONTEXT_PICKER_OWNED_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'Enter',
  'Tab',
]);

/**
 * The '@' reference picker is an overlay layer, so the overlay coordinator routes
 * its keyboard from the document after React handlers. The composer must release
 * every key the picker consumes instead of relying on event order; otherwise the
 * picker loses ArrowDown to history navigation and Enter to send.
 */
export function contextPickerOwnsKey(params: {
  contextPickerActive: boolean;
  key: string;
}): boolean {
  return params.contextPickerActive && CONTEXT_PICKER_OWNED_KEYS.has(params.key);
}
