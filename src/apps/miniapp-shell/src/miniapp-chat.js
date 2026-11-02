// Shell-local presentation only. SDK routing, permissions and execution stay in the host.
import { launcher as launcherStyles, composer as composerStyles, iconButton as iconStyles } from './generated/chat-style-classes.js';

export function mountMiniAppChat(root, { onSend, onStop, loadSnapshot, icons = {} }) {
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const glyph = (name, className = '') => {
    const span = node('span', `miniapp-chat__glyph ${className}`);
    span.setAttribute('aria-hidden', 'true');
    // Icons come only from the bundled Lucide catalog, never from app markup.
    span.innerHTML = icons[name] || icons.app || '';
    return span;
  };
  const iconButton = (name, className = '') => {
    const control = node('button', `${iconStyles.button} ${className}`);
    control.type = 'button';
    Object.assign(control.dataset, { openbitfunComponent: 'icon-button', openbitfunVariant: 'quiet', openbitfunShape: 'square', openbitfunTone: 'neutral', size: 'sm', loading: 'false' });
    const icon = glyph(name, iconStyles.icon);
    icon.dataset.openbitfunPart = 'icon';
    control.append(icon);
    return control;
  };
  root.className = 'miniapp-chat openbitfun-fmc';
  Object.assign(root.dataset, { openbitfunComponent: 'floating-mini-chat', openbitfunPart: 'root', openbitfunMode: 'chat', openbitfunCommunicationMode: 'chat' });
  root.hidden = true;
  const launcher = node('button', `miniapp-chat__launcher openbitfun-fmc__button ${launcherStyles.root}`);
  launcher.type = 'button';
  launcher.dataset.openbitfunComponent = 'launcher-button';
  const launcherLabel = node('span', launcherStyles.label);
  launcher.append(launcherLabel);
  launcher.setAttribute('aria-controls', 'miniapp-chat-panel');
  const panel = node('section', 'miniapp-chat__panel openbitfun-fmc__panel');
  panel.id = 'miniapp-chat-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  const header = node('header', 'miniapp-chat__header openbitfun-fmc__header');
  const title = node('span', 'miniapp-chat__title openbitfun-fmc__title-wrapper');
  title.id = 'miniapp-chat-title';
  panel.setAttribute('aria-labelledby', title.id);
  const collapse = iconButton('minimize');
  header.append(title, collapse);
  const body = node('div', 'miniapp-chat__body openbitfun-fmc__body');
  const messages = node('div', 'miniapp-chat__messages');
  messages.setAttribute('role', 'log');
  messages.setAttribute('aria-live', 'polite');
  const transcript = node('div', 'miniapp-chat__transcript');
  messages.append(transcript);
  const notice = node('div', 'miniapp-chat__note');
  notice.setAttribute('role', 'status');
  const retry = iconButton('refresh');
  const form = node('form', 'miniapp-chat__form openbitfun-context-drop-zone openbitfun-chat-input-drop-zone');
  const inputRoot = node('div', 'openbitfun-chat-input');
  const box = node('div', 'openbitfun-chat-input__box');
  const composer = node('div', `${composerStyles.root} openbitfun-chat-input__composer`);
  composer.dataset.openbitfunComponent = 'chat-composer';
  composer.dataset.hasContext = 'false';
  const composerBody = node('div', composerStyles.body);
  const surface = node('div', composerStyles.surface);
  surface.dataset.openbitfunPart = 'surface';
  surface.dataset.openbitfunLayout = 'compact';
  const content = node('div', composerStyles.content);
  content.dataset.openbitfunPart = 'content';
  const input = node('textarea', 'miniapp-chat__input');
  input.rows = 1;
  const actions = node('div', `miniapp-chat__actions ${composerStyles.endActions}`);
  actions.dataset.openbitfunPart = 'endActions';
  const stop = iconButton('stop', composerStyles.actionButton);
  const send = iconButton('send', composerStyles.actionButton);
  send.type = 'submit';
  for (const action of [stop, send]) {
    action.dataset.openbitfunVariant = 'primary';
    action.dataset.openbitfunShape = 'circle';
    action.dataset.openbitfunRole = 'composer-action';
  }
  actions.append(stop, send);
  content.append(input); surface.append(content, actions); composerBody.append(surface);
  composer.append(composerBody); box.append(composer); inputRoot.append(box); form.append(inputRoot);
  body.append(messages, notice, retry, form);
  panel.append(header, body);
  root.replaceChildren(launcher, panel);

  let labels = {}, appName = '', appIcon = 'app', description = '', customization = {};
  let claimed = false, open = false, connected = true, approval = false, unread = false;
  let sessionId, busy, pending, stopping = false, epoch = 0, loading = false, failure = '';
  let snapshotSupported = false, partial = false, streamId, runtimeCursor = 0, sync;
  let buffered = [];
  const turns = new Map();
  const text = value => typeof value === 'string' ? value : '';
  const bounded = (value, length) => text(value).trim().slice(0, length);
  const activeTurn = () => [...turns.values()].findLast(turn => turn.status === 'running');
  const sendDisabled = () => !claimed || !connected || !!busy || loading || !!activeTurn() || !input.value.trim();
  const setOpen = value => {
    open = value;
    if (open) unread = false;
    render();
    if (open) input.focus();
  };
  const addMessage = (role, content, status, error) => {
    if (!content && !status && !error) return;
    const item = node('article', `miniapp-chat__message ${role === 'user' ? 'user-message-item-shell' : 'model-round-item'}`);
    item.dataset.role = role;
    item.setAttribute('aria-label', role === 'user' ? labels.you : labels.assistant);
    if (role === 'user') {
      const bubble = node('div', 'user-message-item user-message-item--expanded');
      const main = node('div', 'user-message-item__main');
      main.append(node('p', 'user-message-item__content', content));
      bubble.append(main); item.append(bubble);
    } else {
      const block = node('div', 'flow-text-block');
      if (content) block.append(node('p', 'text-content', content));
      if (status) block.append(node('div', 'flow-text-block flow-text-block--runtime-status', status));
      if (error) block.append(node('p', 'text-content', error));
      item.append(block);
    }
    transcript.append(item);
  };
  function render() {
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
    root.hidden = !claimed;
    root.classList.toggle('openbitfun-fmc--open', open);
    root.dataset.openbitfunState = open ? 'open' : '';
    launcherLabel.textContent = labels.launcher || '';
    launcher.setAttribute('aria-label', approval ? labels.approval : labels.open);
    launcher.setAttribute('aria-expanded', String(open));
    launcher.dataset.attention = String(approval || unread);
    panel.classList.toggle('openbitfun-fmc__panel--open', open);
    panel.setAttribute('aria-hidden', String(!open));
    panel.inert = !open;
    title.textContent = customization.title || appName;
    title.title = title.textContent;
    collapse.setAttribute('aria-label', labels.collapse);
    input.placeholder = customization.placeholder || labels.prompt || '';
    input.setAttribute('aria-label', input.placeholder);
    send.setAttribute('aria-label', labels.send);
    send.title = labels.send;
    send.hidden = !!busy || !!activeTurn();
    send.disabled = sendDisabled();
    composer.setAttribute('aria-busy', String(!!busy || !!activeTurn()));
    composer.dataset.openbitfunState = busy || activeTurn() ? 'busy' : '';
    stop.setAttribute('aria-label', stopping ? labels.stopping : labels.stop);
    stop.hidden = !busy && !activeTurn();
    stop.disabled = !connected || stopping || !activeTurn();
    stop.title = activeTurn() ? labels.stop : labels.stopUnavailable;
    retry.hidden = !failure || !snapshotSupported || !sessionId;
    retry.setAttribute('aria-label', labels.retry);
    retry.title = labels.retry;
    retry.disabled = loading || !connected;
    notice.dataset.error = String(!!failure || !connected);
    notice.textContent = !connected ? labels.offline : failure
      ? failure : loading ? labels.loading : approval ? labels.approval
        : busy ? labels.processing : sessionId && !snapshotSupported ? labels.liveOnly : partial ? labels.limitedHistory : '';
    notice.hidden = !notice.textContent;
    transcript.replaceChildren();
    if (!turns.size && !pending) {
      const welcome = node('div', 'miniapp-chat__welcome openbitfun-fmc__miniapp-welcome');
      const welcomeContent = node('div', 'openbitfun-fmc__miniapp-welcome-content');
      const welcomeIcon = node('div', 'openbitfun-fmc__miniapp-welcome-icon');
      welcomeIcon.append(glyph(appIcon));
      welcomeContent.append(welcomeIcon);
      if (customization.welcome?.title && customization.welcome.title !== appName) {
        welcomeContent.append(node('div', 'openbitfun-fmc__miniapp-welcome-eyebrow', appName));
      }
      welcomeContent.append(node('h2', '', customization.welcome?.title || appName));
      const detail = customization.welcome?.description || description;
      if (detail) welcomeContent.append(node('p', 'openbitfun-fmc__miniapp-welcome-description', detail));
      const suggestions = node('div', 'miniapp-chat__suggestions openbitfun-fmc__miniapp-suggestions-list');
      for (const suggestion of customization.suggestions || []) {
        const button = node('button', 'openbitfun-fmc__miniapp-suggestion');
        button.append(node('span', '', suggestion.label), glyph('suggestion'));
        button.type = 'button';
        button.onclick = () => setDraft(suggestion.prompt);
        suggestions.append(button);
      }
      if (customization.suggestions?.length) {
        const group = node('div', 'openbitfun-fmc__miniapp-suggestions');
        if (customization.welcome?.suggestionsLabel) group.append(node('div', 'openbitfun-fmc__miniapp-suggestions-label', customization.welcome.suggestionsLabel));
        group.append(suggestions); welcomeContent.append(group);
      }
      welcome.append(welcomeContent); transcript.append(welcome);
    }
    for (const turn of turns.values()) {
      addMessage('user', turn.user);
      const content = [...turn.rounds.values()].join('\n\n');
      const status = turn.status === 'running' ? (turn.tool ? labels.tool : labels.working)
        : turn.status === 'failed' ? labels.failed : turn.status === 'cancelled' ? labels.cancelled
          : !content ? labels.completed : '';
      addMessage('assistant', content, status, turn.error);
    }
    if (pending && !turns.has(pending.turnId)) {
      addMessage('user', pending.text);
      if (pending.error) addMessage('assistant', '', labels.failed, pending.error);
    }
    if (atBottom) messages.scrollTop = messages.scrollHeight;
  }
  function resetConversation() {
    epoch++;
    turns.clear(); buffered = []; sync = undefined; loading = false;
    failure = ''; streamId = undefined; runtimeCursor = 0; partial = false; stopping = false;
  }
  function applyEvent(payload, replay = false) {
    if (!claimed || !sessionId || payload.sessionId !== sessionId || !payload.turnId) return false;
    const source = payload.sourceEvent;
    if (!['dialog-turn-started', 'model-round-started', 'text-chunk', 'tool-event',
      'dialog-turn-completed', 'dialog-turn-failed', 'dialog-turn-cancelled'].includes(source)) return false;
    const eventStream = payload.__openbitfunRuntimeStreamId;
    const cursor = payload.__openbitfunRuntimeEventCursor;
    if (!replay && eventStream && streamId && eventStream !== streamId) {
      void resync(); return false;
    }
    if (!replay && eventStream && typeof cursor === 'number') {
      if (eventStream === streamId && cursor <= runtimeCursor) return false;
      streamId = eventStream; runtimeCursor = cursor;
    }
    let turn = turns.get(payload.turnId);
    if (!turn) {
      turn = { id: payload.turnId, user: '', rounds: new Map(), attempts: new Map(), status: 'running', tool: false };
      turns.set(turn.id, turn);
    }
    if (source === 'dialog-turn-started') {
      turn.user = text(payload.originalUserInput) || text(payload.userInput);
      if (pending?.turnId === turn.id && pending.sessionId === sessionId) turn.user = pending.text;
      turn.status = 'running';
    } else if (source === 'text-chunk') {
      const key = text(payload.roundId) || turn.id;
      if (payload.attemptId && turn.attempts.get(key) !== payload.attemptId) {
        if (turn.attempts.has(key)) turn.rounds.delete(key);
        turn.attempts.set(key, payload.attemptId);
      }
      turn.rounds.set(key, (turn.rounds.get(key) || '') + text(payload.text));
      turn.tool = false;
    } else if (source === 'tool-event') {
      turn.tool = true;
    } else if (source === 'model-round-started') {
      turn.tool = false;
    } else if (source === 'dialog-turn-completed' || source === 'dialog-turn-failed' || source === 'dialog-turn-cancelled') {
      turn.status = source === 'dialog-turn-cancelled' ? 'cancelled'
        : source === 'dialog-turn-failed' || payload.success === false ? 'failed' : 'completed';
      turn.error = text(payload.error) || text(payload.message);
      stopping = false;
    }
    if (!open && !replay) unread = true;
    return true;
  }
  async function resync() {
    if (!claimed || !sessionId || !snapshotSupported) return;
    if (sync) return sync;
    const version = epoch, target = sessionId;
    loading = true; failure = ''; buffered = []; render();
    const request = (async () => {
      try {
        const snapshot = await loadSnapshot(target);
        if (epoch !== version || target !== sessionId) return;
        if (snapshot.sessionId !== target) throw new Error('Conversation snapshot identity mismatch');
        turns.clear();
        for (const turn of snapshot.turns || []) turns.set(turn.id, {
          ...turn, rounds: new Map((turn.rounds || []).map(round => [round.id, round.text])), attempts: new Map(),
        });
        partial = snapshot.isPartial === true;
        const runtime = snapshot.runtime;
        if (runtime) {
          streamId = runtime.streamId; runtimeCursor = runtime.cursor;
          for (const id of new Set(runtime.events.map(event => event.turnId).filter(Boolean))) turns.delete(id);
          for (const event of runtime.events) applyEvent(event, true);
        }
      } catch (cause) {
        if (epoch === version) failure = `${labels.historyFailed} ${String(cause instanceof Error ? cause.message : cause)}`;
      } finally {
        if (epoch === version) {
          loading = false; sync = undefined;
          const events = buffered; buffered = [];
          for (const payload of events) applyEvent(payload);
          render();
        }
      }
    })();
    sync = request;
    return request;
  }
  function setDraft(value) {
    if (!claimed) throw new Error('MiniApp has not claimed its composer');
    input.value = text(value);
    resizeInput();
    setOpen(true);
  }
  launcher.onclick = () => setOpen(true);
  collapse.onclick = () => { setOpen(false); launcher.focus(); };
  panel.onkeydown = event => {
    if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); setOpen(false); launcher.focus(); }
  };
  function resizeInput() {
    input.style.height = 'auto';
    const multiline = input.value.includes('\n') || input.scrollHeight > input.clientHeight + 2;
    surface.dataset.openbitfunLayout = multiline ? 'expanded' : 'compact';
    if (input.scrollHeight) input.style.height = `${input.scrollHeight}px`;
    send.disabled = sendDisabled();
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(entries => {
      const height = entries[0]?.borderBoxSize?.[0]?.blockSize || form.getBoundingClientRect().height;
      if (height) messages.style.paddingBlockEnd = `calc(${height}px + var(--openbitfun-space-6) + var(--openbitfun-space-6))`;
    }).observe(form);
  }
  input.oninput = resizeInput;
  input.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !sendDisabled()) {
      event.preventDefault(); form.requestSubmit();
    }
  };
  form.onsubmit = event => {
    event.preventDefault();
    if (send.disabled) return;
    const requestId = crypto.randomUUID();
    busy = requestId;
    pending = { requestId, text: input.value, sessionId };
    input.value = '';
    resizeInput();
    render();
    try { onSend({ requestId, text: pending.text, message: pending.text }); }
    catch (cause) { busy = undefined; pending.error = String(cause); render(); }
  };
  stop.onclick = async () => {
    const turn = activeTurn();
    if (!turn || stopping || !connected) return;
    const version = epoch;
    stopping = true; render();
    try { await onStop({ sessionId, turnId: turn.id }); }
    catch (cause) { if (version === epoch) failure = String(cause); }
    finally { if (version === epoch) { stopping = false; render(); } }
  };
  retry.onclick = () => { void resync(); };
  render();
  return {
    configure(options) {
      labels = options.labels; appName = options.appName; appIcon = options.appIcon || 'app'; description = options.description || '';
      snapshotSupported = options.snapshotSupported === true;
      claimed = false; open = false; busy = pending = sessionId = undefined; input.value = ''; resizeInput();
      customization = {}; connected = true; approval = unread = false;
      resetConversation(); render();
    },
    claim(params = {}) {
      claimed = true;
      const welcome = params.welcome || {};
      customization = {
        title: bounded(params.title, 120),
        placeholder: bounded(params.composer?.placeholder, 600) || bounded(params.placeholder, 600),
        welcome: { title: bounded(welcome.title, 140), description: bounded(welcome.description, 800), suggestionsLabel: bounded(welcome.suggestionsLabel, 120) },
        suggestions: (Array.isArray(welcome.suggestions) ? welcome.suggestions : []).slice(0, 6).map(item => ({
          label: bounded(typeof item === 'string' ? item : item?.label || item?.prompt, 100),
          prompt: bounded(typeof item === 'string' ? item : item?.prompt, 2000),
        })).filter(item => item.label && item.prompt),
      };
      render();
    },
    release() {
      claimed = false; open = false; busy = pending = sessionId = undefined;
      input.value = ''; resizeInput(); resetConversation(); render();
    },
    async focusSession(id) {
      if (!claimed) throw new Error('MiniApp has not claimed its composer');
      if (sessionId !== id) {
        resetConversation(); sessionId = id;
        // A first submission may create and bind its session inside the app handler.
        if (pending && !pending.sessionId) pending.sessionId = id;
        else if (pending?.sessionId !== id) pending = undefined;
      }
      setOpen(true);
      await resync();
    },
    clearSession() { sessionId = undefined; pending = undefined; input.value = ''; resizeInput(); resetConversation(); render(); },
    setDraft,
    complete(params) {
      if (!busy || params.requestId !== busy) return { completed: false };
      busy = undefined;
      if (params.error && pending) { pending.error = text(params.error); failure = pending.error; }
      render();
      return { completed: true };
    },
    getRequestId() { return busy; },
    acceptedRun(result, requestId) {
      if (!busy || busy !== requestId || !pending || pending.turnId || !result.sessionId || !result.turnId
        || pending.sessionId && pending.sessionId !== result.sessionId) return;
      pending.sessionId = result.sessionId; pending.turnId = result.turnId;
      const turn = sessionId === result.sessionId && turns.get(result.turnId);
      if (turn) turn.user = pending.text;
      render();
    },
    event(payload) {
      if (!claimed || !sessionId || payload.sessionId !== sessionId) return;
      if (loading) buffered.push(payload);
      else if (applyEvent(payload)) render();
    },
    resync,
    setConnected(value) {
      if (connected === value) return;
      const reconnecting = !connected && value;
      connected = value; render();
      if (reconnecting) void resync();
    },
    setApproval(value) { if (approval !== value) { approval = value; render(); } },
  };
}
