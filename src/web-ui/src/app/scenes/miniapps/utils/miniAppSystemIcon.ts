import { renderToStaticMarkup } from 'react-dom/server';
import { renderMiniAppIcon } from './miniAppIcons';

/** Export the catalog glyph only. The native adapter owns background and brand watermark. */
export function renderMiniAppSystemIcon(icon: string): string | undefined {
  const markup = renderToStaticMarkup(renderMiniAppIcon(icon, 24));
  return markup.match(/<svg\b[\s\S]*?<\/svg>/)?.[0]
    .replace(/currentColor/g, 'white')
    .replace(/\s(?:class|style)="[^"]*"/g, '');
}
