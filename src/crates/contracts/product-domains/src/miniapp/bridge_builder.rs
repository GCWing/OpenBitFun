//! Bridge script builder — generate window.app Runtime Adapter (OpenBitFun Hosted) for iframe.

use crate::miniapp::loopx::private_bridge_extension;
use crate::miniapp::types::{EsmDep, MiniAppPermissions};
use serde_json;

/// Build the Runtime Adapter script (JS) to inject into the iframe.
/// Exposes window.app with call(), fs.*, shell.*, net.*, os.*, storage.*, dialog.*,
/// ai.*, agent.*, deck.*, chat.*, clipboard.*, lifecycle, and events. Verified
/// built-in product surfaces may receive an additional private namespace; it
/// is not part of the public MiniApp API.
pub fn build_bridge_script(
    app_id: &str,
    app_data_dir: &str,
    workspace_dir: &str,
    appearance_mode: &str,
    platform: &str,
) -> String {
    build_bridge_script_internal(
        app_id,
        app_data_dir,
        workspace_dir,
        appearance_mode,
        platform,
        true,
    )
}

/// Marketplace compilation always receives the public MiniApp API, even if an
/// imported package attempts to spoof a reserved built-in id.
pub fn build_market_bridge_script(
    app_id: &str,
    app_data_dir: &str,
    workspace_dir: &str,
    appearance_mode: &str,
    platform: &str,
) -> String {
    build_bridge_script_internal(
        app_id,
        app_data_dir,
        workspace_dir,
        appearance_mode,
        platform,
        false,
    )
}

