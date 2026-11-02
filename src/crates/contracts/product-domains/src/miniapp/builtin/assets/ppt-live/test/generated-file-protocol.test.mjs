import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PPT_DESIGN_SKILL_KEY,
  buildAgentPrompt,
} from '../src/agent-prompt.js';
import {
  DeckProjectContractError,
  createDeckProjectSkeleton,
  persistDeckProjectSeed,
  readDeckProjectContract,
  readProjectPlanWithRetry,
} from '../src/deck-project-contract.js';
import * as deckProjectContract from '../src/deck-project-contract.js';
import {
  buildElementSlideHtml as buildPureElementSlideHtml,
  elementModelElementHtml,
} from '../src/element-model-html.js';

const validPlan = {
  status: 'complete',
  title: '可靠生成协议',
  language: 'zh-CN',
  outline: [
    { id: 'intro', title: '协议先于页面', bullets: [], slide_id: 'slide-01' },
    { id: 'finish', title: '完成必须可验证', bullets: [], slide_id: 'slide-02' },
  ],
  slide_order: ['slide-01', 'slide-02'],
  style: {},
  assumptions: [],
};

const completeSlide = (title) => `<!doctype html><html><body><h1>${title}</h1></body></html>`;

test('shared pure element-model serializer module is available', async () => {
  const serializer = await import('../src/element-model-html.js').catch(() => null);

  assert.ok(serializer, 'element-model serializer module should exist');
  assert.equal(typeof serializer.buildElementSlideHtml, 'function');
  assert.equal(typeof serializer.elementModelElementHtml, 'function');
});

test('element-model serializer preserves six element types, semantics, geometry, and theme', async () => {
  const baseStyle = {
    fontSize: 24,
    fontWeight: 600,
    color: 'ink',
    background: 'panel',
    opacity: 0.9,
    borderRadius: 8,
    align: 'left',
  };
  const slide = {
    title: 'Element deck',
    theme: {
      background: '#fefefe',
      ink: '#101010',
      muted: '#606060',
      primary: '#0055aa',
      accent: '#ee5500',
      panel: '#ffffff',
    },
    elements: [
      { id: 'text-1', type: 'text', x: 1, y: 2, w: 30, h: 10, text: '正文不可丢', style: { ...baseStyle, fontSize: 30 } },
      { id: 'list-1', type: 'list', x: 3, y: 14, w: 35, h: 25, items: ['第一项', '第二项'], style: baseStyle },
      { id: 'metric-1', type: 'metric', x: 40, y: 5, w: 20, h: 18, text: '42%', label: '转化率', style: { ...baseStyle, color: 'primary' } },
      {
        id: 'chart-1',
        type: 'chart',
        x: 42,
        y: 28,
        w: 40,
        h: 35,
        text: '季度趋势',
        data: [{ label: 'Q1', value: 10 }, { label: 'Q2', value: 24 }],
        style: baseStyle,
      },
      {
        id: 'media-1',
        type: 'media',
        x: 5,
        y: 52,
        w: 28,
        h: 38,
        text: '产品截图',
        src: 'https://example.com/product.png',
        style: baseStyle,
      },
      { id: 'shape-1', type: 'shape', x: 70, y: 68, w: 20, h: 20, text: '形状标签', style: { ...baseStyle, background: 'accent' } },
    ],
  };

  const html = buildPureElementSlideHtml(slide);

  assert.match(html, /width:\s*1280px/);
  assert.match(html, /height:\s*720px/);
  assert.match(html, /background:\s*#fefefe/);
  assert.match(html, /data-element-type="text"[^>]*style="[^"]*left:1%;top:2%;width:30%;height:10%/);
  assert.match(html, /font-size:30px/);
  assert.match(html, /color:#101010/);
  assert.match(html, /<p[^>]*>正文不可丢<\/p>/);
  assert.match(html, /<li><p>第一项<\/p><\/li>/);
  assert.match(html, /<li><p>第二项<\/p><\/li>/);
  assert.match(html, /<p[^>]*>42%<\/p>/);
  assert.match(html, /<p[^>]*>转化率<\/p>/);
  assert.match(html, /季度趋势/);
  assert.match(html, /Q1/);
  assert.match(html, />10</);
  assert.match(html, /Q2/);
  assert.match(html, />24</);
  assert.match(html, /<img[^>]*src="https:\/\/example\.com\/product\.png"/);
  assert.match(html, /产品截图/);
  assert.match(html, /data-element-type="shape"/);
  assert.match(html, /background:#ee5500/);
  assert.match(html, /形状标签/);

  const seed = deckProjectContract.createDeckProjectSeed({
    hasExistingDeck: true,
    title: 'Element deck',
    slides: [{ ...slide, html: '' }],
    serializeElementSlide: buildPureElementSlideHtml,
  });
  const files = new Map([
    ['project.json', JSON.stringify(seed.plan)],
    ...seed.slideFiles.map((file) => [file.relPath, file.html]),
  ]);
  const deck = await readDeckProjectContract(async (relPath) => files.get(relPath), { maxAttempts: 1 });
  assert.equal(seed.plan.status, 'complete');
  assert.equal(deck.slides[0].html, html);
});

test('shared element helper preserves editor interaction markup', () => {
  const theme = { ink: '#111111', primary: '#0055aa', muted: '#666666', panel: '#ffffff' };
  const style = {
    fontSize: 24,
    fontWeight: 600,
    color: 'ink',
    background: 'transparent',
    opacity: 1,
    borderRadius: 0,
    align: 'left',
  };
  const text = elementModelElementHtml(
    { id: 'text-1', type: 'text', x: 1, y: 2, w: 30, h: 10, text: '可编辑正文', style },
    theme,
    { mode: 'editor', editable: true, selectedId: 'text-1' },
  );
  const list = elementModelElementHtml(
    { id: 'list-1', type: 'list', x: 1, y: 2, w: 30, h: 10, items: ['A'], style },
    theme,
    { mode: 'editor', editable: true },
  );

  assert.match(text, /class="slide-element element-text is-selected"/);
  assert.match(text, /data-edit-text="text-1"/);
  assert.match(text, /contenteditable="true"/);
  assert.match(text, /class="resize-handle"/);
  assert.match(text, /font-size:clamp\(8px,/);
  assert.match(list, /data-edit-list="list-1"/);
  assert.match(list, /data-item-index="0"/);
});

test('prompt pins the stable skill key and workspace-relative delivery contract', () => {
  const prompt = buildAgentPrompt({ instruction: '生成两页协议说明' });

  assert.equal(PPT_DESIGN_SKILL_KEY, 'user::openbitfun-system::ppt-design');
  assert.match(prompt, /user::openbitfun-system::ppt-design/);
  assert.match(prompt, /工作区根目录下的 `project\.json`/);
  assert.match(prompt, /工作区根目录下的 `slides\/slide-NN\.html`/);
  assert.match(prompt, /`project\.json` 的 `status` 设为 `"complete"`/);
  assert.match(prompt, /`slide_order`.*每一页.*完整 HTML/s);
  assert.match(prompt, /节奏（必须，影响用户等待时间）/);
  assert.match(prompt, /按需研究/);
  assert.match(prompt, /硬性禁令/);
  assert.match(prompt, /下一轮工具调用必须是 Write `project\.json`/);
  assert.match(prompt, /禁止.*Read references\/style-presets/);
});

test('backend adapter reuses the topic session without overriding the host-selected model', async () => {
  const { installOpenBitFunBackendAdapter } = await import('../src/openbitfun-backend-adapter.js');
  const ensureCalls = [];
  const calls = [];
  const app = {
    agent: {
      ensureSession: async (options) => {
        ensureCalls.push(options);
        return {
          sessionId: options.sessionId || 's1',
          workspacePath: '/appdata/decks/demo',
          created: !options.sessionId,
        };
      },
      run: async (_prompt, options) => {
        calls.push(options);
        return { sessionId: 's1', turnId: 't1', actionRunId: 't1' };
      },
      onEvent() {},
      cancel: async () => {},
      turnText: async () => ({ text: '' }),
      cancelStaleRuns: async () => ({ cancelledRuns: 0 }),
    },
  };
  installOpenBitFunBackendAdapter(app);
  const ensured = await app.backend.ensureSession({
    sessionId: 's1',
    appDataWorkspace: 'decks/demo',
    model: 'fast',
  });
  await app.backend.call('ppt.generate', { instruction: 'internal prompt' }, {
    sessionId: 's1',
    appDataWorkspace: 'decks/demo',
    model: 'fast',
    displayText: '随便做几页测试页',
  });
  assert.equal(ensured.sessionId, 's1');
  assert.deepEqual(ensureCalls, [{
    sessionName: 'PPT Live',
    sessionId: 's1',
    appDataWorkspace: 'decks/demo',
  }]);
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0], 'model'), false);
  assert.equal(calls[0].sessionId, 's1');
  assert.equal(calls[0].appDataWorkspace, 'decks/demo');
  assert.equal(calls[0].displayText, '随便做几页测试页');
});

