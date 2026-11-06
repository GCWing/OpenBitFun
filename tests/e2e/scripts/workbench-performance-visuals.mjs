/** Native screenshots, outside every speed / resource measurement window. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export async function captureHomeVisuals(page, directory) {
  const original = await page.request(`/session/${page.session}/window/rect`);
  const captures = [];
  try {
    for (const [layout, width] of [['wide', original.width], ['narrow', Math.min(2200, original.width - 300)]]) {
      await page.request(`/session/${page.session}/window/rect`, { ...original, width });
      await new Promise(resolve => setTimeout(resolve, 300));
      for (const [time, scroll] of [[0, 0], [480, 0], [1360, 0], [480, 32]]) {
        const placement = await page.execute(async (time, scroll) => {
          const host = document.querySelector('.personal-overview__avatar');
          const scroller = document.querySelector('.personal-overview__scroll');
          scroller.scrollTop = scroll;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const animations = host.getAnimations({ subtree: true });
          if (animations.length !== 4) throw new Error('The four visible avatar tracks must remain present');
          animations.forEach(animation => { animation.pause(); animation.currentTime = time; });
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100))));
          const box = host.getBoundingClientRect(), identity = host.closest('header').getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height,
            centerDifference: box.x + box.width / 2 - identity.x - identity.width / 2,
            viewportWidth: innerWidth, viewportHeight: innerHeight, scrollTop: scroller.scrollTop };
        }, time, scroll);
        assert.ok(Math.abs(placement.centerDifference) < 1, 'The avatar layout must remain centered');
        assert.ok([112, 136].includes(placement.width), 'Responsive avatar size must remain authored');
        if (scroll) assert.ok(placement.scrollTop > 0, 'The scroll check must actually move content');
        const png = Buffer.from(await page.request(`/session/${page.session}/screenshot`), 'base64');
        const metadata = await sharp(png).metadata();
        const scale = metadata.width / placement.viewportWidth;
        const name = `${layout}-${time}-${scroll}`;
        const file = path.join(directory, `avatar-${name}.png`);
        await sharp(png).extract({ left: Math.round(placement.x * scale), top: Math.round(placement.y * scale),
          width: Math.round(placement.width * scale), height: Math.round(placement.height * scale) }).png().toFile(file);
        // Keep one full frame to establish placement, not only a cropped avatar.
        if (!time && !scroll) await writeFile(path.join(directory, `home-${layout}.png`), png);
        const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        let bodyPixels = 0;
        for (let i = 0; i < data.length; i += info.channels) {
          if (Math.abs(data[i] - 50) < 5 && Math.abs(data[i + 1] - 53) < 5 && Math.abs(data[i + 2] - 64) < 5) bodyPixels++;
        }
        assert.ok(bodyPixels > 500, 'Actual rendered artwork must be inside its layout box');
        captures.push({ name, file, placement, bodyPixels });
        await page.execute(() => document.querySelector('.personal-overview__avatar').getAnimations({ subtree: true }).forEach(animation => animation.play()));
      }
    }
  } finally {
    await page.request(`/session/${page.session}/window/rect`, original);
    await page.execute(() => { document.querySelector('.personal-overview__scroll').scrollTop = 0; });
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return captures;
}

export async function compareHomeVisuals(reference, candidate) {
  assert.equal(candidate.length, reference.length);
  const differences = [];
  for (const capture of reference) {
    const next = candidate.find(item => item.name === capture.name);
    assert.ok(next);
    const images = await Promise.all([capture, next].map(item => sharp(item.file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
    assert.equal(images[0].info.width, images[1].info.width);
    assert.equal(images[0].info.height, images[1].info.height);
    let changed = 0, total = 0;
    const [before, after] = images.map(image => image.data);
    for (let i = 0; i < before.length; i += 4) {
      let maximum = 0;
      for (let channel = 0; channel < 3; channel++) {
        const delta = Math.abs(before[i + channel] - after[i + channel]);
        total += delta; maximum = Math.max(maximum, delta);
      }
      if (maximum > 24) changed++;
    }
    const pixels = before.length / 4;
    const result = { name: capture.name, changedPixelFraction: changed / pixels, meanChannelDifference: total / (pixels * 3) };
    differences.push(result);
    assert.ok(result.changedPixelFraction < 0.03 && result.meanChannelDifference < 2,
      `Avatar pixels changed beyond edge antialiasing tolerance: ${JSON.stringify(result)}`);
  }
  return differences;
}
