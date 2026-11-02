/* ui/core.js */
// Pure pixel operations shared by the MiniApp, standalone export, and Node tests.
(() => {
  const distance = (data, offset, color) => Math.max(
    Math.abs(data[offset] - color[0]),
    Math.abs(data[offset + 1] - color[1]),
    Math.abs(data[offset + 2] - color[2]),
  );

  function validate(image) {
    if (!Number.isInteger(image.width) || !Number.isInteger(image.height)
      || image.width < 1 || image.height < 1
      || image.data.length !== image.width * image.height * 4) {
      throw new Error('Invalid RGBA image dimensions');
    }
  }

  function detectBackground(image) {
    validate(image);
    const { width, height, data } = image;
    const samples = [];
    // Sample all four edges, rather than assuming a corner belongs to the background.
    const step = Math.max(1, Math.ceil(Math.max(width, height) / 256));
    for (let x = 0; x < width; x += step) {
      samples.push(x * 4);
      if (height > 1) samples.push(((height - 1) * width + x) * 4);
    }
    for (let y = 1; y < height - 1; y += step) {
      samples.push(y * width * 4);
      if (width > 1) samples.push((y * width + width - 1) * 4);
    }
    const opaque = samples.filter(offset => data[offset + 3] >= 250);
    // Do not guess a foreground color when the image already has transparent padding.
    if (opaque.length < samples.length / 2) return null;
    const buckets = new Map();
    let winner = null;
    for (const offset of opaque) {
      const key = (data[offset] >> 4) * 256 + (data[offset + 1] >> 4) * 16 + (data[offset + 2] >> 4);
      const bucket = buckets.get(key) || [];
      bucket.push(offset);
      buckets.set(key, bucket);
      if (!winner || bucket.length > winner.length) winner = bucket;
    }
    const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const color = [0, 1, 2].map(channel => median(winner.map(offset => data[offset + channel])));
    const confidence = opaque.filter(offset => distance(data, offset, color) <= 24).length / opaque.length;
    return { color, confidence };
  }

  async function removeBackground(image, options, hooks = {}) {
    validate(image);
    const { width, height, data } = image;
    const { color, tolerance = 24, feather = 16, connected = true, decontaminate = true } = options;
    if (!Array.isArray(color) || color.length !== 3 || color.some(c => !Number.isFinite(c) || c < 0 || c > 255)
      || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 255
      || !Number.isFinite(feather) || feather < 0 || feather > 255) {
      throw new Error('Invalid background removal options');
    }
    const checkCancellation = () => {
      if (hooks.cancelled?.()) {
        const error = new Error('Image processing cancelled');
        error.name = 'AbortError';
        throw error;
      }
    };
    const yieldControl = hooks.yieldControl || (() => new Promise(resolve => setTimeout(resolve, 0)));
    const checkpoint = async () => { await yieldControl(); checkCancellation(); };
    checkCancellation();

    const count = width * height;
    const mask = new Uint8Array(count);
    const limit = Math.min(255, tolerance + feather);
    if (connected) {
      const queue = new Uint32Array(count);
      let head = 0;
      let tail = 0;
      const visit = index => {
        if (mask[index]) return;
        mask[index] = 1; // Visited foreground; each pixel is evaluated at most once.
        const offset = index * 4;
        if (data[offset + 3] === 0 || distance(data, offset, color) <= limit) {
          mask[index] = 2;
          queue[tail++] = index;
        }
      };
      for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
      for (let y = 0; y < height; y++) { visit(y * width); visit(y * width + width - 1); }
      while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        if (x > 0) visit(index - 1);
        if (x + 1 < width) visit(index + 1);
        if (index >= width) visit(index - width);
        if (index + width < count) visit(index + width);
        if (head % 65536 === 0) await checkpoint();
      }
    }

    const output = new Uint8ClampedArray(data);
    let changedPixels = 0;
    let visiblePixels = 0;
    for (let index = 0; index < count; index++) {
      const offset = index * 4;
      if (data[offset + 3] > 0 && (!connected || mask[index] === 2)) {
        const difference = distance(data, offset, color);
        let coverage = 1;
        if (difference <= tolerance) coverage = 0;
        else if (feather > 0 && difference < limit) {
          const transition = (difference - tolerance) / feather;
          coverage = transition * transition * (3 - 2 * transition);
        }
        const alpha = Math.round(data[offset + 3] * coverage);
        output[offset + 3] = alpha;
        if (alpha < data[offset + 3]) changedPixels++;
        if (alpha === 0) output.fill(0, offset, offset + 3);
        // Unblend opaque source edges from the key color, reducing white/color halos.
        // Existing partial alpha is retained without applying a second unblend.
        else if (decontaminate && coverage < 1 && data[offset + 3] === 255) {
          for (let channel = 0; channel < 3; channel++) {
            output[offset + channel] = (data[offset + channel] - color[channel] * (1 - coverage)) / coverage;
          }
        }
      }
      if (output[offset + 3] > 0) visiblePixels++;
      if (index > 0 && index % 65536 === 0) await checkpoint();
    }
    checkCancellation();
    return { data: output, width, height, changedPixels, visiblePixels };
  }

  globalThis.IconCutout = Object.freeze({ detectBackground, removeBackground });
})();

