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
