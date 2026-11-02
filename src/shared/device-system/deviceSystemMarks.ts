/**
 * Monochrome contours of the systems a host can report, for a row-sized mark.
 * Windows, macOS and HarmonyOS are the CC0 simple-icons vectors, and Linux is the
 * Font Awesome Linux brand icon (CC BY 4.0, see THIRD_PARTY_NOTICES.md): the
 * artwork's Tux is drawn as a fine-line illustration that reads as a different
 * kind of drawing at this size, and the abstract flat penguin marks are not
 * recognisable as Linux at all.
 *
 * `server` is not a system mark at all: a headless host reports no system this
 * client can draw a logo for, so it stands for the machine instead. It is this
 * product's own drawing — three rack units, their status lights punched out as
 * negative space — on the same unit grid, in the same solid ink, and in the same
 * box as the Windows mark. It is deliberately not the artwork's outline rack:
 * traced into this slot that read as the one hollow, undersized mark in a row of
 * solid logos. The card artwork masks this same shape.
 *
 * Every mark renders at one width instead of one height: each view box is the
 * mark's own ink box, measured with getBBox, given the height of the tallest mark
 * in the set, so a four-pane square and an apple take the same room in a row
 * without either being stretched to get there.
 *
 * Inline paths rather than masked asset files, because a mask whose asset does
 * not resolve paints the element as a solid block instead of showing no mark.
 *
 * Shared by the desktop shell and mobile web: both surfaces name the same
 * devices, so one device is drawn the same way on either. How large a mark is,
 * what colour it takes and where it sits stay local to each surface.
 */

export type DeviceSystemKey = 'windows' | 'macos' | 'linux' | 'harmonyos' | 'server';

/**
 * `opticalShift` is how far a mark's own mass sits from the centre of its box,
 * as a fraction of that box, measured by rasterising the mark and taking its
 * centroid. A mark is not a rectangle: the Apple's leaf is thin above a heavy
 * body, so its mass sits about 9% below centre and the mark reads as low beside
 * a line of text. The set is small and reviewed, so each mark states its own
 * correction (positive moves the mark down) instead of every caller carrying
 * one. A mark whose mass is already centred keeps 0, and the lucide fallback
 * glyph is centred by its own construction.
 */
export const DEVICE_SYSTEM_MARKS: Record<
  DeviceSystemKey,
  { viewBox: string; path: string; opticalShift: number }
