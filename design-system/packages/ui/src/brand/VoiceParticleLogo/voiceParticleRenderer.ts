import { clamp, effectProfiles, lerp, particleForce, VoiceParticleAudioState, type ParticleMotion, type VoiceEnergy, type VoiceParticleAudio } from './voiceParticleDynamics';

// The provided logo contour is kept verbatim, including its asymmetric inner cutout.
const LOGO_PATH = "M309.959 16.0769C347.087 -5.35899 392.831 -5.35896 429.959 16.0769L679.919 160.39C717.047 181.826 739.919 221.442 739.919 264.314V552.942C739.919 595.814 717.047 635.429 679.919 656.865L429.959 801.179C392.831 822.615 347.087 822.615 309.959 801.179L60 656.865C22.8719 635.429 8.5819e-05 595.814 0 552.942V264.313C0.000173083 221.442 22.872 181.826 60 160.39L309.959 16.0769ZM249.035 119.18C220.454 119.18 194.044 134.428 179.753 159.18L58.8281 368.628C44.5375 393.38 44.5375 423.876 58.8281 448.628L179.753 658.075C194.043 682.827 220.453 698.075 249.034 698.075H490.884C519.465 698.075 545.875 682.827 560.166 658.075L681.091 448.628C695.381 423.876 695.381 393.38 681.091 368.628L560.166 159.18C545.875 134.428 519.465 119.18 490.884 119.18H249.035Z";
const BASE_SVG_VIEWBOX = { width: 740, height: 818 };
const MAX_SHAPE_WIDTH = 560;
const MAX_SHAPE_HEIGHT = 620;
const PARTICLE_POOL_DENSITY = 1.7;
// Fixed simulation coordinates preserve the Demo's particle size, count and forces
// when embedded in a compact panel. Only the final canvas projection is resized.
const width = 720;
const height = 800;
interface Anchor { x: number; y: number; a: number; baseR: number; bias: number; centerDist: number }
interface Particle extends ParticleMotion { vx: number; vy: number; anchorIndex: number; size: number; sizePhase: number; sizeSpeed: number; centerDist: number; bias: number }
interface Bounds { minX: number; minY: number; maxX: number; maxY: number; cx: number; cy: number }

