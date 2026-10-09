import { invoke } from './transport.js';
import { reportRows } from './report.mjs';

async function loadTranslations() {
  try {
    const response = await fetch('locales.json');
    if (!response.ok) throw new Error('Locale asset unavailable');
    const catalogs = await response.json();
    if (!catalogs.en) throw new Error('Default locale unavailable');
    return catalogs;
  } catch (error) {
    const output = document.getElementById('notice');
    output.textContent = 'Data Migrator could not load its language files. Close it and download or rebuild the complete package.';
    output.hidden = false;
    document.querySelectorAll('button, select').forEach((node) => { node.disabled = true; });
    throw error;
  }
}
const translations = await loadTranslations();


const locale = localStorage.getItem('migrator.language') || (navigator.language.startsWith('zh-TW') || navigator.language.startsWith('zh-HK')
  ? 'zh-TW'
  : navigator.language.startsWith('zh') ? 'zh-CN' : 'en');
const text = translations[locale] || translations.en;
document.documentElement.lang = locale;
document.querySelectorAll('[data-i18n]').forEach((node) => {
  node.textContent = text[node.dataset.i18n] || translations.en[node.dataset.i18n];
});

const groups = [
  ['settings_and_credentials', {
    en: ['Settings and credentials', 'Settings are imported; credentials that cannot be decrypted are marked for sign-in.'],
    'zh-CN': ['设置与服务凭据', '导入设置；无法解密的凭据会标记为需要重新登录。'],
    'zh-TW': ['設定與服務憑據', '匯入設定；無法解密的憑據會標記為需要重新登入。'],
  }],
  ['agents_skills_and_miniapps', {
    en: ['Agents, Skills, and MiniApps', 'Imports user extensions and saved data from built-in MiniApps. Built-in code is provided by OpenBitFun.'],
    'zh-CN': ['智能体、Skills 与 MiniApps', '导入用户扩展和内置 MiniApps 的使用数据；内置代码由新版提供。'],
    'zh-TW': ['智能體、Skills 與 MiniApps', '匯入使用者擴充與內建 MiniApps 的使用資料；內建程式碼由新版提供。'],
  }],
  ['workspaces_sessions_and_tasks', {
    en: ['Workspaces, sessions, and tasks', 'Imports workspaces, conversation history, and Agent task status.'],
    'zh-CN': ['工作区、会话与智能体任务状态', '导入工作区、会话历史与智能体任务状态。'],
    'zh-TW': ['工作區、工作階段與智能體任務狀態', '匯入工作區、會話歷史與智能體任務狀態。'],
  }],
  ['memory', {
    en: ['Memory', 'Imports memory databases and memory files.'],
    'zh-CN': ['记忆', '导入记忆数据库与记忆文件。'],
    'zh-TW': ['記憶', '匯入記憶資料庫與記憶檔案。'],
  }],
  ['remote_connections_and_devices', {
    en: ['Remote connections and devices', 'Imports remote connections and device settings. Some connections may require signing in again.'],
    'zh-CN': ['远程连接与设备', '导入远程连接与设备设置；部分连接可能需要重新登录。'],
    'zh-TW': ['遠端連線與裝置', '匯入遠端連線與裝置設定；部分連線可能需要重新登入。'],
  }],
];

let current;
let pollTimer;
let locationsDirty = false;
let locationSnapshot;
let scopeSnapshot;
let resetConfirmationId;

function format(template, values) {
  return Object.entries(values).reduce((value, [key, replacement]) =>
    value.replace(`{${key}}`, String(replacement)), template);
}

function show(id, visible = true) {
  document.getElementById(id).hidden = !visible;
}

function setBusy(busy) {
  document.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
}

function notice(message, tone = 'danger') {
  const node = document.getElementById('notice');
  node.textContent = message || '';
  node.dataset.tone = tone;
  node.hidden = !message;
}

function requireBootstrap() {
  if (current) return true;
  notice(text.bootstrapPending);
  return false;
}

function row(title, detail) {
  const item = document.createElement('div');
  item.className = 'result-row';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const small = document.createElement('small');
  small.textContent = detail;
  item.append(strong, small);
  return item;
}

function groupLabel(id) {
  const labels = groups.find(([group]) => group === id)?.[1];
  return (labels?.[locale] || labels?.en || [id])[0];
}

function renderScopes(selection) {
  const list = document.getElementById('scope-list');
  const signature = JSON.stringify([selection, current?.recovery, current?.running]);
  if (signature === scopeSnapshot) return;
  scopeSnapshot = signature;
  list.replaceChildren();
  const selected = new Set(selection?.groups?.length ? selection.groups : groups.map(([id]) => id));
  groups.forEach(([id, labels]) => {
    const option = document.createElement('div');
    option.className = 'scope-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `scope-${id}`;
    checkbox.value = id;
    checkbox.checked = selected.has(id);
    checkbox.disabled = Boolean(current?.running || current?.recovery);
    const label = document.createElement('label');
    label.htmlFor = checkbox.id;
    const strong = document.createElement('strong');
    const description = document.createElement('span');
    [strong.textContent, description.textContent] = labels[locale] || labels.en;
    label.append(strong, description);
    option.append(checkbox, label);
    list.append(option);
  });
}

