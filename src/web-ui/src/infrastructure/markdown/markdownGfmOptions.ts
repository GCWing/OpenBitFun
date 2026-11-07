import type { Options } from 'remark-gfm';

/** Chat prose uses single tildes for ranges; only paired double tildes strike text. */
export const markdownGfmOptions: Options = { singleTilde: false };
