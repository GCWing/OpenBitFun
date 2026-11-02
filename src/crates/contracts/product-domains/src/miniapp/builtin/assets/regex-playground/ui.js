// Regex Playground — built-in MiniApp.
// Real-time matching, capture groups, replace preview, and a quick pattern library.
//
// i18n: each library item / cheatsheet line / status pill / placeholder uses a
// language-aware lookup table. Patterns / flags themselves are universal.

const PATTERN_KEYS = [
  { id: 'email',    pattern: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", flags: 'g' },
  { id: 'mobileCN', pattern: "(?<!\\d)1[3-9]\\d{9}(?!\\d)", flags: 'g' },
  { id: 'url',      pattern: "https?:\\/\\/[\\w\\-._~:\\/?#\\[\\]@!$&'()*+,;=%]+", flags: 'gi' },
  { id: 'ipv4',     pattern: "\\b(?:(?:25[0-5]|2[0-4]\\d|[01]?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|[01]?\\d?\\d)\\b", flags: 'g' },
  { id: 'ipv6',     pattern: "([0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}", flags: 'g' },
  { id: 'uuid',     pattern: "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", flags: 'gi' },
  { id: 'hexColor', pattern: "#(?:[0-9a-fA-F]{3}){1,2}\\b", flags: 'g' },
  { id: 'dateYmd',  pattern: "\\b(\\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])\\b", flags: 'g' },
  { id: 'timeHms',  pattern: "\\b([01]?\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?\\b", flags: 'g' },
  { id: 'semver',   pattern: "\\b\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?\\b", flags: 'g' },
  { id: 'gitSha',   pattern: "\\b[0-9a-f]{7,40}\\b", flags: 'g' },
  { id: 'camel',    pattern: "\\b[a-z]+(?:[A-Z][a-z0-9]*)+\\b", flags: 'g' },
  { id: 'cjk',      pattern: "[\\u4e00-\\u9fa5]+", flags: 'g' },
  { id: 'trim',     pattern: "^[ \\t]+|[ \\t]+$", flags: 'gm' },
  { id: 'lineCmt',  pattern: "^\\s*\\/\\/.*$", flags: 'gm' },
];

// Sample text is intentionally locale-agnostic (English) so it doesn't flip
// when users switch UI language — the textarea is meant to be a regex playground
// scratchpad, not a piece of localized copy.
const SAMPLE_TEXT = `# Paste any text here — matches highlight in real time.

Contact: alice@example.com / 13800138000
Project: https://github.com/GCWing/OpenBitFun
Internal IP: 192.168.1.10 and 10.0.0.1
Trace ID: 8f2c3a01-4e6b-4d1c-9bb1-1f3a6d2c0a55
Releasing v1.4.0-beta.2, commit 7a3f9d2

// TODO: Extract the block above into a utility function
const userName = "OpenBitFun";
`;

const I18N = {
  'zh-CN': {
    title: '正则游乐场',
    subtitle: 'RegExp 实时调试 · ECMAScript 风格',
    flagG: '全局匹配 (global)',
    flagI: '忽略大小写 (ignore case)',
    flagM: '多行模式 (multiline)',
    flagS: 'dotAll · . 匹配换行',
    flagU: 'Unicode 模式',
    flagY: '粘连匹配 (sticky)',
    testText: '测试文本',
    testPlaceholder: '把要匹配的文本粘贴到这里…',
    clear: '清空',
    matchesTitle: '匹配明细',
    matchesEmpty: '输入正则与文本，匹配结果将在这里展示。',
    prevMatch: '上一处',
    nextMatch: '下一处',
    replaceTitle: '替换预览',
    replaceHint: '支持 $1 $2 $<name> 反向引用',
    replacePlaceholder: '替换为…（留空则不展示预览）',
    library: '常用模式',
    cheatsheet: '速查',
    statusReady: '就绪',
    statusError: '语法错误',
    statusNoMatch: '无匹配',
    statusHits: (n) => `命中 ${n} 处`,
    matchCount: (n) => `${n} 处匹配`,
    matchCountInvalid: '— 处匹配',
    summaryWaiting: '尚未匹配',
    summaryNoMatch: '无匹配',
    summaryWithGroups: (n, g) => `${n} 处 · ${g} 个分组`,
    summaryNoGroups: (n) => `${n} 处`,
    matchEmpty: '空匹配（零宽）',
    matchGroupEmpty: '(空)',
    matchGroupCount: (n) => `${n} 组`,
    syntaxError: '正则语法错误',
    noMatchHint: '没有匹配项。试着调整正则或测试文本。',
    replaceFailed: (msg) => `[替换失败] ${msg}`,
    libNames: {
      email: '邮箱地址',
      mobileCN: '中国大陆手机号',
      url: 'URL（http/https）',
      ipv4: 'IPv4 地址',
      ipv6: 'IPv6 地址（简化）',
      uuid: 'UUID v4',
      hexColor: '十六进制颜色',
      dateYmd: '日期 YYYY-MM-DD',
      timeHms: '时间 HH:MM(:SS)',
      semver: 'Semver 版本号',
      gitSha: 'Git 短 SHA',
      camel: '驼峰标识符',
      cjk: '中文字符',
      trim: '前后空白',
      lineCmt: '行首注释 //',
    },
    cheatsheet_lines: [
      ['\\d', '数字 ·'], ['\\D', '非数字'],
      ['\\w', '字母数字下划线 ·'], ['\\W', '反之'],
      ['\\s', '空白 ·'], ['\\S', '非空白'],
      ['^ $', '行首/行尾（配合 m）'],
      ['(?:…)', '非捕获 ·'], ['(?<n>…)', '命名捕获'],
      ['(?=…)', '正向先行 ·'], ['(?!…)', '反向先行'],
      ['{n,m}', '区间量词 ·'], ['?', '非贪婪'],
    ],
    cheatsheet_grouped: [
      ['<code>\\d</code> 数字 · <code>\\D</code> 非数字'],
      ['<code>\\w</code> 字母数字下划线 · <code>\\W</code> 反之'],
      ['<code>\\s</code> 空白 · <code>\\S</code> 非空白'],
      ['<code>^ $</code> 行首/行尾（配合 m）'],
      ['<code>(?:…)</code> 非捕获 · <code>(?&lt;n&gt;…)</code> 命名捕获'],
      ['<code>(?=…)</code> 正向先行 · <code>(?!…)</code> 反向先行'],
      ['<code>{n,m}</code> 区间量词 · <code>?</code> 非贪婪'],
    ],
  },
  'zh-TW': {
    title: '正則遊樂場',
    subtitle: 'RegExp 實時調試 · ECMAScript 風格',
    flagG: '全局匹配 (global)',
    flagI: '忽略大小寫 (ignore case)',
    flagM: '多行模式 (multiline)',
    flagS: 'dotAll · . 匹配換行',
    flagU: 'Unicode 模式',
    flagY: '粘連匹配 (sticky)',
    testText: '測試文本',
    testPlaceholder: '把要匹配的文本粘貼到這裡…',
    clear: '清空',
    matchesTitle: '匹配明細',
    matchesEmpty: '輸入正則與文本，匹配結果將在這裡展示。',
    prevMatch: '上一處',
    nextMatch: '下一處',
    replaceTitle: '替換預覽',
    replaceHint: '支持 $1 $2 $<name> 反向引用',
    replacePlaceholder: '替換為…（留空則不展示預覽）',
    library: '常用模式',
    cheatsheet: '速查',
    statusReady: '就緒',
    statusError: '語法錯誤',
    statusNoMatch: '無匹配',
    statusHits: (n) => `命中 ${n} 處`,
    matchCount: (n) => `${n} 處匹配`,
    matchCountInvalid: '— 處匹配',
    summaryWaiting: '尚未匹配',
    summaryNoMatch: '無匹配',
    summaryWithGroups: (n, g) => `${n} 處 · ${g} 個分組`,
    summaryNoGroups: (n) => `${n} 處`,
    matchEmpty: '空匹配（零寬）',
    matchGroupEmpty: '(空)',
    matchGroupCount: (n) => `${n} 組`,
    syntaxError: '正則語法錯誤',
    noMatchHint: '沒有匹配項。試著調整正則或測試文本。',
    replaceFailed: (msg) => `[替換失敗] ${msg}`,
    libNames: {
      email: '郵箱地址',
      mobileCN: '中國大陸手機號',
      url: 'URL（http/https）',
      ipv4: 'IPv4 地址',
      ipv6: 'IPv6 地址（簡化）',
      uuid: 'UUID v4',
      hexColor: '十六進制顏色',
      dateYmd: '日期 YYYY-MM-DD',
      timeHms: '時間 HH:MM(:SS)',
      semver: 'Semver 版本號',
      gitSha: 'Git 短 SHA',
      camel: '駝峰標識符',
      cjk: '中文字符',
      trim: '前後空白',
      lineCmt: '行首註釋 //',
    },
    cheatsheet_lines: [
      ['\\d', '數字 ·'], ['\\D', '非數字'],
      ['\\w', '字母數字下劃線 ·'], ['\\W', '反之'],
      ['\\s', '空白 ·'], ['\\S', '非空白'],
      ['^ $', '行首/行尾（配合 m）'],
      ['(?:…)', '非捕獲 ·'], ['(?<n>…)', '命名捕獲'],
      ['(?=…)', '正向先行 ·'], ['(?!…)', '反向先行'],
      ['{n,m}', '區間量詞 ·'], ['?', '非貪婪'],
    ],
    cheatsheet_grouped: [
      ['<code>\\d</code> 數字 · <code>\\D</code> 非數字'],
      ['<code>\\w</code> 字母數字下劃線 · <code>\\W</code> 反之'],
      ['<code>\\s</code> 空白 · <code>\\S</code> 非空白'],
      ['<code>^ $</code> 行首/行尾（配合 m）'],
      ['<code>(?:…)</code> 非捕獲 · <code>(?&lt;n&gt;…)</code> 命名捕獲'],
      ['<code>(?=…)</code> 正向先行 · <code>(?!…)</code> 反向先行'],
      ['<code>{n,m}</code> 區間量詞 · <code>?</code> 非貪婪'],
    ],
  },

  'en-US': {
    title: 'Regex Playground',
    subtitle: 'Live RegExp debugger · ECMAScript flavour',
    flagG: 'Global match (g)',
    flagI: 'Ignore case (i)',
    flagM: 'Multiline (m)',
    flagS: 'dotAll — . matches newlines (s)',
    flagU: 'Unicode mode (u)',
    flagY: 'Sticky match (y)',
    testText: 'Test text',
    testPlaceholder: 'Paste the text you want to match here…',
    clear: 'Clear',
    matchesTitle: 'Match details',
    matchesEmpty: 'Enter a regex and some text to see matches here.',
    prevMatch: 'Previous',
    nextMatch: 'Next',
    replaceTitle: 'Replace preview',
    replaceHint: 'Supports $1 $2 $<name> back-references',
    replacePlaceholder: 'Replacement string… (empty hides the preview)',
    library: 'Pattern library',
    cheatsheet: 'Cheatsheet',
    statusReady: 'Ready',
    statusError: 'Syntax error',
    statusNoMatch: 'No match',
    statusHits: (n) => `${n} match${n === 1 ? '' : 'es'}`,
    matchCount: (n) => `${n} match${n === 1 ? '' : 'es'}`,
    matchCountInvalid: '— matches',
    summaryWaiting: 'Waiting for input',
    summaryNoMatch: 'No match',
    summaryWithGroups: (n, g) => `${n} match${n === 1 ? '' : 'es'} · ${g} group${g === 1 ? '' : 's'}`,
    summaryNoGroups: (n) => `${n} match${n === 1 ? '' : 'es'}`,
    matchEmpty: 'Empty match (zero-width)',
    matchGroupEmpty: '(empty)',
    matchGroupCount: (n) => `${n} group${n === 1 ? '' : 's'}`,
    syntaxError: 'Regex syntax error',
    noMatchHint: 'No matches. Try adjusting the regex or the test text.',
    replaceFailed: (msg) => `[Replace failed] ${msg}`,
    libNames: {
      email: 'Email address',
      mobileCN: 'China mobile number',
      url: 'URL (http/https)',
      ipv4: 'IPv4 address',
      ipv6: 'IPv6 (loose)',
      uuid: 'UUID v4',
      hexColor: 'Hex color',
      dateYmd: 'Date YYYY-MM-DD',
      timeHms: 'Time HH:MM(:SS)',
      semver: 'Semver version',
      gitSha: 'Git short SHA',
      camel: 'camelCase identifier',
      cjk: 'CJK characters',
      trim: 'Leading/trailing spaces',
      lineCmt: 'Line comment //',
    },
    cheatsheet_grouped: [
      ['<code>\\d</code> digit · <code>\\D</code> non-digit'],
      ['<code>\\w</code> word char · <code>\\W</code> non-word'],
      ['<code>\\s</code> whitespace · <code>\\S</code> non-whitespace'],
      ['<code>^ $</code> start/end of line (with m)'],
      ['<code>(?:…)</code> non-capturing · <code>(?&lt;n&gt;…)</code> named group'],
      ['<code>(?=…)</code> lookahead · <code>(?!…)</code> negative lookahead'],
      ['<code>{n,m}</code> range quantifier · <code>?</code> lazy'],
    ],
  },
};

function currentLocale() {
  return (window.app && window.app.locale) || 'en-US';
}

function ui(key) {
  const lang = currentLocale();
  const table = I18N[lang] || I18N['en-US'];
  return table[key];
}

// ── DOM ──────────────────────────────────────────────
const dom = {
  pattern: document.getElementById('pattern'),
  flagsRow: document.getElementById('flags'),
  patternError: document.getElementById('pattern-error'),
  testText: document.getElementById('test-text'),
  highlight: document.getElementById('highlight'),
  matchCount: document.getElementById('match-count'),
  btnClear: document.getElementById('btn-clear'),
  matches: document.getElementById('matches'),
  matchesSummary: document.getElementById('matches-summary'),
  btnPrevMatch: document.getElementById('btn-prev-match'),
  btnNextMatch: document.getElementById('btn-next-match'),
  library: document.getElementById('library'),
  replaceInput: document.getElementById('replace-input'),
  replaceOutput: document.getElementById('replace-output'),
  statusPill: document.getElementById('status-pill'),
};

let lastMatches = [];

const state = {
  flags: new Set(['g', 'm']),
  activeMatchIndex: -1,
};

// ── Init ─────────────────────────────────────────────
async function init() {
  if (dom.statusPill) dom.statusPill.textContent = ui('statusReady');
  applyStaticI18n();
  buildLibrary();
  buildCheatsheet();
  bindFlags();
  bindEditorSync();
  await restore();
  bindPersistence();
  recompute();
  exposeAgentControls();
  if (window.app && typeof window.app.onLocaleChange === 'function') {
    window.app.onLocaleChange(() => {
      applyStaticI18n();
      buildLibrary();
      buildCheatsheet();
      recompute();
    });
  }
}

function applyStaticI18n() {
  document.documentElement.setAttribute('lang', currentLocale());
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const key = node.getAttribute('data-i18n');
    const attr = node.getAttribute('data-i18n-attr');
    const value = ui(key);
    if (typeof value !== 'string') return;
    if (attr) node.setAttribute(attr, value);
    else node.textContent = value;
  });
  if (dom && dom.statusPill && dom.statusPill.classList.contains('status--ok') && dom.statusPill.textContent === '就绪') {
    dom.statusPill.textContent = ui('statusReady');
  }
}

