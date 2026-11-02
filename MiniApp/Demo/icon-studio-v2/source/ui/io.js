(() => {
  const S = IconStudio, G = IconGeometry, $ = S.$;
  const storageKey = 'icon-studio-project-v1';
  let timer, dirty = false, queued = null, writing = false, drainPromise = Promise.resolve();
  const errorKey = (error, fallback) => Object.hasOwn(StudioMessages['en-US'], error?.message) ? error.message : fallback;
  async function drain() {
    writing = true;
    try {
      while (queued) {
        const snapshot = queued; queued = null;
        try {
        if (S.host) {
          if (!S.host.storage?.set) throw new Error('storageFailed');
          await S.host.storage.set(storageKey, snapshot);
        } else localStorage.setItem(storageKey, JSON.stringify(snapshot));
        } catch { S.status('storageFailed', 'warning'); }
      }
    } finally { writing = false; }
  }
  S.flushSave = () => {
    clearTimeout(timer); timer = null;
    if (dirty) { queued = S.snapshot(); dirty = false; }
    // drain() invokes the host before its first await, so pagehide does not
    // leave a new save request waiting in a cancelled debounce timer.
    if (queued && !writing) drainPromise = drain();
    return drainPromise;
  };
  S.autosave = () => {
    dirty = true; clearTimeout(timer);
    timer = setTimeout(S.flushSave, 400);
  };
  S.restore = async () => {
    const revision = S.revision;
    try {
      const saved = S.host ? await S.host.storage?.get?.(storageKey) : JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (saved == null || S.revision !== revision || S.busy || S.draft) return;
      S.doc = G.normalizeProject(saved); S.selected = S.doc.shapes.at(-1)?.id || null;
      S.render(); S.status('restored');
    } catch { S.status('storageInvalid', 'warning'); }
  };
  async function saveFile(text, filename, extension, mime) {
    if (S.busy || S.saving) return;
    S.finishDraft(false);
    S.saving = true; S.render();
    try {
      if (S.host) {
        if (!S.host.dialog?.save || !S.host.fs?.writeFile) { S.status('unsupportedSave', 'error'); return; }
        const path = await S.host.dialog.save({ title: filename, defaultPath: filename, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
        if (!path) return;
        await S.host.fs.writeFile(path, text, { encoding: 'utf-8' }); S.status('saved');
      } else {
        const link = document.createElement('a'); link.download = filename;
        link.href = `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
        document.body.append(link); link.click(); link.remove(); S.status('downloaded');
      }
    } catch { S.status('saveFailed', 'error'); }
    finally { S.saving = false; S.render(); }
  }
  const filename = () => (S.doc.name.trim().replace(/[^a-zA-Z0-9_-]+/g, '-') || 'icon').slice(0, 64);
  S.saveProject = () => {
    S.finishDraft(false);
    return saveFile(JSON.stringify(S.doc, null, 2), `${filename()}.icon.json`, 'json', 'application/json');
  };
  S.exportSVG = () => {
    S.finishDraft(false);
    if (!S.doc.shapes.some(s => s.visible && (s.fill || s.stroke))) { S.status('emptyExport', 'warning'); return; }
    return saveFile(G.exportSVG(S.doc), `${filename()}.svg`, 'svg', 'image/svg+xml');
  };
  S.trace = async () => {
    if (!S.source || S.busy || S.saving) return;
    S.finishDraft(false);
    const job = ++S.job, revision = S.revision;
    S.busy = true; S.render(); S.status('tracing');
    try {
      const output = await IconTrace.trace(S.source, {
        contrast: Number($('trace-contrast').value), simplify: Number($('trace-simplify').value),
        smoothing: Number($('trace-smoothing').value), minArea: Number($('trace-minArea').value),
      }, () => job !== S.job || revision !== S.revision);
      if (job !== S.job || revision !== S.revision) return;
      S.busy = false;
      S.change(() => S.add(output.shape, S.t('traceLayer')));
      S.tool = 'node'; S.node = null; S.render(); S.status('traced');
    } catch (error) {
      if (job === S.job && error.message !== 'cancelled') S.status(errorKey(error, 'traceFailed'), 'error');
    } finally { if (job === S.job) { S.busy = false; S.render(); } }
  };
  const readURL = file => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file);
  });
  S.load = async file => {
    if (S.busy || S.saving) { S.status('busy'); return; }
    if (S.draft) S.finishDraft(false);
    if (file.size > 20 * 1024 * 1024) { S.status('invalidImage', 'error'); return; }
    if (/\.json$/i.test(file.name)) {
      S.busy = true; S.render();
      try {
        if (file.size > 4 * 1024 * 1024) throw new Error('invalidProject');
        const next = G.normalizeProject(JSON.parse(await file.text()));
        S.busy = false;
        S.change(() => { S.doc = next; S.selected = next.shapes.at(-1)?.id || null; S.node = null; });
        S.source = null; S.referenceURL = ''; S.render(); S.status('imported');
      } catch { S.status('invalidProject', 'error'); }
      finally { S.busy = false; S.render(); }
      return;
    }
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) && !(file.type === '' && /\.(png|jpe?g|webp)$/i.test(file.name))) { S.status('invalidImage', 'error'); return; }
    const job = ++S.job;
    S.busy = true; S.render(); S.status('tracing');
    try {
      const source = await readURL(file), image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = source; });
      if (job !== S.job) return;
      const w = image.naturalWidth, h = image.naturalHeight;
      if (!w || !h || w * h > 16000000 || w > 8192 || h > 8192) throw new Error('invalidImage');
      const scale = Math.min(1, 512 / Math.max(w, h));
      const buffer = document.createElement('canvas'); buffer.width = Math.max(1, Math.round(w * scale)); buffer.height = Math.max(1, Math.round(h * scale));
      const context = buffer.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0, buffer.width, buffer.height);
      S.source = context.getImageData(0, 0, buffer.width, buffer.height);
      S.referenceURL = buffer.toDataURL('image/png'); $('show-reference').checked = true;
      S.busy = false; S.render(); await S.trace();
    } catch (error) {
      if (job === S.job) S.status(errorKey(error, 'invalidImage'), 'error');
    } finally { if (job === S.job) { S.busy = false; S.render(); } }
  };
  $('import').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', event => { const file = event.target.files?.[0]; if (file) void S.load(file); event.target.value = ''; });
  $('export').addEventListener('click', S.exportSVG); $('project').addEventListener('click', S.saveProject); $('trace').addEventListener('click', S.trace);
  $('copy').addEventListener('click', async () => {
    S.finishDraft(false);
    if (!S.doc.shapes.some(s => s.visible && (s.fill || s.stroke))) { S.status('emptyExport', 'warning'); return; }
    const svg = G.exportSVG(S.doc);
    try { if (S.host) await S.host.clipboard.writeText(svg); else await navigator.clipboard.writeText(svg); S.status('copied'); }
    catch { S.status('copyFailed', 'warning'); }
  });
  let dragDepth = 0;
  document.addEventListener('dragenter', event => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault(); dragDepth++; document.body.classList.add('dragging');
  });
  document.addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault(); });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
  document.addEventListener('drop', event => {
    event.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    const file = event.dataTransfer?.files?.[0]; if (file) void S.load(file);
  });
  document.addEventListener('paste', event => {
    if (event.target.matches('input, textarea') || event.target.isContentEditable) return;
    const file = Array.from(event.clipboardData?.files || []).find(f => f.type.startsWith('image/'));
    if (file) { event.preventDefault(); void S.load(file); }
  });
  window.addEventListener('pagehide', () => {
    S.job++;
    void S.flushSave();
  });
  S.host?.onDeactivate?.(() => { void S.flushSave(); });
})();
