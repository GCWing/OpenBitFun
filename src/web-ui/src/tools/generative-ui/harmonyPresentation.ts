import type { GenUIAppDefinition, GenUIAppEnvelope } from './genUITypes';

export function harmonyPresentation(app: GenUIAppDefinition | GenUIAppEnvelope) {
  const source = 'source' in app && app.source ? app.source.kind === 'openui-lang' ? app.source.content : `${app.source.html} ${app.source.css ?? ''}` : '';
  const text = `${app.title} ${'description' in app ? app.description ?? '' : ''} ${source}`.toLowerCase();
  const themes: Array<[string, RegExp]> = [
    ['orange', /orange|food|cook|recipe|energy|餐|食|烹饪|橙/],
    ['green', /green|health|fitness|workout|plant|nature|health|健康|运动|植物|绿色/],
    ['indigo', /indigo|study|reading|book|plan|course|学习|阅读|计划|靛/],
    ['purple', /purple|music|creative|night|art|音乐|创意|夜|紫/],
    ['rose', /rose|beauty|gift|celebration|美妆|礼物|庆祝|玫瑰/],
    ['teal', /teal|water|travel|weather|calm|旅行|天气|水|青绿/],
    ['brown', /brown|coffee|baking|wood|history|咖啡|烘焙|历史|棕/],
    ['ink', /ink|minimal|editorial|fashion|serious|极简|编辑|时尚|墨/],
  ];
  const theme = themes.find(([, pattern]) => pattern.test(text))?.[0] ?? 'blue';
  const font = /journal|diary|personal|手账|日记/.test(text) ? 'handwritten' : /book|reading|history|paper|calligraphy|书|阅读|历史/.test(text) ? 'serif' : /code|technical|developer|tech|代码|技术/.test(text) ? 'tech' : 'sans';
  const scheme = /dark|cinema|film|movie|astronomy|night|music player|game|电影|影院|夜空|播放器|游戏|深色/.test(text) ? 'dark' : 'light';
  return { theme, font, scheme } as const;
}
