import { createLucideIcon } from 'lucide-react';

// Lucide cloud-cog outline with the branch layout from assets/git.svg and solid nodes.
export const CloudGit = createLucideIcon('CloudGit', [
  ['path', { d: 'M4.2 15.1a7 7 0 1 1 9.93-9.858A7 7 0 0 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.2', key: 'cloud' }],
  ['path', { d: 'M9 13v7', key: 'branch-main' }],
  ['path', { d: 'M15 13v2.5a1 1 0 0 1-1 1h-4a1 1 0 0 0-1 1', key: 'branch-fork' }],
  ['circle', { cx: '9', cy: '13', r: '1.5', fill: 'currentColor', stroke: 'none', key: 'branch-top' }],
  ['circle', { cx: '9', cy: '20', r: '1.5', fill: 'currentColor', stroke: 'none', key: 'branch-bottom' }],
  ['circle', { cx: '15', cy: '13', r: '1.5', fill: 'currentColor', stroke: 'none', key: 'branch-tip' }],
]);
