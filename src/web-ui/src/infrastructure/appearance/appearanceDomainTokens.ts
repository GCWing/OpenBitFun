const cssVariable = (name: string): string => `var(${name})`;
const domainToken = (name: string): string => cssVariable(`--openbitfun-domain-${name}`);

export const APPEARANCE_DOMAIN_TOKENS = {
  contextCompression: domainToken('context-compression'),
  generativeUi: domainToken('generative-ui'),
  miniApp: domainToken('mini-app'),
  mermaidDiagram: domainToken('mermaid-diagram'),
  gitGraphLane: Array.from({ length: 8 }, (_, index) => domainToken(`git-lane-${index}`)),
  subagentAvatar: (avatarId: string): string => domainToken(`subagent-${avatarId}`),
  toolIdentity: {
    search: domainToken('tool-search'),
    webSearch: domainToken('tool-web-search'),
    git: domainToken('tool-git'),
    terminal: domainToken('tool-terminal'),
    mcp: domainToken('tool-mcp'),
    assistantAction: domainToken('tool-assistant-action'),
    reviewSummary: domainToken('tool-review-summary'),
  },
  agentCapability: {
    docs: domainToken('capability-docs'),
    testing: domainToken('capability-testing'),
    creative: domainToken('capability-creative'),
    ops: domainToken('capability-ops'),
  },
  insights: {
    positive: domainToken('insights-positive'),
    time: domainToken('insights-time'),
    neutral: domainToken('insights-neutral'),
    issue: domainToken('insights-issue'),
  },
  progress: {
    compacting: domainToken('progress-compacting'),
  },
  templateContext: {
    memories: domainToken('template-memories'),
  },
  reviewTeam: {
    memberDefault: domainToken('review-member-default'),
    worker: domainToken('review-worker'),
    judge: domainToken('review-judge'),
  },
  tealAction: domainToken('teal-action'),
  todo: domainToken('todo'),
  textStroke: Array.from({ length: 5 }, (_, index) => domainToken(`text-stroke-${index}`)),
  inspectorOverlay: {
    activeBorder: domainToken('inspector-active-border'),
    activeBackground: domainToken('inspector-active-background'),
    activeBorderSubtle: domainToken('inspector-active-border-subtle'),
    selectedBorder: domainToken('inspector-selected-border'),
    selectedBackground: domainToken('inspector-selected-background'),
    browserTooltipBackground: domainToken('inspector-browser-tooltip-background'),
    mainTooltipBackground: domainToken('inspector-main-tooltip-background'),
    tooltipText: domainToken('inspector-tooltip-text'),
    tooltipShadow: domainToken('inspector-tooltip-shadow'),
    staticWhite: cssVariable('--openbitfun-color-content-on-dark'),
  },
} as const;

const languageToken = (name: string): string => domainToken(`language-${name}`);

export const APPEARANCE_LANGUAGE_TOKENS = {
  typescript: languageToken('blue'),
  typescriptReact: languageToken('cyan'),
  javascript: languageToken('yellow'),
  javascriptReact: languageToken('cyan'),
  python: languageToken('blue'),
  rust: languageToken('orange'),
  go: languageToken('cyan'),
  java: languageToken('orange'),
  kotlin: languageToken('purple'),
  cpp: languageToken('red'),
  c: languageToken('slate'),
  csharp: languageToken('green'),
  swift: languageToken('red'),
  php: languageToken('purple'),
  ruby: languageToken('red'),
  scala: languageToken('red'),
  dart: languageToken('cyan'),
  lua: languageToken('blue'),
  r: languageToken('blue'),
  html: languageToken('red'),
  xml: languageToken('blue'),
  vue: languageToken('green'),
  svelte: languageToken('orange'),
  css: languageToken('blue'),
  scss: languageToken('purple'),
  sass: languageToken('purple'),
  less: languageToken('blue'),
  json: languageToken('yellow'),
  yaml: languageToken('red'),
  toml: languageToken('orange'),
  sql: languageToken('orange'),
  graphql: languageToken('purple'),
  dockerfile: languageToken('blue'),
  makefile: languageToken('green'),
  ini: languageToken('slate'),
  env: languageToken('yellow'),
  shell: languageToken('green'),
  powershell: languageToken('blue'),
  batch: languageToken('green'),
  markdown: languageToken('blue'),
  restructuredtext: languageToken('slate'),
  image: languageToken('purple'),
  audio: languageToken('green'),
  video: languageToken('red'),
  font: languageToken('orange'),
  archive: languageToken('purple'),
  binary: languageToken('slate'),
  plaintext: languageToken('slate'),
} as const;

const CODE_SNIPPET_LANGUAGE_TOKENS = {
  javascript: APPEARANCE_LANGUAGE_TOKENS.javascript,
  typescript: APPEARANCE_LANGUAGE_TOKENS.typescript,
  python: APPEARANCE_LANGUAGE_TOKENS.python,
  rust: APPEARANCE_LANGUAGE_TOKENS.rust,
  go: APPEARANCE_LANGUAGE_TOKENS.go,
  java: APPEARANCE_LANGUAGE_TOKENS.java,
  html: APPEARANCE_LANGUAGE_TOKENS.html,
  css: APPEARANCE_LANGUAGE_TOKENS.css,
  scss: APPEARANCE_LANGUAGE_TOKENS.scss,
  fallback: APPEARANCE_LANGUAGE_TOKENS.plaintext,
} as const;

export function getCodeSnippetLanguageAccent(language?: string): string {
  if (!language) return CODE_SNIPPET_LANGUAGE_TOKENS.fallback;
  return CODE_SNIPPET_LANGUAGE_TOKENS[language as keyof typeof CODE_SNIPPET_LANGUAGE_TOKENS]
    ?? CODE_SNIPPET_LANGUAGE_TOKENS.fallback;
}

const prismToken = (mode: 'light' | 'dark', role: string): string => domainToken(`prism-${mode}-${role}`);

export const APPEARANCE_PRISM_TOKENS = {
  light: {
    foreground: prismToken('light', 'foreground'),
    comment: prismToken('light', 'comment'),
    keyword: prismToken('light', 'keyword'),
    string: prismToken('light', 'string'),
    functionName: prismToken('light', 'function'),
    number: prismToken('light', 'number'),
    tag: prismToken('light', 'tag'),
    punctuation: prismToken('light', 'punctuation'),
    property: prismToken('light', 'property'),
  },
  dark: {
    foreground: prismToken('dark', 'foreground'),
    comment: prismToken('dark', 'comment'),
    keyword: prismToken('dark', 'keyword'),
    string: prismToken('dark', 'string'),
    functionName: prismToken('dark', 'function'),
    number: prismToken('dark', 'number'),
    tag: prismToken('dark', 'tag'),
    punctuation: prismToken('dark', 'punctuation'),
    property: prismToken('dark', 'property'),
  },
} as const;