test('legacy model state is discarded and PPT Live no longer renders its own selector', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { app: { locale: 'en-US' } };
  globalThis.document = { documentElement: { lang: 'en-US' } };

  let restored;
  try {
    const { ensureState } = await import('../src/state.js');
    restored = ensureState({ preferredModel: 'fast' });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }

  assert.equal(Object.hasOwn(restored, 'preferredModel'), false);
  assert.doesNotMatch(html, /modelSelect|propertiesModel/);
});

test('PPT topic lifecycle eagerly creates or rebinds its dedicated session', async () => {
  const uiSource = await readFile(new URL('../ui.js', import.meta.url), 'utf8');

  assert.match(uiSource, /async function ensureDeckAgentSession\(\)/);
  assert.match(uiSource, /payload\?\.displayText/);
  assert.match(uiSource, /displayText: options\.displayText \|\| requestInput\.instruction/);
  assert.match(uiSource, /continueAfterInterruption: attempt > 1/);
  assert.match(
    uiSource,
    /displayText: attempt === 1[\s\S]*generationRetryDisplayText/,
  );
  assert.match(uiSource, /return submitInstruction\(text, displayText, payload\?\.imageContexts\);/);
  assert.doesNotMatch(
    uiSource,
    /buildDeckRunRequestInput\([\s\S]{0,180}sessionId: retrySession\?\.id/,
  );
  assert.match(
    uiSource,
    /async function restoreHistory[\s\S]*await clearFocusedDeckAgentSession\(\);[\s\S]*await ensureDeckAgentSession\(\);/,
  );
  assert.match(
    uiSource,
    /async function newDeck[\s\S]*await clearFocusedDeckAgentSession\(\);[\s\S]*await ensureDeckAgentSession\(\);/,
  );
  assert.match(
    uiSource,
    /await recoverFromRestart\(\);[\s\S]*await ensureDeckAgentSession\(\);/,
  );
  assert.match(
    uiSource,
    /persistedSessionId[\s\S]*requestSession\(persistedSessionId\)/,
  );
  assert.doesNotMatch(
    uiSource,
    /state\.agentSession\s*=\s*\{[\s\S]{0,120}id:\s*['"]['"]/,
  );
});

test('PPT Live declares a localized host-rendered Agentic bubble entry', async () => {
  const uiSource = await readFile(new URL('../ui.js', import.meta.url), 'utf8');
  const i18nSource = await readFile(new URL('../src/i18n.js', import.meta.url), 'utf8');

  assert.match(uiSource, /claimComposer\?\.\(\{\s*composer:\s*\{\s*placeholder:\s*t\('bubblePlaceholder'\)/);
  assert.doesNotMatch(uiSource, /panelSize:\s*'wide'/);
  assert.doesNotMatch(uiSource, /composer:\s*\{[\s\S]*?rows:\s*3/);
  assert.match(uiSource, /welcome:\s*\{[\s\S]*workspaceLabel:\s*t\('bubbleWorkspaceLabel'\)/);
  assert.match(uiSource, /suggestions:\s*\[[\s\S]*welcomeTip1[\s\S]*welcomeTip2[\s\S]*welcomeTip3/);
  assert.match(i18nSource, /bubbleWelcomeTitle:/);
  assert.match(i18nSource, /bubbleWelcomeBody:/);
  assert.match(i18nSource, /bubbleWorkspaceLabel:/);
  assert.match(i18nSource, /bubbleSuggestionsLabel:/);
});

test('PPT Live guides users to the host launcher without placing copy beneath it', async () => {
  const htmlSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const styleSource = await readFile(new URL('../style.css', import.meta.url), 'utf8');
  const i18nSource = await readFile(new URL('../src/i18n.js', import.meta.url), 'utf8');

  assert.match(htmlSource, /class="bubble-hint__heading"/);
  assert.match(htmlSource, /data-i18n="bubbleHintEyebrow"/);
  assert.match(htmlSource, /class="bubble-hint__body"/);
  assert.match(styleSource, /\.agent-card--bubble-hint\s*\{[\s\S]*padding:\s*18px 16px 76px/);
  assert.match(styleSource, /\.bubble-hint__pointer\s*\{[\s\S]*max-width:\s*calc\(100% - 100px\)/);
  assert.match(styleSource, /\.statusbar\s*\{[\s\S]*padding:\s*0 84px 0 var\(--space-4\)/);
  assert.match(i18nSource, /bubbleHintTitle:\s*'Start with the PPT Live button'/);
  assert.match(i18nSource, /bubbleHintTitle:\s*'从 PPT Live 按钮开始'/);
});

test('prompt carries a targeted contract diagnostic into same-session continuation', () => {
  const prompt = buildAgentPrompt({
    instruction: '继续生成',
    continueAfterInterruption: true,
    projectContractDiagnostic: {
      code: 'missing_slide_files',
      continuationPrompt: '只补写 slides/slide-02.html，然后重新完成有界检查。',
    },
  });

  assert.match(prompt, /同一会话/);
  assert.match(prompt, /missing_slide_files/);
  assert.match(prompt, /只补写 slides\/slide-02\.html/);
});

test('project.json read retries transient visibility like slide reads', async () => {
  let attempts = 0;
  const sleeps = [];
  const plan = await readProjectPlanWithRetry(async (relPath) => {
    assert.equal(relPath, 'project.json');
    attempts += 1;
    if (attempts === 1) throw new Error('not visible yet');
    if (attempts === 2) return '{"status":"complete"';
    return JSON.stringify(validPlan);
  }, {
    maxAttempts: 3,
    delayMs: 7,
    sleep: async (delay) => sleeps.push(delay),
  });

  assert.deepEqual(plan, validPlan);
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [7, 7]);
});

test('project contract waits for a planning skeleton to become complete in the same run', async () => {
  const skeleton = createDeckProjectSkeleton({ title: '逐步写入' });
  let projectReads = 0;
  const sleeps = [];

  const deck = await readDeckProjectContract(async (relPath) => {
    if (relPath === 'project.json') {
      projectReads += 1;
      return JSON.stringify(projectReads === 1 ? skeleton : {
        ...validPlan,
        outline: [validPlan.outline[0]],
        slide_order: ['slide-01'],
      });
    }
    return completeSlide('恢复后的第一页');
  }, {
    maxAttempts: 2,
    delayMs: 5,
    sleep: async (delay) => sleeps.push(delay),
  });

  assert.equal(projectReads, 2);
  assert.deepEqual(sleeps, [5]);
  assert.equal(deck.plan.status, 'complete');
  assert.equal(deck.slides[0].outlineEntry.title, '协议先于页面');
  assert.match(deck.slides[0].html, /恢复后的第一页/);
});

test('project contract rejects slide_order and outline disagreement', async () => {
  const plan = {
    ...validPlan,
    slide_order: ['slide-01', 'slide-03'],
  };

  await assert.rejects(
    readDeckProjectContract(async (relPath) => (
      relPath === 'project.json' ? JSON.stringify(plan) : completeSlide(relPath)
    ), { maxAttempts: 1 }),
    (error) => {
      assert.ok(error instanceof DeckProjectContractError);
      assert.equal(error.diagnostic.code, 'invalid_project_contract');
      assert.match(error.diagnostic.continuationPrompt, /slide_order/);
      assert.match(error.diagnostic.continuationPrompt, /outline/);
      return true;
    },
  );
});

test('project contract follows slide_order when it intentionally differs from outline order', async () => {
  const reversed = {
    ...validPlan,
    slide_order: ['slide-02', 'slide-01'],
  };

  const deck = await readDeckProjectContract(async (relPath) => (
    relPath === 'project.json'
      ? JSON.stringify(reversed)
      : completeSlide(relPath.endsWith('slide-01.html') ? 'First file' : 'Second file')
  ), { maxAttempts: 1 });

  assert.deepEqual(deck.slides.map((slide) => slide.slideId), ['slide-02', 'slide-01']);
  assert.deepEqual(deck.slides.map((slide) => slide.slideNumber), [1, 2]);
  assert.deepEqual(deck.slides.map((slide) => slide.outlineEntry.id), ['finish', 'intro']);
  assert.match(deck.slides[0].html, /Second file/);
});

test('project contract requires id, title, and bullets on every outline item', async (t) => {
  const invalidItems = [
    ['id', { title: '标题', bullets: [], slide_id: 'slide-01' }],
    ['title', { id: 'intro', bullets: [], slide_id: 'slide-01' }],
    ['bullets', { id: 'intro', title: '标题', slide_id: 'slide-01' }],
  ];

  for (const [field, outlineItem] of invalidItems) {
    await t.test(`rejects missing ${field}`, async () => {
      const plan = {
        ...validPlan,
        outline: [outlineItem],
        slide_order: ['slide-01'],
      };
      await assert.rejects(
        readDeckProjectContract(async (relPath) => (
          relPath === 'project.json' ? JSON.stringify(plan) : completeSlide('第一页')
        ), { maxAttempts: 1 }),
        (error) => {
          assert.equal(error.diagnostic.code, 'invalid_project_contract');
          assert.equal(error.diagnostic.invalidOutlineField, field);
          assert.match(error.diagnostic.continuationPrompt, new RegExp(field));
          return true;
        },
      );
    });
  }
});

test('project contract requires string bullets and unique outline ids', async (t) => {
  await t.test('rejects non-string bullet entries', async () => {
    const plan = {
      ...validPlan,
      outline: [{ ...validPlan.outline[0], bullets: ['valid', 42] }],
      slide_order: ['slide-01'],
    };
    await assert.rejects(
      readDeckProjectContract(async (relPath) => (
        relPath === 'project.json' ? JSON.stringify(plan) : completeSlide('第一页')
      ), { maxAttempts: 1 }),
      (error) => error.diagnostic.invalidOutlineField === 'bullets',
    );
  });

  await t.test('rejects duplicate outline ids', async () => {
    const plan = {
      ...validPlan,
      outline: [
        validPlan.outline[0],
        { ...validPlan.outline[1], id: validPlan.outline[0].id },
      ],
    };
    await assert.rejects(
      readDeckProjectContract(async (relPath) => (
        relPath === 'project.json' ? JSON.stringify(plan) : completeSlide(relPath)
      ), { maxAttempts: 1 }),
      (error) => error.diagnostic.invalidOutlineField === 'id',
    );
  });
});

test('project contract reports every missing page for targeted continuation', async () => {
  await assert.rejects(
    readDeckProjectContract(async (relPath) => {
      if (relPath === 'project.json') return JSON.stringify(validPlan);
      if (relPath === 'slides/slide-01.html') return completeSlide('第一页');
      throw new Error('not found');
    }, { maxAttempts: 2, delayMs: 0 }),
    (error) => {
      assert.equal(error.diagnostic.code, 'missing_slide_files');
      assert.deepEqual(error.diagnostic.missingPaths, ['slides/slide-02.html']);
      assert.match(error.diagnostic.continuationPrompt, /只补写.*slides\/slide-02\.html/s);
      assert.match(error.message, /missing_slide_files/);
      return true;
    },
  );
});

test('slide completeness requires html and body opening and closing structure', async (t) => {
  const malformedSlides = [
    ['garbage with closing html only', 'garbage</html>'],
    ['html without body', '<html><main>content</main></html>'],
    ['body without closing body', '<html><body>content</html>'],
    ['truncated closing html tag', '<html><body>content</body></ht'],
    ['empty body', '<html><body> \n <!-- still empty --> </body></html>'],
  ];

  for (const [name, malformedHtml] of malformedSlides) {
    await t.test(name, async () => {
      const oneSlidePlan = {
        ...validPlan,
        outline: [validPlan.outline[0]],
        slide_order: ['slide-01'],
      };
      await assert.rejects(
        readDeckProjectContract(async (relPath) => (
          relPath === 'project.json' ? JSON.stringify(oneSlidePlan) : malformedHtml
        ), { maxAttempts: 1 }),
        (error) => {
          assert.equal(error.diagnostic.code, 'missing_slide_files');
          assert.deepEqual(error.diagnostic.missingPaths, ['slides/slide-01.html']);
          return true;
        },
      );
    });
  }
});

test('unrecoverable project JSON returns a repairable same-session diagnostic', async () => {
  await assert.rejects(
    readProjectPlanWithRetry(async () => 'not json, see the slides folder', { maxAttempts: 2, delayMs: 0 }),
    (error) => {
      assert.equal(error.diagnostic.code, 'invalid_project_json');
      assert.match(error.diagnostic.continuationPrompt, /修复 `project\.json` JSON/);
      return true;
    },
  );
});

test('truncated project JSON is repaired instead of aborting generation', async () => {
  const truncated = JSON.stringify(validPlan).slice(0, 40);
  const plan = await readProjectPlanWithRetry(async () => truncated, { maxAttempts: 2, delayMs: 0 });
  assert.equal(plan.status, 'complete');
  assert.equal(plan.title, validPlan.title);

  const midOutline = `{"status":"complete","title":"截断","outline":[{"id":"intro","title":"协议先于页面","bullets":[],"slide_id":"slide-01"},{"id":"fin`;
  const repaired = await readProjectPlanWithRetry(async () => midOutline, { maxAttempts: 1 });
  assert.equal(repaired.status, 'complete');
  assert.equal(repaired.outline[0].slide_id, 'slide-01');
});

test('fenced commented and trailing-comma project JSON parses tolerantly', async () => {
  const sloppy = `\`\`\`json
{
  // agent note
  "status": "complete",
  "title": "宽松解析",
  "outline": [],
}
\`\`\``;
  const plan = await readProjectPlanWithRetry(async () => sloppy, { maxAttempts: 1 });
  assert.equal(plan.status, 'complete');
  assert.equal(plan.title, '宽松解析');
});

test('tolerant parse still rejects non-object roots and empty documents', async () => {
  for (const raw of ['[1,2,3]', '"text"', '42', '']) {
    await assert.rejects(
      readProjectPlanWithRetry(async () => raw, { maxAttempts: 1 }),
      (error) => ['invalid_project_json', 'missing_project_json'].includes(error.diagnostic.code),
      raw,
    );
  }
});

test('missing project.json has a distinct targeted diagnostic', async () => {
  await assert.rejects(
    readProjectPlanWithRetry(async () => {
      const error = new Error('not found');
      error.code = 'ENOENT';
      throw error;
    }, { maxAttempts: 2, delayMs: 0 }),
    (error) => {
      assert.equal(error.diagnostic.code, 'missing_project_json');
      assert.match(error.diagnostic.continuationPrompt, /创建 `project\.json`/);
      return true;
    },
  );
});

test('empty project.json retries and remains a targeted missing-project continuation', async () => {
  let attempts = 0;
  await assert.rejects(
    readProjectPlanWithRetry(async () => {
      attempts += 1;
      return attempts === 1 ? '' : ' \n';
    }, { maxAttempts: 2, delayMs: 0 }),
    (error) => {
      assert.equal(error.diagnostic.code, 'missing_project_json');
      assert.match(error.diagnostic.summary, /missing or empty/);
      assert.match(error.diagnostic.continuationPrompt, /创建 `project\.json`/);
      return true;
    },
  );
  assert.equal(attempts, 2);
});

test('new-deck skeleton is valid JSON but cannot satisfy completion contract', async () => {
  const skeleton = createDeckProjectSkeleton({
    title: '待规划 deck',
    language: 'zh-CN',
    style: { theme: 'light' },
  });
  const serialized = `${JSON.stringify(skeleton, null, 2)}\n`;

  assert.deepEqual(JSON.parse(serialized), skeleton);
  assert.equal(skeleton.status, 'planning');
  assert.deepEqual(skeleton.outline, []);
  assert.deepEqual(skeleton.slide_order, []);
  await assert.rejects(
    readDeckProjectContract(async (relPath) => {
      if (relPath === 'project.json') return serialized;
      throw new Error(`unexpected read: ${relPath}`);
    }, { maxAttempts: 1 }),
    (error) => error.diagnostic.code === 'project_incomplete',
  );
});

test('existing-deck seed serializes element-only slides and passes the strict contract', async () => {
  assert.equal(typeof deckProjectContract.createDeckProjectSeed, 'function');
  const seed = deckProjectContract.createDeckProjectSeed({
    hasExistingDeck: true,
    title: '旧 deck',
    language: 'zh-CN',
    style: { theme: 'light' },
    slides: [
      { title: '旧第一页', html: completeSlide('旧第一页') },
      {
        title: '旧第二页',
        html: '',
        elements: [{ type: 'text', text: '来自 element model' }],
      },
    ],
    serializeElementSlide: buildPureElementSlideHtml,
  });

  assert.equal(seed.plan.status, 'complete');
  assert.deepEqual(seed.plan.slide_order, ['slide-01', 'slide-02']);
  assert.deepEqual(seed.plan.outline[1], {
    id: 'slide-02',
    title: '旧第二页',
    bullets: [],
    slide_id: 'slide-02',
  });
  assert.equal(seed.slideFiles.length, 2);
  assert.match(seed.slideFiles[1].html, /<html[\s>]/i);
  assert.match(seed.slideFiles[1].html, /<body[\s>]/i);

  const files = new Map([
    ['project.json', JSON.stringify(seed.plan)],
    ...seed.slideFiles.map((file) => [file.relPath, file.html]),
  ]);
  const deck = await readDeckProjectContract(async (relPath) => {
    if (!files.has(relPath)) throw new Error('not found');
    return files.get(relPath);
  }, { maxAttempts: 1 });
  assert.equal(deck.slides.length, 2);
});

test('legacy element-model seed round-trips every serialized element without losing content', async () => {
  const legacySlide = {
    title: '旧元素模型',
    theme: {
      background: '#fefefe',
      ink: '#101010',
      muted: '#606060',
      primary: '#0055aa',
      accent: '#ee5500',
      panel: '#ffffff',
    },
    elements: [
      { id: 'text-old', type: 'text', x: 2, y: 4, w: 30, h: 10, text: '旧正文', style: {} },
      { id: 'list-old', type: 'list', x: 2, y: 16, w: 30, h: 20, items: ['旧列表一', '旧列表二'], style: {} },
      { id: 'metric-old', type: 'metric', x: 36, y: 4, w: 20, h: 16, text: '98%', label: '旧指标', style: {} },
      {
        id: 'chart-old', type: 'chart', x: 36, y: 24, w: 40, h: 30, text: '旧图表',
        data: [{ label: '旧类别', value: 7 }], style: {},
      },
      {
        id: 'media-old', type: 'media', x: 2, y: 50, w: 24, h: 30,
        text: '旧媒体', src: 'data:image/png;base64,AA==', style: {},
      },
      { id: 'shape-old', type: 'shape', x: 78, y: 58, w: 18, h: 20, text: '旧形状', style: {} },
    ],
  };
  const seed = deckProjectContract.createDeckProjectSeed({
    hasExistingDeck: true,
    title: '旧 deck',
    slides: [legacySlide],
    serializeElementSlide: buildPureElementSlideHtml,
  });
  const files = new Map([
    ['project.json', JSON.stringify(seed.plan)],
    ...seed.slideFiles.map((file) => [file.relPath, file.html]),
  ]);

  const deck = await readDeckProjectContract(async (relPath) => files.get(relPath), { maxAttempts: 1 });
  const html = deck.slides[0].html;

  for (const id of legacySlide.elements.map((element) => element.id)) {
    assert.match(html, new RegExp(`data-element-id="${id}"`), id);
  }
  for (const text of ['旧正文', '旧列表一', '旧列表二', '98%', '旧指标', '旧图表', '旧类别', '7', '旧媒体', '旧形状']) {
    assert.match(html, new RegExp(text), text);
  }
  assert.match(html, /src="data:image\/png;base64,AA=="/);
  assert.equal(seed.plan.status, 'complete');
  assert.equal(deck.slides[0].slideId, 'slide-01');
});

test('existing-deck seed stays planning with an exact diagnostic when a slide cannot serialize', () => {
  const seed = deckProjectContract.createDeckProjectSeed({
    hasExistingDeck: true,
    title: '旧 deck',
    language: 'zh-CN',
    slides: [
      { title: '旧第一页', html: completeSlide('旧第一页') },
      { title: '损坏页面' },
    ],
    serializeElementSlide: () => {
      throw new Error('unsupported slide model');
    },
  });

  assert.equal(seed.plan.status, 'planning');
  assert.equal(seed.diagnostic.code, 'missing_slide_files');
  assert.deepEqual(seed.diagnostic.missingPaths, ['slides/slide-02.html']);
  assert.match(seed.diagnostic.continuationPrompt, /slides\/slide-02\.html/);
});

test('persistDeckProjectSeed creates slides directory before ordered writes', async () => {
  const calls = [];
  let directoryReady = false;
  const fs = {
    async mkdir(path, options) {
      calls.push(['mkdir', path, options]);
      directoryReady = true;
    },
    async writeFile(path, content) {
      assert.equal(directoryReady, true);
      calls.push(['write', path, content]);
    },
  };
  const seed = {
    plan: { status: 'complete' },
    slideFiles: [
      { relPath: 'slides/slide-01.html', html: completeSlide('one') },
      { relPath: 'slides/slide-02.html', html: completeSlide('two') },
    ],
  };

  await persistDeckProjectSeed(fs, '/deck', seed);

  assert.deepEqual(calls.map(([operation, path]) => [operation, path]), [
    ['mkdir', '/deck/slides'],
    ['write', '/deck/project.json'],
    ['write', '/deck/slides/slide-01.html'],
    ['write', '/deck/slides/slide-02.html'],
  ]);
  assert.deepEqual(calls[0][2], { recursive: true });
});

test('persistDeckProjectSeed skips empty new-deck project.json to avoid Read-before-Write', async () => {
  const calls = [];
  const fs = {
    async mkdir(path, options) {
      calls.push(['mkdir', path, options]);
    },
    async writeFile(path) {
      calls.push(['write', path]);
    },
  };
  const seed = deckProjectContract.createDeckProjectSeed({
    hasExistingDeck: false,
    title: '',
    style: { stylePreset: 'clean-business' },
  });
  assert.equal(seed.plan.status, 'planning');
  assert.deepEqual(seed.plan.outline, []);
  assert.deepEqual(seed.slideFiles, []);

  await persistDeckProjectSeed(fs, '/deck', seed);

  assert.deepEqual(calls.map(([operation, path]) => [operation, path]), [
    ['mkdir', '/deck/slides'],
  ]);
});

test('finalizeDeckProjectIfReady marks planning decks complete when slides exist', async () => {
  const { finalizeDeckProjectIfReady } = deckProjectContract;
  const plan = {
    status: 'planning',
    title: 'Ready deck',
    outline: [
      { id: 's1', title: 'One', bullets: [], slide_id: 'slide-01' },
      { id: 's2', title: 'Two', bullets: [], slide_id: 'slide-02' },
    ],
    slide_order: ['slide-01', 'slide-02'],
  };
  let written = null;
  const files = new Map([
    ['project.json', JSON.stringify(plan)],
    ['slides/slide-01.html', completeSlide('one')],
    ['slides/slide-02.html', completeSlide('two')],
  ]);
  const ok = await finalizeDeckProjectIfReady(
    async (relPath) => files.get(relPath),
    async (relPath, content) => {
      written = { relPath, content };
      files.set(relPath, content);
    },
    { maxAttempts: 1 },
  );
  assert.equal(ok, true);
  assert.equal(written?.relPath, 'project.json');
  assert.equal(JSON.parse(written.content).status, 'complete');

  const deck = await readDeckProjectContract(
    async (relPath) => files.get(relPath),
    {
      maxAttempts: 1,
      writeFile: async (relPath, content) => files.set(relPath, content),
    },
  );
  assert.equal(deck.plan.status, 'complete');
  assert.equal(deck.slides.length, 2);
});

test('persistDeckProjectSeed reports mkdir and slide write failures for same-session continuation', async (t) => {
  await t.test('mkdir failure', async () => {
    await assert.rejects(
      persistDeckProjectSeed({
        async mkdir() { throw new Error('/private/deck denied'); },
        async writeFile() { assert.fail('write must not run'); },
      }, '/deck', { plan: {}, slideFiles: [] }),
      (error) => {
        assert.ok(error instanceof DeckProjectContractError);
        assert.equal(error.diagnostic.code, 'seed_fs_mkdir_failed');
        assert.equal(error.diagnostic.phase, 'mkdir');
        assert.deepEqual(error.diagnostic.missingPaths, ['slides']);
        assert.match(error.diagnostic.continuationPrompt, /slides/);
        return true;
      },
    );
  });
  await t.test('slide write failure', async () => {
    await assert.rejects(
      persistDeckProjectSeed({
        async mkdir() {},
        async writeFile(path) {
          if (path.endsWith('slide-02.html')) throw new Error('<secret> /Users/alice/deck');
        },
      }, '/deck', {
        plan: {},
        slideFiles: [
          { relPath: 'slides/slide-01.html', html: completeSlide('one') },
          { relPath: 'slides/slide-02.html', html: completeSlide('two') },
        ],
      }),
      (error) => {
        assert.equal(error.diagnostic.code, 'seed_fs_write_failed');
        assert.equal(error.diagnostic.phase, 'slide-write');
        assert.deepEqual(error.diagnostic.missingPaths, ['slides/slide-02.html']);
        return true;
      },
    );
  });
});

test('request always carries seed diagnostics while only a recovery attempt is a continuation', () => {
  assert.equal(typeof deckProjectContract.buildDeckRunRequestInput, 'function');
  const diagnostic = {
    code: 'missing_slide_files',
    continuationPrompt: '只补写 slides/slide-02.html。',
  };
  const request = deckProjectContract.buildDeckRunRequestInput(
    { operation: 'generate', instruction: '继续' },
    { continueAfterInterruption: true, projectContractDiagnostic: diagnostic },
  );

  assert.equal(request.continueAfterInterruption, true);
  assert.equal(request.projectContractDiagnostic, diagnostic);
  assert.equal(request.operation, 'generate');
  assert.deepEqual(
    deckProjectContract.buildDeckRunRequestInput(
      { operation: 'generate' },
      { continueAfterInterruption: false, projectContractDiagnostic: diagnostic },
    ),
    { operation: 'generate', projectContractDiagnostic: diagnostic },
  );
});

test('first-turn prompt receives seed filesystem continuation diagnostics', () => {
  const diagnostic = {
    code: 'seed_fs_mkdir_failed',
    continuationPrompt: '创建 slides 目录后继续。',
    missingPaths: ['slides'],
  };
  const request = deckProjectContract.buildDeckRunRequestInput(
    { operation: 'generate', instruction: '生成演示稿' },
    { continueAfterInterruption: false, projectContractDiagnostic: diagnostic },
  );
  const prompt = buildAgentPrompt(request);

  assert.equal(request.continueAfterInterruption, undefined);
  assert.equal(request.projectContractDiagnostic, diagnostic);
  assert.match(prompt, /seed_fs_mkdir_failed/);
  assert.match(prompt, /创建 slides 目录后继续/);
});

test('skill defines the workspace root unambiguously and bounded plan-first completion', async () => {
  const skillUrl = new URL('../../../../../../../../assembly/core/builtin_skills/ppt-design/SKILL.md', import.meta.url);
  const skill = await readFile(skillUrl, 'utf8');

  assert.doesNotMatch(skill, /\{\{ppt_project_dir\}\}/);
  assert.match(skill, /当前工作区根目录就是当前 deck 根目录/);
  assert.match(skill, /下一轮工具必须是 Write `project\.json`/);
  assert.match(skill, /马上 Write `project\.json`/);
  assert.match(skill, /直接按 outline 写页/);
  assert.match(skill, /同轮收尾/);
  assert.match(skill, /禁止单独开一轮只做 Glob\/LS\/Edit/);
  assert.match(skill, /禁止.*Read references\/style-presets/);
});

function contractSection(source, startLabel, endLabel) {
  const start = source.indexOf(startLabel);
  const end = source.indexOf(endLabel, start + startLabel.length);
  assert.notEqual(start, -1, `missing section: ${startLabel}`);
  assert.notEqual(end, -1, `missing section boundary: ${endLabel}`);
  return source.slice(start, end);
}

function assertNoPositiveVisualFallbackAdvice(source, label) {
  const suspectLines = source.split('\n').filter((line) => (
    /\b(?:rasterize|screenshot|fallback)\b/i.test(line)
  ));
  assert.ok(suspectLines.length > 0, `${label} should explicitly forbid fallback techniques`);
  for (const line of suspectLines) {
    assert.match(
      line,
      /禁止|不得|不是|不应|不能|无|拒绝|不存在|not|never/i,
      `${label} contains positive visual fallback advice: ${line}`,
    );
  }
}

test('authoring contracts separate generation rules from converter legacy rewrites', async () => {
  const skillRoot = new URL('../../../../../../../../assembly/core/builtin_skills/ppt-design/', import.meta.url);
  const [skill, editable, visualization, slideDecks] = await Promise.all([
    readFile(new URL('SKILL.md', skillRoot), 'utf8'),
    readFile(new URL('references/editable-pptx.md', skillRoot), 'utf8'),
    readFile(new URL('references/data-information-visualization.md', skillRoot), 'utf8'),
    readFile(new URL('references/slide-decks.md', skillRoot), 'utf8'),
  ]);
  const prompt = buildAgentPrompt({ instruction: '生成一份含图表、流程图和表格的演示稿' });

  for (const [label, contract] of [
    ['skill', skill],
    ['editable reference', editable],
    ['visualization reference', visualization],
    ['agent prompt', prompt],
  ]) {
    const authoring = contractSection(
      contract,
      'Authoring subset（生成规则）',
      'Converter legacy rewrite boundary（兼容边界，不是生成建议）',
    );
    const compatibility = contractSection(
      contract,
      'Converter legacy rewrite boundary（兼容边界，不是生成建议）',
      'End editable contract',
    );

    assert.match(contract, /唯一.*editable HTML\s*→\s*EditableSlideScene\s*→\s*OOXML/i, label);
    assert.match(authoring, /1280px\s*[×x]\s*720px/i, label);
    assert.match(authoring, /只使用 solid color/i, label);
    assert.match(authoring, /不得生成.*CSS gradient.*background-image/is, label);
    assert.match(authoring, /HTML 文字.*`?<p>`?.*`?<h1>`?.*`?<h6>`?.*`?<li>`?/s, label);
    assert.match(
      authoring,
      /box-shadow.*单层.*outer.*非 inset.*zero spread.*不支持.*自动移除/is,
      label,
    );
    assert.match(authoring, /text-shadow.*自动移除/is, label);
    assert.match(authoring, /优先.*`?line`?.*`?polyline`?/is, label);
    assert.match(authoring, /base64.*PNG.*JPEG.*WebP.*GIF/s, label);
    assert.match(
      authoring,
      /禁止任意顶点\/非严格对称.*polygon.*仅.*严格对称.*triangle.*diamond/is,
      label,
    );
    assert.match(
      authoring,
      /流程箭头.*editable line\s*\+\s*CSS border triangle.*SVG line\s*\+\s*strict symmetric triangle polygon/is,
      label,
    );

    assert.match(compatibility, /兼容既有输入.*不是生成许可/s, label);
    assert.match(compatibility, /SVG `?text`?.*支持的 SVG 原语/s, label);
    assert.match(compatibility, /`?div`?\s*裸文字.*repair.*不应生成/is, label);
    assert.match(compatibility, /M\/L\/H\/V\/C\/S\/Q\/T\/Z/, label);
    assert.match(compatibility, /`?fill:\s*none`?/i, label);
    assert.match(compatibility, /`?Z`?.*闭合/s, label);
    assert.match(compatibility, /拒绝.*`?A`?.*transform/is, label);
    assert.match(compatibility, /曲线.*采样.*多段 editable line.*不是 PowerPoint curve/is, label);
    assert.match(compatibility, /严格对称.*triangle.*diamond/is, label);
    assert.match(compatibility, /任意顶点.*非严格对称 polygon.*拒绝/is, label);
    assert.match(compatibility, /linear-gradient.*deg.*turn.*rad.*grad/is, label);
    assert.match(compatibility, /percentage stop.*缺省 stop.*均匀分配/is, label);
    assert.match(compatibility, /拒绝.*radial-gradient.*px\/em stop.*double-position stop.*color hint/is, label);
    assert.match(compatibility, /solid strips.*不是生成建议/is, label);
    assert.match(
      compatibility,
      /hard ring.*box-shadow.*0 0 0 Npx.*同心可编辑 shape.*不得依赖 ring rewrite/is,
      label,
    );

    assert.doesNotMatch(contract, /禁止任意 SVG polygon/i, label);
    assert.doesNotMatch(
      contract,
      /CSS\/element-model preset|preset (?:arrow|arrowhead)|rightArrow|chevron/i,
      label,
    );
    assertNoPositiveVisualFallbackAdvice(contract, label);
  }

  assert.match(skill, /slide-decks\.md.*1280\s*[×x]\s*720.*editable-only/is);
  assert.match(slideDecks, /1280px\s*[×x]\s*720px/i);
  assert.match(slideDecks, /editable HTML\s*→\s*EditableSlideScene\s*→\s*OOXML/i);
  assert.match(slideDecks, /无法表示.*停止.*报告/s);
  assert.doesNotMatch(slideDecks, /960\s*[×x]\s*540\s*pt/i);
  assert.doesNotMatch(slideDecks, /fallback 流程/i);
});

test('agent prompt keeps native table and editable visualization requirements in authoring section', () => {
  const prompt = buildAgentPrompt({ instruction: '生成一份含图表、流程图和表格的演示稿' });
  const authoring = contractSection(
    prompt,
    'Authoring subset（生成规则）',
    'Converter legacy rewrite boundary（兼容边界，不是生成建议）',
  );

  assert.match(authoring, /真实的 `<table>`.*native `a:tbl`/s);
  assert.match(authoring, /图表.*流程箭头.*虚线.*曲线.*可编辑原语/s);
  assert.match(authoring, /禁止 CSS `filter`、`mask`/);
  assert.match(authoring, /generated content/i);
  assert.match(authoring, /不得生成 CSS gradient 或 `background-image`/i);
  assert.match(authoring, /intentional 图片.*PNG.*JPEG.*WebP.*GIF/s);
});

test('repository exposes and runs the focused PPT Live contract test in CI', async () => {
  const repoRoot = new URL('../../../../../../../../../../', import.meta.url);
  const packageJson = JSON.parse(await readFile(new URL('package.json', repoRoot), 'utf8'));
  const ci = await readFile(new URL('.github/workflows/ci.yml', repoRoot), 'utf8');

  assert.equal(
    packageJson.scripts['test:ppt-live'],
    'node --test src/crates/contracts/product-domains/src/miniapp/builtin/assets/ppt-live/test/*.test.mjs',
  );
  assert.match(ci, /name: Validate PPT Live generated-file contract[\s\S]*run: pnpm run test:ppt-live/);
  assert.ok(
    ci.indexOf('- name: Install dependencies') < ci.indexOf('- name: Validate PPT Live generated-file contract'),
    'PPT Live tests must run after pnpm install on a clean runner',
  );
});

test('UI seeds deck projects through the production persistence helper', async () => {
  const ui = await readFile(new URL('../ui.js', import.meta.url), 'utf8');
  assert.match(ui, /import\s*\{[\s\S]*persistDeckProjectSeed[\s\S]*\}\s*from\s*['"]\.\/src\/deck-project-contract\.js['"]/);
  assert.match(ui, /await persistDeckProjectSeed\(fs,\s*project\.dir,\s*seed\)/);
});