> = {
  windows: {
    viewBox: '0 -2.7315 24 29.4629',
    path: 'M0,0H11.377V11.372H0ZM12.623,0H24V11.372H12.623ZM0,12.623H11.377V24H0Zm12.623,0H24V24H12.623',
    opticalShift: 0,
  },
  macos: {
    viewBox: '2.225 0 19.55 24',
    path: 'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701',
    opticalShift: -0.085,
  },
  linux: {
    viewBox: '12.674 -3.5278 422.849 519.0985',
    path: 'M220.8 123.3c1 .5 1.8 1.7 3 1.7 1.1 0 2.8-.4 2.9-1.5.2-1.4-1.9-2.3-3.2-2.9-1.7-.7-3.9-1-5.5-.1-.4.2-.8.7-.6 1.1.3 1.3 2.3 1.1 3.4 1.7zm-21.9 1.7c1.2 0 2-1.2 3-1.7 1.1-.6 3.1-.4 3.5-1.6.2-.4-.2-.9-.6-1.1-1.6-.9-3.8-.6-5.5.1-1.3.6-3.4 1.5-3.2 2.9.1 1 1.8 1.5 2.8 1.4zM420 403.8c-3.6-4-5.3-11.6-7.2-19.7-1.8-8.1-3.9-16.8-10.5-22.4-1.3-1.1-2.6-2.1-4-2.9-1.3-.8-2.7-1.5-4.1-2 9.2-27.3 5.6-54.5-3.7-79.1-11.4-30.1-31.3-56.4-46.5-74.4-17.1-21.5-33.7-41.9-33.4-72C311.1 85.4 315.7.1 234.8 0 132.4-.2 158 103.4 156.9 135.2c-1.7 23.4-6.4 41.8-22.5 64.7-18.9 22.5-45.5 58.8-58.1 96.7-6 17.9-8.8 36.1-6.2 53.3-6.5 5.8-11.4 14.7-16.6 20.2-4.2 4.3-10.3 5.9-17 8.3s-14 6-18.5 14.5c-2.1 3.9-2.8 8.1-2.8 12.4 0 3.9.6 7.9 1.2 11.8 1.2 8.1 2.5 15.7.8 20.8-5.2 14.4-5.9 24.4-2.2 31.7 3.8 7.3 11.4 10.5 20.1 12.3 17.3 3.6 40.8 2.7 59.3 12.5 19.8 10.4 39.9 14.1 55.9 10.4 11.6-2.6 21.1-9.6 25.9-20.2 12.5-.1 26.3-5.4 48.3-6.6 14.9-1.2 33.6 5.3 55.1 4.1.6 2.3 1.4 4.6 2.5 6.7v.1c8.3 16.7 23.8 24.3 40.3 23 16.6-1.3 34.1-11 48.3-27.9 13.6-16.4 36-23.2 50.9-32.2 7.4-4.5 13.4-10.1 13.9-18.3.4-8.2-4.4-17.3-15.5-29.7zM223.7 87.3c9.8-22.2 34.2-21.8 44-.4 6.5 14.2 3.6 30.9-4.3 40.4-1.6-.8-5.9-2.6-12.6-4.9 1.1-1.2 3.1-2.7 3.9-4.6 4.8-11.8-.2-27-9.1-27.3-7.3-.5-13.9 10.8-11.8 23-4.1-2-9.4-3.5-13-4.4-1-6.9-.3-14.6 2.9-21.8zM183 75.8c10.1 0 20.8 14.2 19.1 33.5-3.5 1-7.1 2.5-10.2 4.6 1.2-8.9-3.3-20.1-9.6-19.6-8.4.7-9.8 21.2-1.8 28.1 1 .8 1.9-.2-5.9 5.5-15.6-14.6-10.5-52.1 8.4-52.1zm-13.6 60.7c6.2-4.6 13.6-10 14.1-10.5 4.7-4.4 13.5-14.2 27.9-14.2 7.1 0 15.6 2.3 25.9 8.9 6.3 4.1 11.3 4.4 22.6 9.3 8.4 3.5 13.7 9.7 10.5 18.2-2.6 7.1-11 14.4-22.7 18.1-11.1 3.6-19.8 16-38.2 14.9-3.9-.2-7-1-9.6-2.1-8-3.5-12.2-10.4-20-15-8.6-4.8-13.2-10.4-14.7-15.3-1.4-4.9 0-9 4.2-12.3zm3.3 334c-2.7 35.1-43.9 34.4-75.3 18-29.9-15.8-68.6-6.5-76.5-21.9-2.4-4.7-2.4-12.7 2.6-26.4v-.2c2.4-7.6.6-16-.6-23.9-1.2-7.8-1.8-15 .9-20 3.5-6.7 8.5-9.1 14.8-11.3 10.3-3.7 11.8-3.4 19.6-9.9 5.5-5.7 9.5-12.9 14.3-18 5.1-5.5 10-8.1 17.7-6.9 8.1 1.2 15.1 6.8 21.9 16l19.6 35.6c9.5 19.9 43.1 48.4 41 68.9zm-1.4-25.9c-4.1-6.6-9.6-13.6-14.4-19.6 7.1 0 14.2-2.2 16.7-8.9 2.3-6.2 0-14.9-7.4-24.9-13.5-18.2-38.3-32.5-38.3-32.5-13.5-8.4-21.1-18.7-24.6-29.9s-3-23.3-.3-35.2c5.2-22.9 18.6-45.2 27.2-59.2 2.3-1.7.8 3.2-8.7 20.8-8.5 16.1-24.4 53.3-2.6 82.4.6-20.7 5.5-41.8 13.8-61.5 12-27.4 37.3-74.9 39.3-112.7 1.1.8 4.6 3.2 6.2 4.1 4.6 2.7 8.1 6.7 12.6 10.3 12.4 10 28.5 9.2 42.4 1.2 6.2-3.5 11.2-7.5 15.9-9 9.9-3.1 17.8-8.6 22.3-15 7.7 30.4 25.7 74.3 37.2 95.7 6.1 11.4 18.3 35.5 23.6 64.6 3.3-.1 7 .4 10.9 1.4 13.8-35.7-11.7-74.2-23.3-84.9-4.7-4.6-4.9-6.6-2.6-6.5 12.6 11.2 29.2 33.7 35.2 59 2.8 11.6 3.3 23.7.4 35.7 16.4 6.8 35.9 17.9 30.7 34.8-2.2-.1-3.2 0-4.2 0 3.2-10.1-3.9-17.6-22.8-26.1-19.6-8.6-36-8.6-38.3 12.5-12.1 4.2-18.3 14.7-21.4 27.3-2.8 11.2-3.6 24.7-4.4 39.9-.5 7.7-3.6 18-6.8 29-32.1 22.9-76.7 32.9-114.3 7.2zm257.4-11.5c-.9 16.8-41.2 19.9-63.2 46.5-13.2 15.7-29.4 24.4-43.6 25.5s-26.5-4.8-33.7-19.3c-4.7-11.1-2.4-23.1 1.1-36.3 3.7-14.2 9.2-28.8 9.9-40.6.8-15.2 1.7-28.5 4.2-38.7 2.6-10.3 6.6-17.2 13.7-21.1.3-.2.7-.3 1-.5.8 13.2 7.3 26.6 18.8 29.5 12.6 3.3 30.7-7.5 38.4-16.3 9-.3 15.7-.9 22.6 5.1 9.9 8.5 7.1 30.3 17.1 41.6 10.6 11.6 14 19.5 13.7 24.6zM173.3 148.7c2 1.9 4.7 4.5 8 7.1 6.6 5.2 15.8 10.6 27.3 10.6 11.6 0 22.5-5.9 31.8-10.8 4.9-2.6 10.9-7 14.8-10.4s5.9-6.3 3.1-6.6-2.6 2.6-6 5.1c-4.4 3.2-9.7 7.4-13.9 9.8-7.4 4.2-19.5 10.2-29.9 10.2s-18.7-4.8-24.9-9.7c-3.1-2.5-5.7-5-7.7-6.9-1.5-1.4-1.9-4.6-4.3-4.9-1.4-.1-1.8 3.7 1.7 6.5z',
    opticalShift: 0,
  },
  harmonyos: {
    viewBox: '1.003 -1.5002 21.994 27.0003',
    path: 'M1.861 0H3.59v3.548h3.861V0H9.19v8.883H7.458V5.136H3.59v3.746H1.858Zm8.248 8.883ZM13.854 0h1.706l2.809 4.7h.1L21.278 0h1.719v8.883h-1.719v-4.38l.1-1.489h-.1l-2.334 3.983h-1.039l-2.347-3.983h-.1l.1 1.489v4.38h-1.706Zm4.702 21.648a4.082 4.082 0 0 1-1.154-.161 3.417 3.417 0 0 1-1.01-.484 3.5 3.5 0 0 1-.8-.782 3.817 3.817 0 0 1-.538-1.092l1.666-.62a2.411 2.411 0 0 0 .643 1.116 1.683 1.683 0 0 0 1.207.434 2.173 2.173 0 0 0 .524-.062 1.749 1.749 0 0 0 .459-.2 1.02 1.02 0 0 0 .328-.335.88.88 0 0 0 .118-.459 1.052 1.052 0 0 0-.092-.447 1.031 1.031 0 0 0-.315-.373 2.538 2.538 0 0 0-.564-.335 8.135 8.135 0 0 0-.852-.335l-.577-.2a4.753 4.753 0 0 1-.774-.335 3.44 3.44 0 0 1-.7-.509 2.662 2.662 0 0 1-.525-.695 2.093 2.093 0 0 1-.2-.918 2.248 2.248 0 0 1 .21-.968 2.433 2.433 0 0 1 .616-.794 2.87 2.87 0 0 1 .957-.533 3.726 3.726 0 0 1 1.246-.2 3.57 3.57 0 0 1 1.22.186 2.783 2.783 0 0 1 .879.459 2.468 2.468 0 0 1 .59.608 2.9 2.9 0 0 1 .328.633l-1.56.62a1.55 1.55 0 0 0-.485-.67 1.387 1.387 0 0 0-.944-.3 1.655 1.655 0 0 0-.957.261.754.754 0 0 0-.38.658.843.843 0 0 0 .367.682 4.232 4.232 0 0 0 1.167.534l.59.186a6.271 6.271 0 0 1 1.023.434 2.948 2.948 0 0 1 .8.57 2.191 2.191 0 0 1 .511.769 2.44 2.44 0 0 1 .183.98 2.317 2.317 0 0 1-.3 1.2 2.559 2.559 0 0 1-.747.819 3.361 3.361 0 0 1-1.036.484 4.184 4.184 0 0 1-1.128.161Zm-13.028 0a4.441 4.441 0 0 1-3.23-1.34 4.757 4.757 0 0 1-.956-1.476 4.912 4.912 0 0 1-.339-1.824 4.813 4.813 0 0 1 .339-1.811 4.569 4.569 0 0 1 .956-1.477 4.38 4.38 0 0 1 1.427-.992 4.5 4.5 0 0 1 1.8-.36 4.417 4.417 0 0 1 1.79.36 4.343 4.343 0 0 1 1.44.992 4.418 4.418 0 0 1 .944 1.477 4.67 4.67 0 0 1 .351 1.811 4.765 4.765 0 0 1-.351 1.824 4.589 4.589 0 0 1-.944 1.476 4.495 4.495 0 0 1-3.23 1.34Zm0-1.588a2.822 2.822 0 0 0 1.125-.223 2.761 2.761 0 0 0 .92-.621 2.723 2.723 0 0 0 .617-.955 3.321 3.321 0 0 0 .23-1.253 3.227 3.227 0 0 0-.23-1.24 2.7 2.7 0 0 0-.617-.968 2.759 2.759 0 0 0-.92-.62 2.821 2.821 0 0 0-1.125-.223 2.856 2.856 0 0 0-2.057.844 2.946 2.946 0 0 0-.617.968 3.388 3.388 0 0 0-.218 1.24 3.488 3.488 0 0 0 .218 1.253 2.972 2.972 0 0 0 .617.955 2.856 2.856 0 0 0 2.057.843Zm4.972 1.389Zm-8.269 1.039h6.5V24h-6.5Z',
    opticalShift: 0,
  },
  server: {
    viewBox: '0 -2.7315 24 29.4629',
    path: 'M1.5 0H22.5A1.5 1.5 0 0 1 24 1.5V4.5A1.5 1.5 0 0 1 22.5 6H1.5A1.5 1.5 0 0 1 0 4.5V1.5A1.5 1.5 0 0 1 1.5 0ZM20.1 3A1.5 1.5 0 0 0 17.1 3A1.5 1.5 0 0 0 20.1 3ZM1.5 9H22.5A1.5 1.5 0 0 1 24 10.5V13.5A1.5 1.5 0 0 1 22.5 15H1.5A1.5 1.5 0 0 1 0 13.5V10.5A1.5 1.5 0 0 1 1.5 9ZM20.1 12A1.5 1.5 0 0 0 17.1 12A1.5 1.5 0 0 0 20.1 12ZM1.5 18H22.5A1.5 1.5 0 0 1 24 19.5V22.5A1.5 1.5 0 0 1 22.5 24H1.5A1.5 1.5 0 0 1 0 22.5V19.5A1.5 1.5 0 0 1 1.5 18ZM20.1 21A1.5 1.5 0 0 0 17.1 21A1.5 1.5 0 0 0 20.1 21Z',
    opticalShift: 0,
  },
};


/**
 * The system an os string names, or null when it cannot be placed.
 *
 * Hosts report `macOS`, `Windows`, `Linux` and `HarmonyOS`, but the same field is
 * filled in by any client and by older Relays, so the match stays tolerant about
 * casing and spelling. A system we cannot place answers null rather than a
 * plausible guess, and each caller keeps the neutral mark it already drew.
 */
export function deviceSystemKeyFromOs(os: string | null | undefined): DeviceSystemKey | null {
  const value = os?.trim().toLowerCase() ?? '';
  if (!value) return null;
  if (value.includes('harmony') || value.includes('ohos')) return 'harmonyos';
  if (value.startsWith('win') || value.includes('windows')) return 'windows';
  if (value.includes('mac') || value.includes('darwin') || value.includes('osx')) return 'macos';
  if (value.includes('linux')) return 'linux';
  return null;
}
