/**
 * Visibility switches for the Appearance package distribution entry points.
 *
 * The local package import path is available so users can install custom
 * appearance packages directly. The Skin market entry remains hidden while its
 * dialog, API, and backend commands stay wired behind the visibility switch.
 */
export const APPEARANCE_MARKET_ENTRY_VISIBLE: boolean = false;
export const APPEARANCE_PACKAGE_IMPORT_VISIBLE: boolean = true;