function buildLibrary() {
  dom.library.innerHTML = '';
  const names = ui('libNames') || {};
  for (const item of PATTERN_KEYS) {
    const el = document.createElement('div');
    el.className = 'lib-item';
    const displayName = names[item.id] || item.id;
    el.innerHTML = `
      <div class="lib-item__name">${escapeHtml(displayName)}</div>
      <div class="lib-item__pattern">/${escapeHtml(item.pattern)}/${escapeHtml(item.flags)}</div>
    `;
    el.addEventListener('click', () => {
      applyPattern(item.id);
      dom.pattern.focus();
    });
    dom.library.appendChild(el);
  }
}

function buildCheatsheet() {
  const list = document.getElementById('ref-list');
  if (!list) return;
  const lines = ui('cheatsheet_grouped') || [];
  list.innerHTML = lines.map((row) => `<li>${row[0]}</li>`).join('');
}

function bindFlags() {
  syncFlagsUi();
  dom.flagsRow.addEventListener('click', (e) => {
    const btn = e.target.closest('.flag');
    if (!btn) return;
    const f = btn.dataset.flag;
    const flags = new Set(state.flags);
    if (flags.has(f)) flags.delete(f); else flags.add(f);
    updateInputs({ flags: Array.from(flags).join('') });
  });
}

