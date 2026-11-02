/**
 * Visibility switches for the Appearance package distribution entry points.
 *
 * The Skin market and the local package import path are hidden from the
 * Appearance settings page. The market dialog, the market API, and the backend
 * commands stay wired behind these switches, so restoring an entry point only
 * requires flipping its switch back to true.
 */
export const APPEARANCE_MARKET_ENTRY_VISIBLE: boolean = false;
export const APPEARANCE_PACKAGE_IMPORT_VISIBLE: boolean = false;
