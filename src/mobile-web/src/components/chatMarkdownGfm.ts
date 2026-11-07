import type { Options } from 'remark-gfm';

/**
 * Chat prose uses single tildes for ranges (`~5 min`, `1~3`); only paired
 * double tildes strike text. Keep aligned with the desktop chat renderer so a
 * remote-controlled transcript reads the same on both surfaces.
 */
export const chatMarkdownGfmOptions: Options = { singleTilde: false };
