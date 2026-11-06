/** Native SVG geometry contract; deliberately outside performance windows. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

export async function verifySubagentMotion(page, repo) {
  const playerPath = 'design-system/packages/ui/src/brand/subagent/subagentMotionPlayer.ts';
  const reference = process.env.OPENBITFUN_MOTION_REFERENCE_COMMIT || 'HEAD';
  const oldSource = execFileSync('git', ['show', `${reference}:${playerPath}`], { cwd: repo, windowsHide: true, encoding: 'utf8' });
  const newSource = await readFile(path.join(repo, playerPath), 'utf8');
  const clips = await readFile(path.join(repo, 'design-system/packages/ui/src/brand/subagent/subagentMotion.ts'), 'utf8');
  const compile = source => ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  // Compile in Node. The native driver executes this ordinary function in its
  // real WebView; there is no DOM, animation, geometry or renderer mock.
  const verify = new Function('artwork', 'size', `
    const clips = (() => { const exports = {}; ${compile(clips)}; return exports; })();
    const load = source => source({});
    const oldPlayer = load(exports => { const require = () => clips; ${compile(oldSource)}; return exports.createSubagentMotionPlayer; });
    const newPlayer = load(exports => { const require = () => clips; ${compile(newSource)}; return exports.createSubagentMotionPlayer; });
    return (${verifyArtwork.toString()})(artwork, size, clips, oldPlayer, newPlayer);
  `);
  const directory = path.join(repo, 'src/web-ui/src/flow_chat/assets/subagent-avatars');
  const files = (await readdir(directory)).filter(file => /^robot-\d+\.svg$/.test(file)).sort();
  assert.equal(files.length, 20);
  const results = [];
  for (const file of files) for (const size of [28, 112, 136]) {
    const result = await page.execute(verify, await readFile(path.join(directory, file), 'utf8'), size);
    assert.ok(result.composited, `${file} at ${size}px must exercise the composited rig`);
    assert.ok(result.maximumDifference < 0.001, `${file} at ${size}px geometry changed: ${result.maximumDifference}`);
    assert.ok(result.lifecycle && result.restored, `${file} playback cleanup must preserve artwork`);
    results.push({ file, size, ...result });
  }
  return { reference, referenceSha256: createHash('sha256').update(oldSource).digest('hex'),
    candidateSha256: createHash('sha256').update(newSource).digest('hex'), results };
}

function verifyArtwork(artwork, size, clips, oldPlayer, newPlayer) {
  const makeHost = left => {
    const host = document.createElement('div');
    Object.assign(host.style, { position: 'fixed', left: `${left}px`, top: '10px',
      width: `${size}px`, height: `${size}px`, pointerEvents: 'none' });
    host.innerHTML = artwork;
    Object.assign(host.querySelector('svg').style, { width: '100%', height: '100%', overflow: 'visible' });
    document.body.append(host);
    return host;
  };
  const hosts = [makeHost(10), makeHost(200)];
  const markup = hosts.map(host => host.innerHTML);
  const players = [oldPlayer(hosts[0], () => {}, 'svg'), newPlayer(hosts[1], () => {}, 'svg', 'layers')];
  const composited = !!hosts[1].querySelector('[data-subagent-motion-layer] [data-motion-part="body"]');
  let maximumDifference = 0, samples = 0, lifecycle = true;
  const geometry = host => {
    const origin = host.getBoundingClientRect();
    return [...host.querySelectorAll('rect, path, circle, ellipse')].map(element => {
      const matrix = element.getScreenCTM(), box = element.getBBox();
      let opacity = 1;
      for (let ancestor = element; ancestor !== host; ancestor = ancestor.parentElement) opacity *= Number(getComputedStyle(ancestor).opacity);
      return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e - origin.left, matrix.f - origin.top,
        box.x, box.y, box.width, box.height, opacity];
    });
  };
  try {
    const actions = [...Object.entries(clips.subagentMotionClips), ['pressHold', clips.pressHoldClip],
      ['pressRelease', clips.pressReleaseClip], ['lookPointer', clips.lookMotionClip(-0.7, 0.8)]];
    for (const [, clip] of actions) {
      players.forEach(player => { player.play(clip, { repeat: false, fromCurrent: false, notify: false }); player.setPaused(true); });
      const animations = hosts.map(host => host.getAnimations({ subtree: true }));
      if (animations.some(items => items.length !== 4)) throw new Error('Four motion tracks are required');
      const offsets = [...new Set([...Array.from({ length: 17 }, (_, i) => i / 16),
        ...Object.values(clip.tracks).flatMap(frames => frames.map(frame => frame.offset))])].sort((a, b) => a - b);
      for (const offset of offsets) {
        animations.flat().forEach(animation => { animation.currentTime = clip.duration * offset; });
        const [before, after] = hosts.map(geometry);
        if (before.length !== after.length) throw new Error('Authored shapes changed');
        before.forEach((shape, i) => shape.forEach((value, j) => {
          const difference = Math.abs(value - after[i][j]);
          if (!Number.isFinite(difference)) throw new Error('Invalid geometry');
          maximumDifference = Math.max(maximumDifference, difference);
        }));
        samples++;
      }
    }
    players.forEach(player => { player.setPaused(false); player.play(clips.subagentMotionClips.working, { notify: false }); player.setSuspended(true); });
    lifecycle &&= hosts.every(host => host.getAnimations({ subtree: true }).every(animation => animation.playState === 'paused'));
    players.forEach(player => { player.setSuspended(false); player.setRate(2); });
    lifecycle &&= hosts.every(host => host.getAnimations({ subtree: true }).every(animation => animation.playState === 'running'));
    players.forEach(player => player.setReduced(true));
    lifecycle &&= hosts.every(host => host.getAnimations({ subtree: true }).length === 0);
    players.forEach(player => { player.setReduced(false); player.play(clips.subagentMotionClips.working, { notify: false }); });
    lifecycle &&= hosts.every(host => host.getAnimations({ subtree: true }).length === 4);
  } finally { players.forEach(player => player.dispose()); }
  const restored = hosts.every((host, i) => host.innerHTML === markup[i] && host.getAnimations({ subtree: true }).length === 0);
  hosts.forEach(host => host.remove());
  return { composited, maximumDifference, samples, lifecycle, restored };
}
