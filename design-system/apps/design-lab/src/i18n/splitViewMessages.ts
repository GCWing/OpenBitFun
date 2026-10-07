export const splitViewEn = {
  'component.SplitView.description': 'A resizable pair of panes. Content swaps without moving the divider or remounting either pane.',
  'splitView.split': 'Show both panes',
  'splitView.hide': 'Hide content',
  'splitView.maximize': 'Maximize content',
  'splitView.resize': 'Resize panes',
  'splitView.swap': 'Swap panes',
  'splitView.primary': 'Conversation',
  'splitView.secondary': 'Content',
  'splitView.draft': 'Write a draft',
  'splitView.edit': 'Edit content',
  'splitView.help': 'Hover over the divider to swap panes. Drag or use arrow keys to resize; F6 moves focus between panes. Your text survives every layout change.',
} as const;

export const splitViewZhCN = {
  'component.SplitView.description': '可调整大小的双窗格。交换内容时保留分隔线位置，两个窗格持续挂载。',
  'splitView.split': '显示双窗格',
  'splitView.hide': '隐藏内容',
  'splitView.maximize': '内容全屏',
  'splitView.resize': '调整窗格宽度',
  'splitView.swap': '交换左右窗格',
  'splitView.primary': '聊天',
  'splitView.secondary': '内容',
  'splitView.draft': '输入草稿',
  'splitView.edit': '编辑内容',
  'splitView.help': '悬停分隔线可交换窗格，拖动或使用方向键调整宽度，F6 切换窗格焦点。布局切换会保留已输入的文字。',
} satisfies Record<keyof typeof splitViewEn, string>;

export const splitViewZhTW = {
  'component.SplitView.description': '可調整大小的雙窗格。交換內容時保留分隔線位置，兩個窗格持續掛載。',
  'splitView.split': '顯示雙窗格',
  'splitView.hide': '隱藏內容',
  'splitView.maximize': '內容全螢幕',
  'splitView.resize': '調整窗格寬度',
  'splitView.swap': '交換左右窗格',
  'splitView.primary': '聊天',
  'splitView.secondary': '內容',
  'splitView.draft': '輸入草稿',
  'splitView.edit': '編輯內容',
  'splitView.help': '懸停分隔線可交換窗格，拖動或使用方向鍵調整寬度，F6 切換窗格焦點。佈局切換會保留已輸入的文字。',
} satisfies Record<keyof typeof splitViewEn, string>;
