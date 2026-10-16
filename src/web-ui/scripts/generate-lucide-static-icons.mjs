import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChevronDown, Copy, Minus, Search, Square, X } from 'lucide-react';
import * as lucide from 'lucide-react';
import { themes } from '@openbitfun/theme-openbitfun';

// Pre-React chrome and native form decorations cannot mount React components.
// Generate their SVG from the same installed Lucide version as the application.
const check = process.argv.includes('--check');
const root = new URL('../', import.meta.url);
const glyphs = [Minus, Minus, Square, Copy, Square, Copy, X, X];

function svg(glyph, props = {}) {
  return renderToStaticMarkup(createElement(glyph, { 'aria-hidden': true, ...props }));
}

async function update(relative, transform) {
  const file = new URL(relative, root);
  const before = await readFile(file, 'utf8');
  const after = transform(before);
  if (before === after) return;
  if (check) throw new Error(`Lucide static icons are stale: ${fileURLToPath(file)}`);
  await writeFile(file, after);
}

await update('index.html', source => {
  let index = 0;
  const result = source.replace(/<svg\b[^>]*data-startup-window-control-platform=[\s\S]*?<\/svg>/g, original => {
    const opening = original.slice(0, original.indexOf('>'));
    const attrs = Object.fromEntries([...opening.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
    const glyph = glyphs[index++];
    if (!glyph) throw new Error('Unexpected startup window icon');
    return svg(glyph, {
      width: attrs.width,
      height: attrs.height,
      'data-startup-window-control-platform': attrs['data-startup-window-control-platform'],
      ...(attrs['data-startup-window-control-state'] ? { 'data-startup-window-control-state': attrs['data-startup-window-control-state'] } : {}),
      ...(attrs.style ? { style: { display: 'none' } } : {}),
    });
  });
  if (index !== glyphs.length) throw new Error(`Expected ${glyphs.length} startup window icons, found ${index}`);
  return result;
});

await update('src/app/styles/components/forms.css', source => {
  const dataUrl = glyph => `url("data:image/svg+xml,${encodeURIComponent(glyph).replaceAll("'", '%27')}")`;
  // The legacy native select has a fixed decoration; source its color from the theme.
  // Search uses a mask and inherits the active theme at runtime.
  const chevron = dataUrl(svg(ChevronDown, { color: themes.light['color.content.muted'] }));
  const search = dataUrl(svg(Search));
  let count = 0;
  const result = source.replace(/url\("data:image\/svg\+xml[^\n]*?"\)/g, () => count++ === 0 ? chevron : search);
  if (count !== 3) throw new Error(`Expected three native form icon declarations, found ${count}`);
  return result;
});

const miniAppIcons = {
  app: 'Box', return: 'PictureInPicture', popout: 'SquareArrowOutUpRight', minimize: 'Minus', maximize: 'Square', restore: 'Copy', close: 'X',
  download: 'Download', save: 'Save', search: 'Search', settings: 'Settings', refresh: 'RefreshCw', plus: 'Plus', play: 'Play', stop: 'Square', check: 'Check', share: 'Share2', help: 'CircleHelp', send: 'ArrowUp', suggestion: 'ArrowUpRight',
};
for (const name of ['Aperture','Box','Bot','Code','Database','FileText','GitPullRequest','Grid3x3','LayoutGrid','Presentation','Regex','Rocket','Workflow','Wrench','AppWindow','Globe','Image','Settings','Sparkles','Terminal']) {
  miniAppIcons[name] = name;
  miniAppIcons[name.replace(/[A-Z]/g, (letter, index) => (index ? '-' : '') + letter.toLowerCase())] = name;
}
await update('../shared/miniapp-chrome/icons.generated.json', () => JSON.stringify(Object.fromEntries(
  Object.entries(miniAppIcons).map(([key, name]) => [key, svg(lucide[name])]),
), null, 2) + '\n');

const localeContract = JSON.parse(await readFile(new URL('../shared/i18n/contract/locales.json', root), 'utf8'));
const windowLabels = { aliases: {}, fallbackLocale: localeContract.fallbackLocale };
const presentationLabels = {};
for (const { id: locale, aliases } of localeContract.locales) {
  for (const alias of aliases) windowLabels.aliases[alias.toLowerCase()] = locale;
  const terms = JSON.parse(await readFile(new URL(`../shared/i18n/resources/shared/${locale}/terms.json`, root), 'utf8'));
  windowLabels[locale] = terms.window;
  const miniapp = JSON.parse(await readFile(new URL(`src/locales/${locale}/scenes/miniapp.json`, root), 'utf8'));
  presentationLabels[locale] = miniapp.presentation;
}
await update('../shared/miniapp-chrome/labels.generated.json', () => JSON.stringify(windowLabels, null, 2) + '\n');
await update('../shared/miniapp-chrome/presentation-labels.generated.json', () => JSON.stringify(presentationLabels, null, 2) + '\n');

console.log(`Lucide static icons ${check ? 'verified' : 'generated'}.`);
