// Shared by the lightweight native shell and the Web UI draft preview.
// All SVG comes from the generated Lucide catalog; app strings remain text.
export const defaultTitlebar = Object.freeze({
  title: null, showTitle: true, showIcon: false, titleAlignment: 'start',
  density: 'comfortable', buttonShape: 'rounded', controlsPosition: 'end',
  surface: 'surface-scene', foreground: 'content-primary', border: 'border-subtle', actions: [],
});

export function resolveTitlebar(chrome) {
  return { ...defaultTitlebar, ...chrome?.titlebar, actions: chrome?.titlebar?.actions ?? [] };
}

export function actionLabel(action, locale) {
  return action.labels?.[locale] || action.label;
}

export function mountTitlebar(element, options) {
  const { chrome, title, icon, icons, locale, labels, platform, onAction, onWindowAction, onDrag, preview = false } = options;
  const config = resolveTitlebar(chrome);
  let contentReady = options.ready !== false;
  let transferring = false;
  const document = element.ownerDocument;
  element.replaceChildren();
  element.classList.add('miniapp-titlebar');
  element.dataset.platform = platform;
  delete element.dataset.controlsPosition;
  delete element.dataset.fullscreen;
  for (const key of ['titleAlignment', 'density', 'buttonShape', 'surface', 'foreground', 'border']) {
    element.dataset[key] = config[key];
  }
  element.setAttribute('role', 'toolbar');
  element.setAttribute('aria-label', labels.titlebar);
  const glyph = name => {
    const span = document.createElement('span');
    span.className = 'miniapp-titlebar__glyph';
    span.setAttribute('aria-hidden', 'true');
    // The catalog is compiled into the host, never supplied by app content.
    span.innerHTML = icons[name] || icons.app;
    return span;
  };
  const button = (name, label, callback, disabled = false) => {
    const control = document.createElement('button');
    control.type = 'button';
    control.className = 'miniapp-titlebar__button';
    control.title = label;
    control.setAttribute('aria-label', label);
    control.disabled = preview || disabled;
    control.append(glyph(name));
    control.onclick = () => callback?.();
    return control;
  };
  const identity = document.createElement('div');
  identity.className = 'miniapp-titlebar__identity';
  if (config.showIcon) identity.append(glyph(icon));
  if (config.showTitle) {
    const text = document.createElement('span');
    text.className = 'miniapp-titlebar__title';
    text.textContent = config.title ?? title;
    text.title = text.textContent;
    identity.append(text);
  }
  const actions = document.createElement('div');
  actions.className = 'miniapp-titlebar__actions';
  for (const action of config.actions) {
    const control = button(action.icon, actionLabel(action, locale), () => onAction?.(action.id), !contentReady || action.enabled === false);
    control.dataset.actionId = action.id;
    actions.append(control);
  }
  const transfer = button('return', labels.openTab, () => onWindowAction?.('tab'));
  transfer.dataset.windowAction = 'tab';
  transfer.classList.add('miniapp-titlebar__transfer');
  transfer.disabled = preview || !contentReady;
  const controls = document.createElement('div');
  controls.className = `miniapp-titlebar__controls window-controls${platform === 'windows' ? ' window-controls--windows' : ''}`;
  // AppKit owns the real traffic lights. Only other platforms use the same
  // caption buttons as the main window; MiniApp styling cannot move them.
  if (platform !== 'macos') {
    for (const name of ['minimize', 'maximize', 'close']) {
      const control = button(name, labels[name], () => onWindowAction?.(name));
      control.className = `window-controls__btn window-controls__btn--${name}`;
      control.dataset.windowAction = name;
      controls.append(control);
    }
  }
  element.append(identity, actions, transfer);
  if (platform !== 'macos') element.append(controls);
  element.onmousedown = event => {
    if (preview || event.button !== 0 || event.detail > 1 || event.target.closest('button')) return;
    event.preventDefault();
    onDrag?.();
  };
  element.ondblclick = event => {
    if (!preview && event.button === 0 && !event.target.closest('button')) {
      onWindowAction?.(platform === 'macos' ? 'titlebarDoubleClick' : 'maximize');
    }
  };
  return {
    setMaximized(maximized) {
      const control = controls.querySelector('[data-window-action="maximize"]');
      if (!control) return;
      control.replaceChildren(glyph(maximized ? 'restore' : 'maximize'));
      control.title = maximized ? labels.restore : labels.maximize;
      control.setAttribute('aria-label', control.title);
    },
    setFullscreen(fullscreen) {
      element.dataset.fullscreen = String(fullscreen);
    },
    setTransferring(value) {
      transferring = value;
      transfer.disabled = preview || !contentReady || transferring;
      transfer.setAttribute('aria-busy', String(value));
    },
    setReady(value) {
      contentReady = value;
      for (const [index, control] of [...actions.children].entries()) {
        control.disabled = preview || !contentReady || config.actions[index].enabled === false;
      }
      transfer.disabled = preview || !contentReady || transferring;
    },
    destroy() {
      element.onmousedown = null;
      element.ondblclick = null;
      element.replaceChildren();
    },
  };
}
