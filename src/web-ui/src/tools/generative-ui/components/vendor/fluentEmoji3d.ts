import index from './fluent-emoji-3d-index.json';

const EMOJI_CDN_REVISION = index.sha;
const EMOJI_ASSET_ROOT = `https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@${EMOJI_CDN_REVISION}/assets/`;
const EMOJI_ASSETS: Record<string, string> = index.icons;

export const FLUENT_EMOJI_3D_CSP_SOURCE = EMOJI_ASSET_ROOT;

export function fluentEmoji3dUrl(emoji: string): string | undefined {
  const key = Array.from(emoji.trim())
    .filter(character => character.codePointAt(0) !== 0xfe0f)
    .map(character => (character.codePointAt(0) ?? 0).toString(16))
    .join('-');
  const path = EMOJI_ASSETS[key];
  return path ? EMOJI_ASSET_ROOT + path.split('/').map(encodeURIComponent).join('/') : undefined;
}