function selection() {
  return {
    groups: [...document.querySelectorAll('#scope-list input:checked')].map((input) => input.value),
  };
}

function render(view) {
  current = view;
  const resetPreview = view.resetPreview;
  if (resetConfirmationId !== resetPreview?.confirmationId) {
    resetConfirmationId = resetPreview?.confirmationId;
    document.getElementById('reset-confirmation').value = '';
  }
  show('reset-preview', Boolean(resetPreview) && !view.resetting);
  show('reset-progress', view.resetting);
  document.getElementById('reset-directories').replaceChildren(...(resetPreview?.directories || []).map((directory) =>
    row(directory.path, directory.exists ? text.resetExists : text.resetMissing)));
  const resetResult = view.resetResult;
  show('reset-result', Boolean(resetResult));
  if (resetResult) {
    const resultNode = document.getElementById('reset-result');
    const summary = document.createElement('p');
    summary.textContent = resetResult.failed.length ? text.resetIncomplete : text.resetSuccess;
    resultNode.replaceChildren(summary, ...resetResult.failed.map((path) => row(path, text.resetFailed)));
  }
  const source = view.source;
  document.getElementById('source-badge').textContent = !source
    ? text.missing : source.supported ? text.ready : text.unsupported;
  document.getElementById('source-badge').dataset.tone = !source || !source.supported
    ? 'warning' : 'success';
  document.getElementById('source-summary').textContent = source
    ? format(text.sourceFound, { version: source.productVersion }) : text.missing;
  if (!source) document.getElementById('source-summary').textContent = text.noSource;
  renderLocations(view.locations);
  document.getElementById('tool-version').textContent = 'v' + view.toolVersion;
  const tasks = document.getElementById('saved-task');
  const previousTask = tasks.value;
  tasks.replaceChildren(...view.savedTasks.map((task) => {
    const option = document.createElement('option');
    option.value = task.runId;
    option.textContent = task.runId + ' · ' + (task.readable ? task.status : text.unreadableTask);
    option.disabled = !task.readable;
    return option;
  }));
  if ([...tasks.options].some((option) => option.value === previousTask && !option.disabled)) tasks.value = previousTask;
  show('history-card', view.savedTasks.length > 0 && !view.running);
  document.getElementById('resume-task').disabled = !tasks.selectedOptions[0] || tasks.selectedOptions[0].disabled || view.running || locationsDirty;
  notice(view.error?.message || (view.recovery ? text.recovery : ''), view.error ? 'danger' : 'info');

  show('scope-card', !view.recovery && !view.running && !view.plan);
  renderScopes(view.selection);

  const findings = document.getElementById('findings');
  findings.replaceChildren(...view.findings.map((finding) =>
    row(finding.domain, `${text[finding.code] || finding.code} · ${finding.entityCount} item(s), ${finding.logicalBytes} byte(s)`)));
  show('scan-card', view.findings.length > 0 && !view.plan);

  const planSummary = document.getElementById('plan-summary');
  if (view.plan) {
    planSummary.replaceChildren(
      row(text.steps.replace('{count}', view.plan.steps.length), view.plan.selection.groups.map(groupLabel).join(' · ')),
      row(text.conflicts.replace('{count}', view.plan.conflicts.length), text.confirmHelp),
      ...view.plan.findings.filter((finding) => finding.severity !== 'info').map((finding) => row(finding.domain, text[finding.code] || finding.code)),
      ...view.plan.conflicts.map((conflict) => row(conflict.domain, conflict.code || conflict.resolution || '')),
    );
  }
  show('plan-card', Boolean(view.plan) && !view.running && !['completed', 'completed_with_warnings'].includes(view.status));
  const blocker = document.getElementById('blockers');
  blocker.textContent = view.blockers.length
    ? format(text.blockers, { count: view.blockers.length }) : text.noBlockers;
  blocker.hidden = !view.blockers.length;
  show('retry-writers', view.blockers.length > 0);

  const progress = view.progress;
  show('progress-card', Boolean(progress) && (view.running || view.status === 'cancelled'));
  if (progress) {
    document.getElementById('phase').textContent = progress.phase;
    document.getElementById('domain').textContent = progress.domain || '-';
    document.getElementById('count').textContent = `${progress.processed} / ${progress.total}`;
    document.getElementById('progress-message').textContent = progress.code.replaceAll('_', ' ');
    document.getElementById('cancel').disabled = !view.running;
  }

  const reportSummary = document.getElementById('report-summary');
  if (view.report) {
    reportSummary.replaceChildren(...reportRows(view.report, view.workspaceCounts, text)
      .map(([title, detail]) => row(title, detail)));
  }
  show('report-card', !view.running && (Boolean(view.report) || view.status === 'cancelled'));
  const canExportDiagnostics = ['failed_recoverable', 'failed_manual_action_required'].includes(view.status);
  show('export-diagnostics', canExportDiagnostics);
  if (!canExportDiagnostics) {
    const output = document.getElementById('diagnostics-path');
    output.textContent = '';
    output.hidden = true;
  }
  document.querySelectorAll('button, #locations input, #language, #saved-task').forEach((node) => { node.disabled = view.running; });
  document.getElementById('cancel').disabled = !view.running || view.resetting;
  document.getElementById('preview-reset').disabled = view.running || locationsDirty;
  document.getElementById('reset-confirmation').disabled = view.running || locationsDirty;
  document.getElementById('reset-data').disabled = view.running || locationsDirty || !resetPreview
    || document.getElementById('reset-confirmation').value !== 'RESET';
  document.getElementById('start').disabled = !view.canExecute || locationsDirty;
  document.getElementById('resume-task').disabled = !tasks.selectedOptions[0] || tasks.selectedOptions[0].disabled || view.running || locationsDirty;
  for (const id of ['scan', 'prepare']) document.getElementById(id).disabled = view.running || locationsDirty;
  if (locationsDirty) notice(text.dirtyLocations, 'info');

  if (view.running && !pollTimer) {
    pollTimer = window.setInterval(refresh, 500);
  } else if (!view.running && pollTimer) {
    window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

async function call(command, request = {}) {
  setBusy(true);
  let failure;
  try {
    const result = await invoke(command, { request });
    if (result) render(result);
    return result;
  } catch (error) {
    failure = error?.message || String(error);
    return undefined;
  } finally {
    setBusy(false);
    if (current) render(current);
    if (failure) notice(failure);
  }
}

async function refresh() {
  try {
    render(await invoke('get_migrator_bootstrap', { request: {} }));
  } catch (error) {
    const message = error?.message || (typeof error === 'string' ? error : '');
    notice(message || text.bootstrapFailed);
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function renderLocations(locations) {
  const signature = JSON.stringify(locations);
  if (signature === locationSnapshot || locationsDirty) return;
  locationSnapshot = signature;
  const host = document.getElementById('locations');
  host.replaceChildren();
  for (const [prefix, title] of [['legacy', text.source], ['target', text.target]]) {
    const group = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = title;
    group.append(legend);
    for (const suffix of ['UserRoot', 'HomeRoot', 'SkillsRoot', 'SshRoot']) {
      const key = prefix + suffix;
      const label = document.createElement('label');
      const input = document.createElement('input');
      label.htmlFor = key;
      label.textContent = text[suffix[0].toLowerCase() + suffix.slice(1)];
      input.type = 'text'; input.id = key; input.value = locations[key];
      input.spellcheck = false; input.autocomplete = 'off';
      input.addEventListener('input', () => { locationsDirty = true; if (current) render(current); });
      group.append(label, input);
    }
    host.append(group);
  }
}

document.getElementById('language').value = locale;
document.getElementById('language').addEventListener('change', (event) => {
  localStorage.setItem('migrator.language', event.target.value);
  window.location.reload();
});
document.getElementById('apply-locations').addEventListener('click', async () => {
  if (!requireBootstrap()) return;
  const locations = Object.fromEntries([...document.querySelectorAll('#locations input')].map((input) => [input.id, input.value.trim()]));
  const result = await call('set_migration_locations', { locations });
  if (result) { locationsDirty = false; locationSnapshot = undefined; render(result); }
});
document.getElementById('resume-task').addEventListener('click', () => call('resume_migration_task', { runId: document.getElementById('saved-task').value }));
document.getElementById('new-task').addEventListener('click', () => call('new_migration_task'));
document.getElementById('preview-reset').addEventListener('click', () => call('preview_openbitfun_reset'));
document.getElementById('reset-confirmation').addEventListener('input', () => { if (current) render(current); });
document.getElementById('reset-data').addEventListener('click', () => {
  if (!current?.resetPreview) return;
  call('reset_openbitfun_data', {
    confirmationId: current.resetPreview.confirmationId,
    confirmation: document.getElementById('reset-confirmation').value,
  });
});
for (const id of ['close', 'finish']) document.getElementById(id).addEventListener('click', () => call('finish_legacy_migration'));

document.getElementById('scan').addEventListener('click', () =>
  call('scan_legacy_migration', { selection: selection() }));
document.getElementById('prepare').addEventListener('click', () =>
  call('prepare_legacy_migration', { selection: selection() }));
document.getElementById('retry-writers').addEventListener('click', () =>
  call('retry_writer_check'));
document.getElementById('start').addEventListener('click', () =>
  call('start_legacy_migration', { planHash: current.plan.planHash }));
document.getElementById('cancel').addEventListener('click', () =>
  call('cancel_legacy_migration'));
document.getElementById('export-diagnostics').addEventListener('click', async () => {
  setBusy(true);
  let failure;
  try {
    const result = await invoke('export_migration_diagnostics', { request: {} });
    const output = document.getElementById('diagnostics-path');
    output.textContent = format(text.diagnosticsExported, { path: result.filePath });
    output.hidden = false;
  } catch (error) {
    failure = error?.message || String(error);
  } finally {
    setBusy(false);
    if (current) render(current);
    if (failure) notice(failure);
  }
});
refresh();