fn build_bridge_script_internal(
    app_id: &str,
    app_data_dir: &str,
    workspace_dir: &str,
    appearance_mode: &str,
    platform: &str,
    allow_private_builtin_extensions: bool,
) -> String {
    let app_id_esc = escape_js_str(app_id);
    let app_data_esc = escape_js_str(app_data_dir);
    let workspace_esc = escape_js_str(workspace_dir);
    let appearance_mode_esc = escape_js_str(appearance_mode);
    let platform_esc = escape_js_str(platform);
    let private_builtin_extension = if allow_private_builtin_extensions {
        private_bridge_extension(app_id).unwrap_or_default()
    } else {
        ""
    };

    format!(
        r#"
(function() {{
  const _rpc = (method, params) => {{
    return new Promise((resolve, reject) => {{
      const id = 'rpc-' + Math.random().toString(36).slice(2) + '-' + Date.now();
      const handler = (e) => {{
        if (!e.data || e.data.id !== id) return;
        window.removeEventListener('message', handler);
        if (e.data.error) reject(new Error(e.data.error.message || 'RPC error'));
        else resolve(e.data.result);
      }};
      window.addEventListener('message', handler);
      window.parent.postMessage({{ jsonrpc: '2.0', id, method, params }}, '*');
    }});
  }};

  const _call = (method, params) => _rpc('worker.call', {{ method, params: params || {{}} }});

  // Host submissions are request-scoped. Coalesce a replay while it is in
  // flight and retain a bounded result cache so a late duplicate can receive
  // the same acknowledgement without invoking MiniApp business logic twice.
  const _chatUserMessagePending = new Map();
  const _chatUserMessageOutcomes = new Map();
  const _CHAT_USER_MESSAGE_OUTCOME_LIMIT = 128;
  const _runChatUserMessage = (requestId, payload, handlers) => {{
    const completed = _chatUserMessageOutcomes.get(requestId);
    if (completed) return Promise.resolve(completed);
    const pending = _chatUserMessagePending.get(requestId);
    if (pending) return pending;

    const execution = (handlers.length
      ? Promise.all(handlers.map((handler) => {{
          try {{
            return Promise.resolve(handler(payload));
          }} catch (error) {{
            return Promise.reject(error);
          }}
        }})).then(
          () => ({{}}),
          (error) => ({{ error: error instanceof Error ? error.message : String(error) }}),
        )
      : Promise.resolve({{ error: 'MiniApp has no chat:userMessage handler.' }}))
      .then((outcome) => {{
        _chatUserMessagePending.delete(requestId);
        _chatUserMessageOutcomes.set(requestId, outcome);
        while (_chatUserMessageOutcomes.size > _CHAT_USER_MESSAGE_OUTCOME_LIMIT) {{
          const oldestRequestId = _chatUserMessageOutcomes.keys().next().value;
          if (oldestRequestId === undefined) break;
          _chatUserMessageOutcomes.delete(oldestRequestId);
        }}
        return outcome;
      }});
    _chatUserMessagePending.set(requestId, execution);
    return execution;
  }};

  function _applyAppearanceVars(vars) {{
    if (!vars || typeof vars !== 'object') return;
    const root = document.documentElement.style;
    for (const k of Object.keys(vars)) root.setProperty(k, vars[k]);
  }}

  let _appearanceMode = {appearance_mode_esc};
  // Default to en-US until the host pushes the real locale via 'openbitfun:event'.
  // The script below proactively requests it on startup.
  let _locale = 'en-US';

  const app = {{
    get appearanceMode() {{ return _appearanceMode; }},
    get locale() {{ return _locale; }},
    appId: {app_id_esc},
    appDataDir: {app_data_esc},
    workspaceDir: {workspace_esc},
    platform: {platform_esc},
    mode: 'hosted',

    call: _call,

    fs: {{
      readFile:   (p, opts) => _call('fs.readFile', {{ path: p, ...(opts||{{}}) }}),
      writeFile:  (p, data, opts) => _call('fs.writeFile', {{ path: p, data: typeof data === 'string' ? data : (data && data.toString ? data.toString() : ''), ...(opts||{{}}) }}),
      readdir:    (p, opts) => _call('fs.readdir', {{ path: p, ...(opts||{{}}) }}),
      stat:       (p) => _call('fs.stat', {{ path: p }}),
      mkdir:      (p, opts) => _call('fs.mkdir', {{ path: p, ...(opts||{{}}) }}),
      rm:         (p, opts) => _call('fs.rm', {{ path: p, ...(opts||{{}}) }}),
      copyFile:   (s, d) => _call('fs.copyFile', {{ src: s, dst: d }}),
      rename:     (o, n) => _call('fs.rename', {{ oldPath: o, newPath: n }}),
      appendFile: (p, data) => _call('fs.appendFile', {{ path: p, data: typeof data === 'string' ? data : String(data) }}),
    }},
    shell: {{ exec: (cmd, opts) => _call('shell.exec', Array.isArray(cmd) ? {{ args: cmd, ...(opts||{{}}) }} : {{ command: cmd, ...(opts||{{}}) }}) }},
    net:   {{ fetch: (url, opts) => _call('net.fetch', {{ url: typeof url === 'string' ? url : (url && url.url), ...(opts||{{}}) }}) }},
    os:    {{ info: () => _call('os.info', {{}}) }},
    system: {{
      openExternal: (url) => _rpc('system.openExternal', {{ url }}),
      revealInFolder: (path) => _rpc('system.revealInFolder', {{ path }}),
    }},
    storage: {{
      get: (key) => _call('storage.get', {{ key }}),
      set: (key, value) => _call('storage.set', {{ key, value }}),
    }},

    dialog: {{
      open:    (opts) => _rpc('dialog.open', opts || {{}}),
      save:    (opts) => _rpc('dialog.save', opts || {{}}),
      message: (opts) => _rpc('dialog.message', opts || {{}}),
    }},

    // AI namespace — proxies to host application AI client (no API key exposure).
    _aiStreams: {{}},
    ai: {{
      complete: (prompt, opts) => _rpc('ai.complete', {{ prompt, ...(opts || {{}}) }}),
      chat: (messages, opts) => {{
        const streamId = 'ai-stream-' + Math.random().toString(36).slice(2) + '-' + Date.now();
        const handlers = {{
          onChunk: opts && opts.onChunk,
          onDone:  opts && opts.onDone,
          onError: opts && opts.onError,
        }};
        app._aiStreams[streamId] = handlers;
        const rpcOpts = {{}};
        if (opts) {{
          if (opts.systemPrompt !== undefined) rpcOpts.systemPrompt = opts.systemPrompt;
          if (opts.model !== undefined) rpcOpts.model = opts.model;
          if (opts.maxTokens !== undefined) rpcOpts.maxTokens = opts.maxTokens;
          if (opts.temperature !== undefined) rpcOpts.temperature = opts.temperature;
        }}
        return _rpc('ai.chat', {{ messages, streamId, ...rpcOpts }}).then((result) => ({{
          streamId: result && result.streamId ? result.streamId : streamId,
          cancel: () => _rpc('ai.cancel', {{ streamId }}),
        }}));
      }},
      cancel:    (streamId) => _rpc('ai.cancel', {{ streamId }}),
      getModels: () => _rpc('ai.getModels', {{}}),
    }},

    // Agent namespace — full host agent turns (agent loop with tools and skills).
    // Requires manifest permissions.agent.enabled = true; enforced host-side.
    // `opts.displayText` may carry the user's original request for the shared
    // chat surface while `prompt` remains the MiniApp's internal agent protocol.
    // `opts.contextFiles` may carry bounded context published by the host as a
    // per-run virtual read-only snapshot.
    agent: {{
      ensureSession:  (opts) => _rpc('agent.ensureSession', opts || {{}}),
      run:            (prompt, opts) => _rpc('agent.run', {{ prompt, ...(opts || {{}}) }}),
      cancel:         (sessionId, turnId) => _rpc('agent.cancel', {{ sessionId, turnId }}),
      turnText:       (sessionId, turnId) => _rpc('agent.turnText', {{ sessionId, turnId }}),
      cancelStaleRuns: () => _rpc('agent.cancelStaleRuns', {{}}),
      onEvent:        (fn) => app.on('agent:event', fn),
      offEvent:       (fn) => app.off('agent:event', fn),
    }},

    {private_builtin_extension}

    // Deck namespace — renders one slide HTML page in a hidden host WebView
    // and returns base64 PNG/PDF. Used by presentation MiniApps for
    // page-by-page export rasterization.
    deck: {{
      renderPage: (opts) => _rpc('deck.renderPage', opts || {{}}),
    }},

    // Chat namespace — floating session bubble integration for agentic
    // MiniApps. While this MiniApp's tab is active, `claimComposer` routes the
    // bubble composer to the MiniApp: user messages arrive via
    // 'chat:userMessage' instead of being sent to the host chat session, and
    // `focusSession` shows one of the MiniApp's own ensureSession/agent.run
    // sessions in the bubble so agent progress renders on the shared surface.
    // `claimComposer` may also register bounded host-rendered content
    // (`title`, `composer.placeholder`, and `welcome`) in that shared surface.
    // The MiniApp contributes declarative text, prompts, and a submit route;
    // it cannot replace or resize ChatInput or inject arbitrary host markup.
    // Requires manifest permissions.agent.enabled = true; enforced host-side.
    chat: {{
      claimComposer:   (opts) => _rpc('chat.claimComposer', opts || {{}}),
      releaseComposer: () => _rpc('chat.releaseComposer', {{}}),
      clearSession:    () => _rpc('chat.clearSession', {{}}),
      focusSession:    (sessionId) => _rpc('chat.focusSession', {{ sessionId }}),
      // Opens the bubble and prefills its composer without sending, so the
      // MiniApp can offer example prompts the user still edits and submits.
      setComposerDraft: (text) => _rpc('chat.setComposerDraft', {{ text }}),
      // Returning a Promise from the callback keeps realtime voice attached
      // until MiniApp post-processing and any Agent retries have completed.
      onUserMessage:   (fn) => app.on('chat:userMessage', fn),
      offUserMessage:  (fn) => app.off('chat:userMessage', fn),
    }},

    // Clipboard namespace — proxies to host navigator.clipboard (bypasses sandbox restriction).
    clipboard: {{
      writeText: (text) => _rpc('clipboard.writeText', {{ text }}),
      readText:  () => _rpc('clipboard.readText', {{}}),
    }},

    // Notifications namespace; requires manifest permissions.notifications.system = true.
    notifications: {{
      system: (title, body) => _rpc('notifications.system', {{ title, body }}),
    }},

    _lifecycleHandlers: {{ activate: [], deactivate: [], appearanceChange: [], localeChange: [] }},
    onActivate:    (fn) => app._lifecycleHandlers.activate.push(fn),
    onDeactivate:  (fn) => app._lifecycleHandlers.deactivate.push(fn),
    onAppearanceChange: (fn) => app._lifecycleHandlers.appearanceChange.push(fn),
    /// Subscribe to host locale changes. Callback receives the locale id (e.g. "zh-CN").
    onLocaleChange: (fn) => app._lifecycleHandlers.localeChange.push(fn),

    /// Pick the best-matching string from an i18n table for the current locale.
    /// Resolution: current → zh-CN for Chinese variants → en-US → first value → fallback.
    /// Usage: app.t({{'en-US':'Hello','zh-CN':'你好','zh-TW':'你好'}}, 'Hello')
    t: (table, fallback) => {{
      if (!table || typeof table !== 'object') return fallback != null ? fallback : '';
      if (table[_locale]) return table[_locale];
      if (_locale && _locale.startsWith('zh') && table['zh-CN']) return table['zh-CN'];
      if (table['en-US']) return table['en-US'];
      if (table['zh-CN']) return table['zh-CN'];
      const keys = Object.keys(table);
      if (keys.length) return table[keys[0]];
      return fallback != null ? fallback : '';
    }},

    _eventHandlers: {{}},
    on:  (event, fn) => {{ (app._eventHandlers[event] = app._eventHandlers[event] || []).push(fn); }},
    off: (event, fn) => {{
      if (app._eventHandlers[event])
        app._eventHandlers[event] = app._eventHandlers[event].filter(f => f !== fn);
    }},
  }};

  window.addEventListener('message', (e) => {{
    if (e.data?.type === 'openbitfun:event') {{
      const {{ event, payload }} = e.data;
      if (event === 'activate')    app._lifecycleHandlers.activate.forEach(f => f());
      if (event === 'deactivate')  app._lifecycleHandlers.deactivate.forEach(f => f());
      if (event === 'appearanceChange') {{
        if (payload && typeof payload === 'object') {{
          if (payload.vars) _applyAppearanceVars(payload.vars);
          if (payload.id) document.documentElement.setAttribute('data-openbitfun-appearance', payload.id);
          if (payload.mode) {{ _appearanceMode = payload.mode; document.documentElement.setAttribute('data-openbitfun-appearance-mode', _appearanceMode); }}
        }}
        app._lifecycleHandlers.appearanceChange.forEach(f => f(payload));
        (app._eventHandlers[event] || []).forEach(f => f(payload));
      }} else if (event === 'localeChange') {{
        if (payload && typeof payload === 'object' && typeof payload.locale === 'string') {{
          _locale = payload.locale;
          document.documentElement.setAttribute('lang', _locale);
        }}
        app._lifecycleHandlers.localeChange.forEach(f => f(_locale));
        (app._eventHandlers[event] || []).forEach(f => f(_locale));
      }} else if (event === 'ai:stream') {{
        // Route AI stream chunks to the registered callbacks
        if (payload && payload.streamId) {{
          const h = app._aiStreams[payload.streamId];
          if (h) {{
            if (payload.type === 'chunk' && h.onChunk) h.onChunk(payload.data || {{}});
            if (payload.type === 'done') {{
              if (h.onDone) h.onDone(payload.data || {{}});
              delete app._aiStreams[payload.streamId];
            }}
            if (payload.type === 'error') {{
              if (h.onError) h.onError(payload.data || {{}});
              delete app._aiStreams[payload.streamId];
            }}
          }}
        }}
      }} else if (event === 'worker:event') {{
        // Forward Worker push events to registered app.on('worker:*', ...) handlers
        if (payload && payload.event) {{
          const evtKey = 'worker:' + payload.event;
          (app._eventHandlers[evtKey] || []).forEach(f => f(payload.data));
          (app._eventHandlers['worker:*'] || []).forEach(f => f(payload.event, payload.data));
        }}
      }} else if (event === 'chat:userMessage') {{
        const handlers = app._eventHandlers[event] || [];
        const requestId = payload && typeof payload.requestId === 'string'
          ? payload.requestId
          : '';
        if (!requestId) {{
          handlers.forEach(f => f(payload));
        }} else {{
          void _runChatUserMessage(requestId, payload, handlers)
            .then((outcome) => _rpc('chat.completeUserMessage', {{ requestId, ...outcome }}))
            .catch(() => undefined);
        }}
      }} else {{
        (app._eventHandlers[event] || []).forEach(f => f(payload));
      }}
    }}
  }});

  window.app = app;
  document.documentElement.setAttribute('data-openbitfun-appearance-mode', _appearanceMode);
  window.parent.postMessage({{ method: 'openbitfun/request-appearance' }}, '*');
  window.parent.postMessage({{ method: 'openbitfun/request-locale' }}, '*');
}})();
"#,
        app_id_esc = app_id_esc,
        app_data_esc = app_data_esc,
        workspace_esc = workspace_esc,
        appearance_mode_esc = appearance_mode_esc,
        platform_esc = platform_esc,
        private_builtin_extension = private_builtin_extension,
    )
}

