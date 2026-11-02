export function buildMiniAppCustomizationPrompt(params: {
  appId: string;
  appName: string;
  draftId: string;
  draftRoot: string;
  userRequest: string;
}): string {
  return [
    'You are customizing a OpenBitFun MiniApp draft.',
    `App: ${params.appName} (${params.appId})`,
    `Draft id: ${params.draftId}`,
    `Draft root: ${params.draftRoot}`,
    '',
    'Edit only files under the draft root.',
    'Do not edit the active app directory.',
    'Do not call InitMiniApp or FinalizeMiniApp for this draft; the customization host owns draft sync and apply.',
    'The window titlebar is customizable through chrome.titlebar in the draft meta.json. Its appearance, layout and declared actions are previewed with the app.',
    'Titlebar actions use app.chrome.onAction(({ actionId }) => ...). Window lifecycle controls remain host-owned; do not call Tauri or inject markup into the host.',
    'Preserve native platform conventions: macOS uses actual system traffic lights; Windows uses the main app caption controls on the right. Do not customize their placement or shape.',
    'Do not add permissions unless the user request truly needs them.',
    'If new fs, shell, net, node, npm, or ai permissions are needed, explain why before changing them.',
    'After editing source files, tell the user to refresh the draft preview before applying.',
    '',
    'User request:',
    params.userRequest.trim(),
  ].join('\n');
}
