(() => {
  const host = window.app;
  const $ = id => document.getElementById(id);
  const originalCanvas = $('original');
  const resultCanvas = $('result');
  const originalContext = originalCanvas.getContext('2d', { willReadFrequently: true });
  const resultContext = resultCanvas.getContext('2d');
  let locale = /^(zh|yue)/i.test(host?.locale || navigator.language) ? 'zh-CN' : 'en-US';
  let image = null;
  let filename = '';
  let revision = 0;
  let loadRevision = 0;
  let timer;
  let picking = false;
  let loading = false;
  let saving = false;
  let canExport = false;
  let statusKey = 'ready';
  let statusTone = '';
  let automaticColor = null;
  const t = key => CutoutMessages[locale][key];
  const hex = color => '#' + color.map(c => c.toString(16).padStart(2, '0')).join('');
  const hexToChannels = value => [1, 3, 5].map(start => parseInt(value.slice(start, start + 2), 16));

  function status(key, tone = '') {
    statusKey = key;
    statusTone = tone;
    $('status').textContent = t(key);
    $('status').dataset.tone = tone;
  }

  function refreshActions() {
    $('controls').disabled = loading || saving;
    $('download').disabled = !canExport || loading || saving;
    $('replace').disabled = saving;
    $('choose').disabled = saving;
  }

  function setPicking(next) {
    picking = next;
    $('eyedropper').setAttribute('aria-pressed', String(next));
    $('eyedropper').textContent = t(next ? 'picking' : 'pick');
    if (next) { originalCanvas.focus(); status('pickStatus'); }
  }

  function applyLocale() {
    document.documentElement.lang = locale;
    document.title = t('title');
    document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
    document.querySelectorAll('[data-i18n-aria]').forEach(node => { node.setAttribute('aria-label', t(node.dataset.i18nAria)); });
    $('locale').textContent = locale === 'zh-CN' ? 'EN' : '中文';
    $('eyedropper').textContent = t(picking ? 'picking' : 'pick');
    status(statusKey, statusTone);
  }

  function setTheme(mode) {
    document.documentElement.dataset.openbitfunAppearanceMode = mode;
  }
  if (host) {
    setTheme(host.appearanceMode || 'dark');
    host.onAppearanceChange?.(payload => setTheme(payload.mode));
    host.onLocaleChange?.(next => { locale = /^(zh|yue)/i.test(next) ? 'zh-CN' : 'en-US'; applyLocale(); });
  } else {
    setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    $('theme').hidden = false;
  }

  function updateColor(color) {
    $('background').value = hex(color);
    $('color-value').textContent = $('background').value.toUpperCase();
  }

  function defaults() {
    $('tolerance').value = '24';
    $('feather').value = '16';
    $('tolerance-value').textContent = '24';
    $('feather-value').textContent = '16';
    $('connected').checked = true;
    $('decontaminate').checked = true;
    automaticColor = image ? IconCutout.detectBackground(image) : null;
    // The default picker value is input data, not a UI theme color.
    updateColor(automaticColor?.color || [255, 255, 255]);
    setPicking(false);
  }

  function showOriginalResult() {
    revision++;
    clearTimeout(timer);
    resultContext.putImageData(image, 0, 0);
    canExport = image.data.some((alpha, index) => index % 4 === 3 && alpha > 0);
    resultCanvas.setAttribute('aria-busy', 'false');
    status('transparent');
    refreshActions();
  }

  function schedule() {
    const current = ++revision;
    clearTimeout(timer);
    canExport = false;
    refreshActions();
    if (!image) return;
    // Hide the prior result while a new mask is pending, so a stale image cannot be saved.
    resultCanvas.style.visibility = 'hidden';
    resultCanvas.setAttribute('aria-busy', 'true');
    status('processing');
    timer = setTimeout(() => processImage(current), 100);
  }

  async function processImage(current) {
    try {
      const output = await IconCutout.removeBackground(image, {
        color: hexToChannels($('background').value),
        tolerance: Number($('tolerance').value),
        feather: Number($('feather').value),
        connected: $('connected').checked,
        decontaminate: $('decontaminate').checked,
      }, { cancelled: () => current !== revision });
      if (current !== revision) return;
      resultContext.putImageData(new ImageData(output.data, output.width, output.height), 0, 0);
      resultCanvas.style.visibility = '';
      resultCanvas.setAttribute('aria-busy', 'false');
      canExport = output.visiblePixels > 0;
      if (!output.visiblePixels) status('empty', 'warning');
      else if (!output.changedPixels) status('none', 'warning');
      else if (automaticColor && automaticColor.confidence < .65) status('uncertain', 'warning');
      else status('done');
      refreshActions();
    } catch (error) {
      if (error.name === 'AbortError' || current !== revision) return;
      resultCanvas.setAttribute('aria-busy', 'false');
      status('failed', 'error');
      refreshActions();
    }
  }

  function readDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function loadFile(file) {
    if (saving) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) && !(file.type === '' && /\.(png|jpe?g|webp)$/i.test(file.name))) {
      status('invalidType', 'error'); return;
    }
    if (file.size > 30 * 1024 * 1024) { status('tooLarge', 'error'); return; }
    const current = ++loadRevision;
    const previousCanExport = canExport;
    revision++;
    clearTimeout(timer);
    loading = true;
    refreshActions();
    status('loading');
    try {
      const source = await readDataURL(file);
      if (current !== loadRevision) return;
      const decoded = new Image();
      await new Promise((resolve, reject) => {
        decoded.onload = resolve;
        decoded.onerror = reject;
        // Data URLs also work under the hosted MiniApp's restrictive image CSP.
        decoded.src = source;
      });
      if (current !== loadRevision) return;
      const width = decoded.naturalWidth;
      const height = decoded.naturalHeight;
      if (!width || !height || width * height > 16000000 || width > 8192 || height > 8192) {
        throw new Error('tooLarge');
      }
      // Decode on a temporary canvas so a failed replacement preserves the current image.
      const scratch = document.createElement('canvas');
      scratch.width = width;
      scratch.height = height;
      const context = scratch.getContext('2d', { willReadFrequently: true });
      context.drawImage(decoded, 0, 0);
      const nextImage = context.getImageData(0, 0, width, height);
      image = nextImage;
      filename = file.name || 'image.png';
      originalCanvas.width = resultCanvas.width = width;
      originalCanvas.height = resultCanvas.height = height;
      originalContext.putImageData(image, 0, 0);
      $('filename').textContent = filename;
      $('filename').title = filename;
      // Pixel dimensions are identifiers of the raster, without locale-specific grouping.
      $('dimensions').textContent = `${width} × ${height} px`;
      $('upload').hidden = true;
      $('editor').hidden = false;
      loading = false;
      defaults();
      if (!automaticColor) {
        resultCanvas.style.visibility = '';
        showOriginalResult();
      } else schedule();
    } catch (error) {
      if (current !== loadRevision) return;
      loading = false;
      canExport = previousCanExport;
      resultCanvas.setAttribute('aria-busy', 'false');
      // If replacement cancelled an in-flight render, regenerate the preserved image.
      if (image && !canExport) schedule();
      status(error?.message === 'tooLarge' ? 'tooLarge' : 'unreadable', 'error');
    } finally {
      if (current === loadRevision) { loading = false; refreshActions(); }
    }
  }

  function acceptFiles(files) {
    if (files.length !== 1) { status('oneFile', 'warning'); return; }
    void loadFile(files[0]);
  }

  async function download() {
    if (!canExport || loading || saving) return;
    saving = true;
    const exportName = `${filename.replace(/\.[^.]+$/, '') || 'image'}-transparent.png`;
    refreshActions();
    try {
      // Freeze the current raster before awaiting a host picker or file write.
      const dataURL = resultCanvas.toDataURL('image/png');
      if (host) {
        if (!host.dialog?.save || !host.fs?.writeFile) { status('unsupportedSave', 'error'); return; }
        const path = await host.dialog.save({
          title: t('download'), defaultPath: exportName,
          filters: [{ name: 'PNG', extensions: ['png'] }],
        });
        if (!path) { status('done'); return; }
        status('saving');
        await host.fs.writeFile(path, dataURL.slice(dataURL.indexOf(',') + 1), { encoding: 'base64' });
        status('saved');
      } else {
        const link = document.createElement('a');
        link.download = exportName;
        link.href = dataURL;
        document.body.append(link);
        link.click();
        link.remove();
        status('downloaded');
      }
    } catch {
      status('saveFailed', 'error');
    } finally { saving = false; refreshActions(); }
  }

  $('choose').addEventListener('click', () => $('file').click());
  $('replace').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', event => {
    const files = Array.from(event.target.files || []);
    if (files.length) acceptFiles(files);
    event.target.value = '';
  });
  let dragDepth = 0;
  document.addEventListener('dragenter', event => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault(); dragDepth++; document.body.classList.add('dragging');
  });
  document.addEventListener('dragover', event => {
    if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
  });
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('dragging');
  });
  document.addEventListener('drop', event => {
    event.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
    if (event.dataTransfer?.files.length) acceptFiles(Array.from(event.dataTransfer.files));
  });
  document.addEventListener('paste', event => {
    const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'));
    if (files.length) { event.preventDefault(); acceptFiles(files); }
  });
  $('background').addEventListener('input', () => {
    automaticColor = null;
    $('color-value').textContent = $('background').value.toUpperCase();
    schedule();
  });
  for (const key of ['tolerance', 'feather']) {
    $(key).addEventListener('input', () => { $(`${key}-value`).textContent = $(key).value; schedule(); });
  }
  for (const key of ['connected', 'decontaminate']) $(key).addEventListener('change', schedule);
  $('auto').addEventListener('click', () => {
    automaticColor = IconCutout.detectBackground(image);
    setPicking(false);
    if (automaticColor) { updateColor(automaticColor.color); schedule(); }
    else { resultCanvas.style.visibility = ''; showOriginalResult(); }
  });
  $('reset').addEventListener('click', () => {
    defaults();
    if (automaticColor) schedule();
    else { resultCanvas.style.visibility = ''; showOriginalResult(); }
  });
  $('eyedropper').addEventListener('click', () => setPicking(!picking));
  originalCanvas.addEventListener('click', event => {
    if (!image || loading || saving) return;
    // Canvas itself has its intrinsic aspect ratio; no object-fit letterbox is sampled.
    const box = originalCanvas.getBoundingClientRect();
    const x = Math.min(image.width - 1, Math.max(0, Math.floor((event.clientX - box.left) / box.width * image.width)));
    const y = Math.min(image.height - 1, Math.max(0, Math.floor((event.clientY - box.top) / box.height * image.height)));
    const offset = (y * image.width + x) * 4;
    if (!image.data[offset + 3]) { status('transparentPick', 'warning'); return; }
    updateColor(Array.from(image.data.slice(offset, offset + 3)));
    automaticColor = null;
    setPicking(false);
    schedule();
  });
  originalCanvas.addEventListener('keydown', event => {
    if (event.key === 'Escape') { setPicking(false); status('done'); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('background').click(); }
  });
  $('contrast').addEventListener('change', () => $('result-stage').classList.toggle('contrast', $('contrast').checked));
  $('download').addEventListener('click', download);
  $('locale').addEventListener('click', () => { locale = locale === 'zh-CN' ? 'en-US' : 'zh-CN'; applyLocale(); });
  $('theme').addEventListener('click', () => setTheme(document.documentElement.dataset.openbitfunAppearanceMode === 'dark' ? 'light' : 'dark'));
  window.addEventListener('pagehide', () => { revision++; loadRevision++; clearTimeout(timer); });
  defaults();
  applyLocale();
  refreshActions();
})();