fn escape_js_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Build Import Map script tag from ESM dependencies (esm.sh URLs).
pub fn build_import_map(deps: &[EsmDep]) -> String {
    let mut imports = serde_json::Map::new();
    for dep in deps {
        let url = dep.url.clone().unwrap_or_else(|| match &dep.version {
            Some(v) => format!("https://esm.sh/{}@{}", dep.name, v),
            None => format!("https://esm.sh/{}", dep.name),
        });
        imports.insert(dep.name.clone(), serde_json::Value::String(url));
    }
    let json = serde_json::json!({ "imports": imports });
    format!(r#"<script type="importmap">{}</script>"#, json)
}

/// Build CSP meta content from permissions (net.allow → connect-src).
pub fn build_csp_content(permissions: &MiniAppPermissions) -> String {
    let net_allow = permissions
        .net
        .as_ref()
        .and_then(|n| n.allow.as_ref())
        .map(|v| v.iter().map(|d| d.as_str()).collect::<Vec<_>>())
        .unwrap_or_default();

    let connect_src = if net_allow.is_empty() {
        "'self'".to_string()
    } else if net_allow.contains(&"*") {
        "'self' *".to_string()
    } else {
        let safe: Vec<String> = net_allow
            .iter()
            .map(|d| {
                d.replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
                    .replace('"', "&quot;")
            })
            .collect();
        format!("'self' https://esm.sh {}", safe.join(" "))
    };

    format!(
        "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; connect-src 'self' {}; img-src 'self' data: https:; font-src 'self' https:; object-src 'none'; base-uri 'self';",
        connect_src
    )
}

/// CSP for reviewed marketplace MiniApps.
///
/// Marketplace code is immutable after review and may only reach the network
/// through the trusted `app.net.fetch` host bridge. Inline code is required
/// because the compiler assembles the reviewed package into a single `srcdoc`
/// document, but remote scripts, eval, frames, workers and direct connections
/// are all denied.
pub fn build_market_csp_content() -> &'static str {
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src data: blob:; font-src data:; media-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';"
}

/// Scroll boundary script (reuse same logic as MCP App).
pub fn scroll_boundary_script() -> &'static str {
    r#"<script>(()=>{const s=(e)=>{for(let n=e.target;n;n=n.parentNode){if(!(n instanceof Element))continue;if(n===document.documentElement||n===document.body)continue;const o=window.getComputedStyle(n).overflowY;if(o==='hidden'||o==='visible')continue;if(e.deltaY<0&&n.scrollTop>0)return false;if(e.deltaY>0&&n.scrollTop+n.clientHeight<n.scrollHeight)return false;}return true};window.addEventListener('wheel',e=>{if(!e.defaultPrevented&&s(e))window.parent.postMessage({jsonrpc:'2.0',method:'openbitfun/sandbox-wheel',params:{deltaX:e.deltaX,deltaY:e.deltaY,deltaZ:e.deltaZ,deltaMode:e.deltaMode}},'*')},{passive:true});})();</script>"#
}

/// Minimal MiniApp iframe first-paint contract before the host sends Appearance variables.
pub fn build_miniapp_default_appearance_css() -> &'static str {
    include_str!("generated/default_appearance_style.html")
}