function syncFlagsUi() {
  for (const btn of dom.flagsRow.querySelectorAll('.flag')) {
    btn.classList.toggle('is-active', state.flags.has(btn.dataset.flag));
  }
}

function bindEditorSync() {
  // Sync scroll between textarea and the highlight overlay.
  dom.testText.addEventListener('scroll', () => {
    dom.highlight.scrollTop = dom.testText.scrollTop;
    dom.highlight.scrollLeft = dom.testText.scrollLeft;
  });
  dom.testText.addEventListener('input', () => updateInputs({ text: dom.testText.value }));
  dom.pattern.addEventListener('input', () => updateInputs({ pattern: dom.pattern.value }));
  dom.replaceInput.addEventListener('input', () => updateInputs({ replacement: dom.replaceInput.value }));
  dom.btnClear.addEventListener('click', () => {
    updateInputs({ text: '' });
    dom.testText.focus();
  });
  dom.btnPrevMatch.addEventListener('click', () => stepActiveMatch(-1));
  dom.btnNextMatch.addEventListener('click', () => stepActiveMatch(1));
}

function stepActiveMatch(delta) {
  if (lastMatches.length === 0) return;
  const next = state.activeMatchIndex < 0
    ? (delta > 0 ? 0 : lastMatches.length - 1)
    : (state.activeMatchIndex + delta + lastMatches.length) % lastMatches.length;
  selectMatch(next, true);
}