/** Canvas-only renderer. It never captures audio, owns a call, or starts a timer. */
export function createVoiceParticleRenderer(canvas: HTMLCanvasElement, foreground: string, background: string) {
  const context = canvas.getContext('2d');
  if (!context) return null;
  const ctx = context;
  const solidLogo = new Path2D(LOGO_PATH);
  let particles: Particle[] = [];
  let anchors: Anchor[] = [];
  let sourceBounds: Bounds | null = null;
  let outerBoundary: Path2D | null = null;
  let boundaryRows: Float64Array | null = null;
  let boundaryScale = 1, boundaryX = 0, boundaryY = 0;
  const audioState = new VoiceParticleAudioState();
  const particleLayout = () => ({ x: 0, width, cx: width * 0.5 });
  // Resolve the monochrome ramp from the host's semantic colors once. At the
  // default endpoints this is exactly the Demo's 0..255 grayscale ramp.
  const swatch = document.createElement('canvas');
  swatch.width = 256;
  swatch.height = 1;
  const swatchContext = swatch.getContext('2d', { willReadFrequently: true });
  if (!swatchContext) return null;
  const palette: string[] = [];
  function setColors(nextForeground: string, nextBackground: string) {
    foreground = nextForeground;
    background = nextBackground;
    const paint = swatchContext!;
    paint.globalAlpha = 1;
    paint.fillStyle = background;
    paint.fillRect(0, 0, 256, 1);
    paint.fillStyle = foreground;
    for (let shade = 0; shade < 256; shade++) {
      paint.globalAlpha = shade / 255;
      paint.fillRect(shade, 0, 1, 1);
    }
    const pixels = paint.getImageData(0, 0, 256, 1).data;
    for (let shade = 0; shade < 256; shade++) {
      const offset = shade * 4;
      palette[shade] = `rgb(${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]})`;
    }
  }
  setColors(foreground, background);

  function insideBoundary(x: number, y: number) {
    const row = Math.floor((y - boundaryY) / boundaryScale);
    if (!boundaryRows || row < 0 || row >= boundaryRows.length / 2) return false;
    const localX = (x - boundaryX) / boundaryScale;
    return localX >= boundaryRows[row * 2]! && localX < boundaryRows[row * 2 + 1]!;
  }

  function captureOuterBoundary(img: ImageData, offsetX = 0, offsetY = 0) {
    const path = new Path2D();
    boundaryRows = new Float64Array(img.height * 2);
    boundaryRows.fill(Infinity);
    boundaryScale = 1;
    boundaryX = offsetX;
    boundaryY = offsetY;
    // Fill between the outermost occupied pixels, retaining the logo's inner flow area.
    for (let y = 0; y < img.height; y++) {
      let left = -1, right = -1;
      for (let x = 0; x < img.width; x++) {
        if (img.data[(y * img.width + x) * 4 + 3]! > 18) {
          if (left < 0) left = x;
          right = x;
        }
      }
      if (left >= 0) {
        path.rect(left + offsetX, y + offsetY, right - left + 1, 1);
        boundaryRows[y * 2] = left;
        boundaryRows[y * 2 + 1] = right + 1;
      }
    }
    outerBoundary = path;
  }

  function buildFallbackShape() {
    const path = new Path2D(LOGO_PATH);
    const pts: Anchor[] = [];
    const layout = particleLayout();
    const cx = layout.cx;
    const cy = height * 0.5;
    const availableWidth = Math.min(layout.width * 0.88, MAX_SHAPE_WIDTH);
    const availableHeight = Math.min(height * 0.78, MAX_SHAPE_HEIGHT);
    const scale = Math.min(
      availableWidth / BASE_SVG_VIEWBOX.width,
      availableHeight / BASE_SVG_VIEWBOX.height,
    );
    const drawW = BASE_SVG_VIEWBOX.width * scale;
    const drawH = BASE_SVG_VIEWBOX.height * scale;
    const offX = cx - drawW * 0.5;
    const offY = cy - drawH * 0.5;
    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.floor(drawW));
    off.height = Math.max(1, Math.floor(drawH));
    const octx = off.getContext('2d', { willReadFrequently: true });
    if (!octx) return pts;
    octx.clearRect(0, 0, off.width, off.height);
    octx.save();
    octx.setTransform(scale, 0, 0, scale, -BASE_SVG_VIEWBOX.width * 0.5 * scale + off.width * 0.5, -BASE_SVG_VIEWBOX.height * 0.5 * scale + off.height * 0.5);
    octx.fillStyle = foreground;
    octx.fill(path);
    octx.restore();
    const img = octx.getImageData(0, 0, off.width, off.height);
    captureOuterBoundary(img, offX, offY);
    const target = Math.floor(2200 * PARTICLE_POOL_DENSITY);
    const step = Math.max(1, Math.floor(Math.sqrt((off.width * off.height) / Math.max(target * 2, 1))));
    const centerX = off.width * 0.5;
    const centerY = off.height * 0.5;
    const maxDist = Math.hypot(centerX, centerY) || 1;
    for (let y = 0; y < off.height; y += step) {
      for (let x = 0; x < off.width; x += step) {
        const idx = (y * off.width + x) * 4;
        if (img.data[idx + 3]! < 8) continue;
        const dx = x - centerX;
        const dy = y - centerY;
        const centerDist = Math.hypot(dx, dy) / maxDist;
        const shell = clamp(centerDist, 0, 1);
        const keep = 0.06 + 0.94 * Math.pow(shell, 1.8);
        if (Math.random() > keep) continue;
        pts.push({
          x: offX + x,
          y: offY + y,
          a: Math.atan2(dy, dx),
          baseR: 1,
          bias: keep,
          centerDist: shell,
        });
      }
    }
    return pts;
  }

  function normalizePoints(points: Anchor[]) {
    if (!points.length) return points;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const bw = maxX - minX;
    const bh = maxY - minY;
    const layout = particleLayout();
    const availableWidth = Math.min(layout.width * 0.88, MAX_SHAPE_WIDTH);
    const availableHeight = Math.min(height * 0.78, MAX_SHAPE_HEIGHT);
    const scale = Math.min(
      availableWidth / Math.max(1, bw),
      availableHeight / Math.max(1, bh),
    );
    const ox = layout.x + (layout.width - bw * scale) * 0.5;
    const oy = (height - bh * scale) * 0.5;
    if (outerBoundary) {
      const transformed = new Path2D();
      transformed.addPath(outerBoundary, new DOMMatrix([scale, 0, 0, scale, ox - minX * scale, oy - minY * scale]));
      outerBoundary = transformed;
      boundaryX = boundaryX * scale + ox - minX * scale;
      boundaryY = boundaryY * scale + oy - minY * scale;
      boundaryScale *= scale;
    }
    return points.map(p => ({
      x: (p.x - minX) * scale + ox,
      y: (p.y - minY) * scale + oy,
      a: p.a,
      baseR: p.baseR || 1,
      bias: p.bias,
      centerDist: p.centerDist,
    }));
  }

  function buildSourceBounds() {
    if (!anchors.length) {
      sourceBounds = null;
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of anchors) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    sourceBounds = { minX, minY, maxX, maxY, cx: (minX + maxX) * 0.5, cy: (minY + maxY) * 0.5 };
  }

  function rebuildParticles(points: Anchor[]) {
    anchors = normalizePoints(points);
    if (!anchors.length) return;
    const targetCount = Math.max(800, Math.floor(anchors.length * PARTICLE_POOL_DENSITY));
    const next: Particle[] = [];
    for (let i = 0; i < targetCount; i++) {
      const anchorIndex = Math.floor(Math.random() * anchors.length);
      const anchor = anchors[anchorIndex]!;
      next.push({
        x: anchor.x,
        y: anchor.y,
        vx: 0,
        vy: 0,
        anchorIndex,
        seed: Math.random() * 1000,
        motionPhase: Math.random() * Math.PI * 2,
        motionSpeed: 0.0011 + Math.random() * 0.0018,
        size: 0.45 + Math.pow(Math.random(), 2) * 2.35,
        sizePhase: Math.random() * Math.PI * 2,
        sizeSpeed: 0.0005 + Math.random() * 0.001,
        centerDist: anchor.centerDist ?? 0.5,
        bias: anchor.bias ?? 0.5,
      });
    }
    particles = next;
    buildSourceBounds();
  }

  function drawParticles(time: number, energy: VoiceEnergy, animate: boolean, formation: number) {
    if (!particles.length || !anchors.length) return;
    const scope = Math.min(particleLayout().width, height, MAX_SHAPE_HEIGHT);
    const visibleProfile = audioState.mode === 'ai' ? effectProfiles.ai : effectProfiles.human;
    const centerPulse = Math.sin(time * 0.0011) * 0.6 + 0.9;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (const p of particles) {
      const anchor = anchors[p.anchorIndex % anchors.length]!;
      if (animate) {
        const f = particleForce(p, anchor, time, energy);
        p.vx += f.ax;
        p.vy += f.ay;
        const spring = audioState.mode === 'ai' ? 0.034 : 0.05;
        p.vx += (anchor.x - p.x) * spring * 0.0012;
        p.vy += (anchor.y - p.y) * spring * 0.0012;
        p.vx *= 0.92;
        p.vy *= 0.92;
        p.x += p.vx;
        p.y += p.vy;
        if (outerBoundary) {
          if (!insideBoundary(p.x, p.y)) {
            let inside = 0, outside = 1;
            for (let step = 0; step < 12; step++) {
              const t = (inside + outside) * 0.5;
              if (insideBoundary(lerp(anchor.x, p.x, t), lerp(anchor.y, p.y, t))) inside = t;
              else outside = t;
            }
            p.x = lerp(anchor.x, p.x, inside * 0.98);
            p.y = lerp(anchor.y, p.y, inside * 0.98);
            p.vx *= 0.35;
            p.vy *= 0.35;
          }
        }

      }
      const dx = p.x - anchor.x;
      const dy = p.y - anchor.y;
      const dist = Math.hypot(dx, dy);
      const distWeight = clamp(1 - dist / (scope * 0.22), 0, 1);
      const breath = 0.55 + 0.45 * Math.sin(time * 0.0014 + p.seed * 0.7);
      const aiTint = clamp(energy.ai * 0.6 + energy.base * 0.2, 0, 1);
      const centerRange = 0.42;
      const centerCx = sourceBounds ? sourceBounds.cx : width * 0.5;
      const centerCy = sourceBounds ? sourceBounds.cy : height * 0.5;
      const shapeRadius = sourceBounds
        ? Math.min(sourceBounds.maxX - sourceBounds.minX, sourceBounds.maxY - sourceBounds.minY) * 0.5
        : scope * 0.42;
      const centerRadius = Math.max(1, shapeRadius * centerRange);
      const centerDist = Math.hypot(p.x - centerCx, p.y - centerCy);
      const radialPosition = clamp(centerDist / centerRadius, 0, 1);
      // Concentrate the transition near the circle's edge; leave the exterior unchanged.
      const transition = clamp((radialPosition - 0.35) / 0.65, 0, 1);
      const keepProbability = 0.04 + 0.96 * transition * transition * (3 - 2 * transition);
      const beamPhase = anchor.x * 0.024 - anchor.y * 0.017 - time * 0.006;
      const beamFocus = Math.pow((Math.sin(beamPhase) + 1) * 0.5, 6);
      const beamIntensity = audioState.mode === 'ai'
        ? clamp(energy.aiBreath * 0.9 + energy.ai * 0.22, 0, 1)
        : 0;
      const beamVisibility = 1 - beamIntensity * 0.38 + beamFocus * beamIntensity * 0.92;
      // A stable per-particle threshold changes density without dimming particles.
      const densityRank = (p.seed * 0.61803398875) % 1;
      if (densityRank > clamp(keepProbability * visibleProfile.density * beamVisibility, 0, 1)) continue;
      const sizeVariation = 1 + 0.22 * Math.sin(time * p.sizeSpeed + p.sizePhase)
        + 0.1 * Math.sin(time * p.sizeSpeed * 1.73 + p.sizePhase * 2);
      const radius = p.size * sizeVariation * (0.92 + aiTint * 0.18 + distWeight * 0.22 + centerPulse * 0.08);
      const beamGlow = beamFocus * beamIntensity;
      const gray = Math.round(clamp(190 - dist * 0.08 + aiTint * 35 + breath * 16 + beamGlow * 28 + (visibleProfile.brightness - 1) * 35, 120, 255));
      const alpha = clamp((0.18 + (1 - dist / (scope * 0.18)) * 0.45 + aiTint * 0.22 + beamGlow * 0.16) * visibleProfile.brightness, 0.08, 0.9);

      ctx.fillStyle = palette[gray]!;
      ctx.globalAlpha = alpha * formation;
      // A coherent radial arc opens and closes the exact same particle pool.
      // It vanishes at either endpoint, preserving the supplied audio dynamics.
      const bloom = Math.sin(Math.PI * formation) * (0.045 + p.centerDist * 0.075);
      const radialX = anchor.x - centerCx;
      const radialY = anchor.y - centerCy;
      const x = lerp(anchor.x, p.x, formation) + (radialX - radialY * 0.35) * bloom;
      const y = lerp(anchor.y, p.y, formation) + (radialY + radialX * 0.35) * bloom;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  rebuildParticles(buildFallbackShape());
  return {
    setColors,
    resize(cssWidth: number, cssHeight: number, pixelRatio: number) {
      const dpr = clamp(pixelRatio, 1, 2);
      canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
      canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
      const scale = Math.min(cssWidth / width, cssHeight / height) * dpr;
      ctx.setTransform(scale, 0, 0, scale, (canvas.width - width * scale) * 0.5, (canvas.height - height * scale) * 0.5);
    },
    draw(time: number, audio: VoiceParticleAudio, animate = true, formation = 1) {
      ctx.save();
      ctx.resetTransform();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      if (formation < 1) {
        const scale = Math.min(MAX_SHAPE_WIDTH / BASE_SVG_VIEWBOX.width, MAX_SHAPE_HEIGHT / BASE_SVG_VIEWBOX.height);
        ctx.save();
        ctx.translate((width - BASE_SVG_VIEWBOX.width * scale) * 0.5, (height - BASE_SVG_VIEWBOX.height * scale) * 0.5);
        ctx.scale(scale, scale);
        ctx.fillStyle = foreground;
        ctx.globalAlpha = Math.pow(1 - formation, 2);
        ctx.fill(solidLogo);
        ctx.restore();
      }
      if (formation > 0) drawParticles(time, audioState.update(audio, time), animate, formation);
    },
  };
}