/* ui/i18n.js */
(() => {
  const messages = {
    'zh-CN': {
      title: '轻抠', subtitle: '去掉图标背景，留下透明 PNG。', local: '本地处理 · 无需联网',
      switchLanguage: 'Switch to English', theme: '切换明暗', upload: '选择一张图片',
      uploadHint: '点击上传，或将图片拖到这里；也支持粘贴图片。',
      formats: 'PNG / JPG / WebP · 最大 30 MB、1600 万像素', replace: '更换图片',
      original: '原图', result: '透明背景', pickHint: '可点击背景取色',
      originalCanvas: '原始图片，启用取色后可点击背景选择颜色', resultCanvas: '抠图结果，棋盘格表示透明区域',
      settings: '抠图设置', background: '背景颜色', auto: '自动', pick: '从原图取色', picking: '点击原图中的背景…',
      tolerance: '颜色容差', toleranceHint: '越大，去除的相近颜色越多。',
      feather: '边缘柔化', featherHint: '让背景色与主体边缘平滑过渡。',
      connected: '只去除与边缘相连的背景', connectedHint: '保留内部同色区域。取消勾选可去掉字母、镂空处的背景。',
      decontaminate: '减少边缘残留的背景色', reset: '恢复默认设置', contrast: '切换对比底色（仅预览）',
      download: '下载透明 PNG', exportHint: '保留原始尺寸，预览底色不会写入 PNG。',
      scope: '适合图标、Logo 的纯色或近似纯色背景。复杂照片、棋盘格图片、与主体相连的同色背景不适用。',
      ready: '上传一张图片即可开始。', loading: '正在读取图片…', processing: '正在抠图…',
      done: '处理完成，可以下载透明 PNG。', none: '没有找到可去除的背景。请取色、增大容差，或取消“只去除与边缘相连的背景”。',
      empty: '当前设置会清空整张图片。请减小容差或重新选择背景色。',
      transparent: '图片边缘已有透明区域，已保留原图。需要继续处理时，可手动取色。',
      uncertain: '图片边缘颜色不一致，请检查预览，必要时手动取色。',
      pickStatus: '请点击原图背景；按 Esc 退出。也可直接用颜色选择器。',
      transparentPick: '此处为透明像素，请选择有颜色的背景区域。',
      invalidType: '请选择 PNG、JPG 或 WebP 图片。', tooLarge: '图片过大：最大 30 MB、1600 万像素，单边不超过 8192 像素。',
      unreadable: '无法读取这张图片，请尝试重新导出为 PNG。',
      failed: '图片处理失败，请更换图片重试。', saveFailed: '保存失败，请重试并选择可写入的位置。',
      unsupportedSave: '此宿主不支持文件保存。请使用独立 HTML 版本下载图片。',
      saving: '正在保存 PNG…', saved: '透明 PNG 已保存。', downloaded: '已发起 PNG 下载。',
      oneFile: '请一次选择一张图片。',
    },
    'en-US': {
      title: 'Background Remover', subtitle: 'Remove the background. Keep a transparent PNG.', local: 'On-device · Offline',
      switchLanguage: '切换到中文', theme: 'Toggle theme', upload: 'Choose an image',
      uploadHint: 'Click to upload, drop an image here, or paste from your clipboard.',
      formats: 'PNG / JPG / WebP · Up to 30 MB and 16 megapixels', replace: 'Change image',
      original: 'Original', result: 'Transparent result', pickHint: 'Click background to pick',
      originalCanvas: 'Original image. Activate the color picker, then click the background.', resultCanvas: 'Cutout result. The checkerboard represents transparency.',
      settings: 'Cutout settings', background: 'Background color', auto: 'Auto', pick: 'Pick from original', picking: 'Click the background…',
      tolerance: 'Color tolerance', toleranceHint: 'Higher values remove more similar colors.',
      feather: 'Edge softness', featherHint: 'Blend the transition between background and subject.',
      connected: 'Only remove edge-connected background', connectedHint: 'Keep enclosed areas of the same color. Uncheck to remove backgrounds inside letters and holes.',
      decontaminate: 'Reduce background color on edges', reset: 'Reset settings', contrast: 'Contrast backdrop (preview only)',
      download: 'Download transparent PNG', exportHint: 'Original dimensions. The preview backdrop is never exported.',
      scope: 'For icons and logos with solid or near-solid backgrounds. Not suitable for complex photos, baked-in checkerboards, or subjects connected to a background of the same color.',
      ready: 'Choose an image to get started.', loading: 'Reading image…', processing: 'Removing background…',
      done: 'Ready. Download your transparent PNG.', none: 'No background removed. Pick a color, increase tolerance, or disable edge-connected removal.',
      empty: 'These settings remove the entire image. Reduce tolerance or pick another background color.',
      transparent: 'The edges are already transparent. The original is preserved; pick a color to remove more.',
      uncertain: 'The image edges have mixed colors. Check the preview or pick the background manually.',
      pickStatus: 'Click the original background. Press Esc to exit, or use the color input.',
      transparentPick: 'This pixel is transparent. Choose a colored background area.',
      invalidType: 'Please choose a PNG, JPG, or WebP image.', tooLarge: 'Image too large: up to 30 MB, 16 megapixels, and 8192 pixels per side.',
      unreadable: 'This image could not be read. Try exporting it as PNG.',
      failed: 'Image processing failed. Please try another image.', saveFailed: 'Could not save. Try again and choose a writable location.',
      unsupportedSave: 'This host does not support saving files. Use the standalone HTML version to download.',
      saving: 'Saving PNG…', saved: 'Transparent PNG saved.', downloaded: 'PNG download started.',
      oneFile: 'Please choose one image at a time.',
    },
  };
  globalThis.CutoutMessages = Object.freeze(messages);
})();

/* ui/main.js */
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