async function restore() {
  let saved = null;
  try { saved = await app.storage.get('regex-state'); } catch (_e) { /* ignore */ }
  if (saved && typeof saved === 'object') {
    dom.pattern.value = typeof saved.pattern === 'string' ? saved.pattern : '';
    if (typeof saved.text === 'string') dom.testText.value = saved.text;
    if (typeof saved.replacement === 'string') dom.replaceInput.value = saved.replacement;
    if (Array.isArray(saved.flags)) state.flags = new Set(saved.flags);
    syncFlagsUi();
  }
  if (typeof saved?.pattern !== 'string') dom.pattern.value = "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}";
  if (typeof saved?.text !== 'string') {
    dom.testText.value = SAMPLE_TEXT;
  }
}

let saveInputs = () => {};

function bindPersistence() {
  saveInputs = debounce(() => {
    app.storage.set('regex-state', {
      pattern: dom.pattern.value,
      text: dom.testText.value,
      replacement: dom.replaceInput.value,
      flags: Array.from(state.flags),
    }).catch(() => {});
  }, 350);
}

// UI and Agent operations share the live fields and the same recompute/save
// path. Omitted fields are untouched, including text not yet persisted.
function updateInputs(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('input must be an object');
  }
  for (const key of Object.keys(patch)) {
    if (!['pattern', 'text', 'replacement', 'flags'].includes(key) || typeof patch[key] !== 'string') {
      throw new Error('input accepts only string pattern, text, replacement, and flags fields');
    }
  }
  if (patch.flags !== undefined && (!/^[gimsuy]*$/.test(patch.flags) || new Set(patch.flags).size !== patch.flags.length)) {
    throw new Error('flags must contain unique supported flags: g i m s u y');
  }
  // Validate the entire patch before making any changes. A malformed regex is
  // an editable draft, so recompute reports its syntax error normally.
  if (patch.pattern !== undefined) dom.pattern.value = patch.pattern;
  if (patch.text !== undefined) dom.testText.value = patch.text;
  if (patch.replacement !== undefined) dom.replaceInput.value = patch.replacement;
  if (patch.flags !== undefined) {
    state.flags = new Set(patch.flags);
    syncFlagsUi();
  }
  if (Object.keys(patch).some((key) => key !== 'replacement')) recompute();
  else renderReplace();
  saveInputs();
}

function applyPattern(id) {
  const item = PATTERN_KEYS.find((entry) => entry.id === id);
  if (!item) throw new Error('Unknown pattern id');
  updateInputs({ pattern: item.pattern, flags: item.flags });
}

// Bound every variable-length field, including escaped JSON and non-ASCII
// input. Length/truncated facts make partial observations explicit.
function observedText(value) {
  return { value: value.slice(0, 512), length: value.length, truncated: value.length > 512 };
}

function observeBusinessState() {
  return {
    pattern: observedText(dom.pattern.value),
    flags: Array.from(state.flags).join(''),
    text: observedText(dom.testText.value),
    replacement: observedText(dom.replaceInput.value),
    error: dom.patternError.hidden ? null : observedText(dom.patternError.textContent),
    matchCount: lastMatches.length,
    activeMatchIndex: state.activeMatchIndex,
    matches: lastMatches.slice(0, 10).map((match) => ({
      index: match.index, end: match.end,
      text: match.text.slice(0, 128), textTruncated: match.text.length > 128,
    })),
    matchesTruncated: lastMatches.length > 10,
    replacementPreview: dom.replaceOutput.hidden ? null : observedText(dom.replaceOutput.textContent),
    patternIds: PATTERN_KEYS.map((item) => item.id),
  };
}

function exposeAgentControls() {
  // Older hosts still run the UI; no new permission or persisted shape needed.
  app.agent?.expose?.({
    observe: observeBusinessState,
    actions: ['set-input', 'apply-pattern', 'select-match'],
    act: (action) => {
      switch (action?.type) {
        // { type: 'set-input', input: { pattern?, text?, replacement?, flags? } }
        case 'set-input': updateInputs(action.input); break;
        // { type: 'apply-pattern', id: 'email' } preserves text/replacement.
        case 'apply-pattern': applyPattern(action.id); break;
        // { type: 'select-match', index: 0 } uses the existing selection path.
        case 'select-match':
          if (!Number.isInteger(action.index) || action.index < 0 || action.index >= lastMatches.length) {
            throw new Error('index must identify a current match');
          }
          selectMatch(action.index, true);
          break;
        default: throw new Error('Unsupported action');
      }
      return { applied: true, state: observeBusinessState() };
    },
  });
}

function debounce(fn, delay) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

// ── Compile + match ──────────────────────────────────
function compileRegex() {
  const flagStr = Array.from(state.flags).join('');
  try {
    return { ok: true, regex: new RegExp(dom.pattern.value, flagStr) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function findAllMatches(regex, text) {
  const out = [];
  if (!text) return out;
  const isGlobalLike = regex.global || regex.sticky;
  if (!isGlobalLike) {
    const m = regex.exec(text);
    if (m) out.push(matchSnapshot(m));
    return out;
  }
  let lastIndex = -1;
  let safety = 0;
  while (safety++ < 10000) {
    const m = regex.exec(text);
    if (!m) break;
    if (m.index === lastIndex && m[0] === '') {
      regex.lastIndex += 1;
      continue;
    }
    lastIndex = m.index;
    out.push(matchSnapshot(m));
    if (m[0] === '') regex.lastIndex += 1;
  }
  return out;
}

function matchSnapshot(m) {
  return {
    text: m[0],
    index: m.index,
    end: m.index + m[0].length,
    groups: m.slice(1).map((v, i) => ({ idx: i + 1, name: null, value: v })),
    namedGroups: m.groups ? Object.entries(m.groups).map(([k, v]) => ({ idx: null, name: k, value: v })) : [],
  };
}

function recompute() {
  const compiled = compileRegex();
  if (!compiled.ok) {
    dom.patternError.hidden = false;
    dom.patternError.textContent = compiled.error;
    dom.statusPill.textContent = ui('statusError');
    dom.statusPill.className = 'status status--err';
    dom.matchCount.textContent = ui('matchCountInvalid');
    dom.matchesSummary.textContent = ui('syntaxError');
    dom.matches.innerHTML = `<div class="empty">${escapeHtml(compiled.error)}</div>`;
    lastMatches = [];
    state.activeMatchIndex = -1;
    updateNavButtons();
    renderHighlight([]);
    renderReplace();
    return;
  }
  dom.patternError.hidden = true;
  dom.patternError.textContent = '';

  const text = dom.testText.value;
  const matches = findAllMatches(compiled.regex, text);
  lastMatches = matches;
  dom.matchCount.textContent = ui('matchCount')(matches.length);
  if (matches.length === 0) {
    dom.statusPill.textContent = ui('statusNoMatch');
    dom.statusPill.className = 'status status--idle';
    dom.matchesSummary.textContent = text ? ui('summaryNoMatch') : ui('summaryWaiting');
  } else {
    dom.statusPill.textContent = ui('statusHits')(matches.length);
    dom.statusPill.className = 'status status--ok';
    const totalGroups = matches.reduce((acc, m) => acc + m.groups.length + m.namedGroups.length, 0);
    dom.matchesSummary.textContent = totalGroups > 0
      ? ui('summaryWithGroups')(matches.length, totalGroups)
      : ui('summaryNoGroups')(matches.length);
  }
  state.activeMatchIndex = -1;
  updateNavButtons();
  renderHighlight(matches);
  renderMatches(matches);
  renderReplace();
}

function updateNavButtons() {
  const has = lastMatches.length > 0;
  dom.btnPrevMatch.disabled = !has;
  dom.btnNextMatch.disabled = !has;
}

// ── Render helpers ───────────────────────────────────
function renderHighlight(matches) {
  const text = dom.testText.value;
  if (matches.length === 0) {
    dom.highlight.innerHTML = escapeHtml(text) + '\n';
    return;
  }
  let html = '';
  let cursor = 0;
  matches.forEach((m, i) => {
    if (m.index > cursor) html += escapeHtml(text.slice(cursor, m.index));
    const cls = i === state.activeMatchIndex ? 'is-active' : '';
    html += `<mark data-idx="${i}" class="${cls}">${escapeHtml(text.slice(m.index, m.end))}</mark>`;
    cursor = m.end;
  });
  if (cursor < text.length) html += escapeHtml(text.slice(cursor));
  dom.highlight.innerHTML = html + '\n';
}

function renderMatches(matches) {
  if (matches.length === 0) {
    dom.matches.innerHTML = `<div class="empty">${escapeHtml(ui('noMatchHint'))}</div>`;
    return;
  }
  dom.matches.innerHTML = '';
  const text = dom.testText.value;
  matches.forEach((m, i) => {
    const el = document.createElement('div');
    el.className = 'match';
    el.dataset.idx = String(i);
    const allGroups = [...m.groups, ...m.namedGroups];
    const { line, col } = lineColAt(text, m.index);
    const isEmpty = m.text === '';
    const textCellClass = isEmpty ? 'match__text match__text--empty' : 'match__text';
    const textCellContent = isEmpty ? escapeHtml(ui('matchEmpty')) : escapeHtml(m.text);
    const moreBadge = allGroups.length > 0
      ? `<span class="match__more">${escapeHtml(ui('matchGroupCount')(allGroups.length))}</span>`
      : '<span></span>';
    let groupsHtml = '';
    if (allGroups.length > 0) {
      const emptyLabel = ui('matchGroupEmpty');
      groupsHtml = '<div class="match__groups">' + allGroups.map((g) => {
        const tag = g.name != null ? `&lt;${escapeHtml(g.name)}&gt;` : `$${g.idx}`;
        const val = g.value === undefined || g.value === ''
          ? `<span class="match__group-val match__group-val--empty">${g.value === undefined ? 'undefined' : escapeHtml(emptyLabel)}</span>`
          : `<span class="match__group-val">${escapeHtml(g.value)}</span>`;
        return `<span class="match__group-tag">${tag}</span>${val}`;
      }).join('') + '</div>';
    }
    el.innerHTML = `
      <span class="match__index">#${i + 1}</span>
      <span class="match__loc">L${line}:${col}</span>
      <span class="${textCellClass}" title="${escapeHtml(m.text)}">${textCellContent}</span>
      ${moreBadge}
      ${groupsHtml}
    `;
    el.addEventListener('click', () => selectMatch(i, true));
    dom.matches.appendChild(el);
  });
}

function selectMatch(i, scrollIntoText) {
  state.activeMatchIndex = i;
  const m = lastMatches[i];
  if (!m) return;
  for (const node of dom.matches.querySelectorAll('.match')) {
    node.classList.toggle('is-active', node.dataset.idx === String(i));
  }
  const activeCard = dom.matches.querySelector(`.match[data-idx="${i}"]`);
  if (activeCard) activeCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  for (const mk of dom.highlight.querySelectorAll('mark')) mk.classList.remove('is-active');
  const target = dom.highlight.querySelector(`mark[data-idx="${i}"]`);
  if (target) target.classList.add('is-active');
  if (scrollIntoText) {
    const before = dom.testText.value.slice(0, m.index);
    const lineNo = before.split('\n').length - 1;
    const lineHeight = 13 * 1.55;
    dom.testText.scrollTop = Math.max(0, lineNo * lineHeight - 60);
    dom.testText.setSelectionRange(m.index, m.end);
    dom.testText.focus();
  }
}

function lineColAt(text, offset) {
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) { line += 1; lastBreak = i; }
  }
  return { line, col: offset - lastBreak };
}

function renderReplace() {
  const replacement = dom.replaceInput.value;
  if (replacement === '') { dom.replaceOutput.hidden = true; return; }
  const compiled = compileRegex();
  if (!compiled.ok) { dom.replaceOutput.hidden = true; return; }
  let result;
  try {
    result = dom.testText.value.replace(compiled.regex, replacement);
  } catch (e) {
    result = ui('replaceFailed')(e.message);
  }
  dom.replaceOutput.hidden = false;
  dom.replaceOutput.textContent = result;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
  }[c]));
}

init();
