const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Where one overlay sheet lands. The answer is three decisions in a fixed order —
// hardware posture first (a half-folded operate half, a folded leaf), then a
// usable vertical crease, then the window's own width — and the last one changed:
// a wide window used to get a side sheet docked to the trailing edge, or, for
// Settings, a full-width bottom band at every width. Both are regressions this
// file pins: on a tablet every one of these sheets is a dialog in the middle of
// the screen, while the postures that are about the hardware keep the answer they
// had. `AdaptiveSheetOptions` turns the placement into SheetOptions; which mode
// becomes which sheet type is asserted in immersive-bottom.test.cjs.
const ROOT = path.join(__dirname, '../../entry/src/main/ets');
const cache = new Map();

/** Loads one .ets module and resolves its relative imports from the source tree. */
function load(relative) {
  if (cache.has(relative)) return cache.get(relative);
  const source = fs.readFileSync(path.join(ROOT, relative + '.ets'), 'utf8')
    .replace(/@ObservedV2\s*/g, '').replace(/@Trace\s*/g, '');
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  } }).outputText;
  const exported = {};
  cache.set(relative, exported);
  new Function('require', 'exports', js)(name => {
    // System modules (@ohos.*, @kit.*) are only reached by code paths these tests do not run.
    if (!name.startsWith('.')) return {};
    const target = path.relative(ROOT, path.resolve(path.join(ROOT, relative), '..', name)).split(path.sep).join('/');
    return load(target);
  }, exported);
  return exported;
}

const { AdaptiveLayoutInput } = load('pages/policy/AdaptiveLayoutInput');
const {
  SettingsPlacementMode,
  SettingsPlacementPolicy,
  SettingsSheetKind
} = load('pages/policy/SettingsPlacementPolicy');

/** The phone the compact answer is read from: 360 x 780 vp, nothing folded. */
const COMPACT_PHONE = [360, 780];
/** The tablet the centered answer is read from: 1440 x 960 vp, nothing folded. */
const WIDE_TABLET = [1440, 960];
/** Every sheet kind the app places, in catalog order. */
const EVERY_KIND = [
  SettingsSheetKind.Settings,
  SettingsSheetKind.Connect,
  SettingsSheetKind.SessionDetails,
  SettingsSheetKind.RemoteViewSettings,
  SettingsSheetKind.UserMessageFullText,
  SettingsSheetKind.WorkspaceTools
];

function input(width, height, overrides = {}) {
  return new AdaptiveLayoutInput(
    width,
    height,
    overrides.foldStatus || 0,
    overrides.isFolded || false,
    overrides.isExpandedFoldable || false,
    overrides.isHoverOperate || false,
    overrides.wideLayoutMatched === undefined ? width >= 600 : overrides.wideLayoutMatched,
    overrides.verticalCreases || [],
    overrides.horizontalCreases || [],
    overrides.isRtl || false
  );
}

function resolve(width, height, kind, overrides = {}) {
  return SettingsPlacementPolicy.resolve(input(width, height, overrides), kind);
}

test('a compact phone keeps every sheet at the bottom edge', () => {
  for (const kind of EVERY_KIND) {
    const placement = resolve(COMPACT_PHONE[0], COMPACT_PHONE[1], kind);
    assert.equal(placement.mode, SettingsPlacementMode.Bottom, `${kind} must stay a bottom sheet on a phone`);
    assert.equal(placement.width, 0, `${kind}: a bottom sheet is the window's own width`);
  }
  // The one kind that states a height at the bottom edge still does: the remote
  // view settings sheet is a fixed band there, and a band is not a dialog.
  assert.equal(
    resolve(COMPACT_PHONE[0], COMPACT_PHONE[1], SettingsSheetKind.RemoteViewSettings).height,
    SettingsPlacementPolicy.REMOTE_VIEW_SETTINGS_HEIGHT
  );
});

test('a wide window centers every sheet in a dialog, Settings included', () => {
  // Settings used to early-return the bottom band at every width — the comment on
  // it said "full-width bottom sheet at every width" — which is what a tablet
  // showed: a sheet the width of the screen's page, pinned to its bottom edge.
  // The kind is not special any more; nothing here is.
  for (const kind of EVERY_KIND) {
    const placement = resolve(WIDE_TABLET[0], WIDE_TABLET[1], kind);
    assert.equal(placement.mode, SettingsPlacementMode.Center,
      `${kind} must be a centered dialog on a wide window, not a ${placement.mode} sheet`);
    assert.ok(placement.width >= SettingsPlacementPolicy.TABLET_MIN_WIDTH &&
      placement.width <= SettingsPlacementPolicy.TABLET_MAX_WIDTH,
      `${kind}: the dialog width must stay inside the design clamp, got ${placement.width}`);
    assert.ok(placement.height > 0 && placement.height <= WIDE_TABLET[1] - 2 * SettingsPlacementPolicy.CENTER_VERTICAL_MARGIN,
      `${kind}: a centered dialog must fit between the window's margins, got ${placement.height}`);
    assert.ok(placement.height >= 300,
      `${kind}: a centered dialog still has to show content, got ${placement.height}`);
  }
  // The clamp is the side sheet's own: a ratio of the window, held between the
  // two bounds. A 1440 window is wide enough that the ratio is what bounds it in.
  assert.equal(resolve(WIDE_TABLET[0], WIDE_TABLET[1], SettingsSheetKind.Settings).width,
    Math.round(WIDE_TABLET[0] * SettingsPlacementPolicy.TABLET_WIDTH_RATIO));
});

test('the kinds keep their own heights inside the dialog', () => {
  const details = resolve(WIDE_TABLET[0], WIDE_TABLET[1], SettingsSheetKind.SessionDetails);
  const view = resolve(WIDE_TABLET[0], WIDE_TABLET[1], SettingsSheetKind.RemoteViewSettings);
  const settings = resolve(WIDE_TABLET[0], WIDE_TABLET[1], SettingsSheetKind.Settings);
  assert.equal(details.height, SettingsPlacementPolicy.SESSION_DETAILS_HEIGHT);
  assert.equal(view.height, SettingsPlacementPolicy.REMOTE_VIEW_SETTINGS_HEIGHT);
  // The general kinds take the window-driven side height, clamped the same way it
  // always was: a dialog and a side panel are the same panel, moved.
  assert.equal(settings.height, SettingsPlacementPolicy.SIDE_MAX_HEIGHT);
});

test('a window too short for a dialog bounds the dialog instead of overflowing it', () => {
  // A landscape phone is wide and short. The centered answer is still the answer
  // — the page is visible around a dialog-sized sheet — but the dialog may not be
  // taller than the space between its margins.
  const placement = resolve(780, 360, SettingsSheetKind.Settings);
  assert.equal(placement.mode, SettingsPlacementMode.Center);
  assert.equal(placement.height, 360 - 2 * SettingsPlacementPolicy.CENTER_VERTICAL_MARGIN);
});

test('a folded screen keeps the bottom sheet its own leaf asked for', () => {
  // The hardware leaves one leaf's worth of window, so a dialog in the middle of
  // it is a dialog on top of a page nobody can see around. The folded posture
  // answers "bottom" for every kind, wide window or not.
  for (const kind of EVERY_KIND) {
    const folded = resolve(900, 900, kind, { isFolded: true });
    assert.equal(folded.mode, SettingsPlacementMode.Bottom, `${kind} must stay a bottom sheet when folded`);
  }
});

test('a half-folded operate half keeps the sheet in the half that is operated', () => {
  const hover = resolve(900, 1200, SettingsSheetKind.Settings, {
    isHoverOperate: true,
    isExpandedFoldable: true,
    horizontalCreases: [{ top: 600, height: 0 }]
  });
  assert.equal(hover.mode, SettingsPlacementMode.FoldOperate,
    'a half-folded screen keeps the sheet in its operate half, not the middle of the fold');
  assert.equal(hover.maxHeight, 600);
  assert.equal(hover.height, 600);
  // The kinds that state a height state it here too, inside the operate half.
  const details = resolve(900, 1200, SettingsSheetKind.SessionDetails, {
    isHoverOperate: true,
    isExpandedFoldable: true,
    horizontalCreases: [{ top: 600, height: 0 }]
  });
  assert.equal(details.mode, SettingsPlacementMode.FoldOperate);
  assert.equal(details.height, SettingsPlacementPolicy.SESSION_DETAILS_HEIGHT);
});

test('a vertical crease keeps the sheet inside one leaf rather than across the fold', () => {
  // An expanded foldable is wide, so the window would say "centered" — and the
  // center of that window is the fold itself. The crease decides instead: the
  // sheet is docked inside the trailing leaf and may not straddle the hinge.
  const creases = [{ left: 720, width: 0 }];
  const placement = resolve(1440, 960, SettingsSheetKind.Settings, {
    isExpandedFoldable: true,
    verticalCreases: creases
  });
  assert.equal(placement.mode, SettingsPlacementMode.Side);
  assert.equal(placement.width, 720, 'the sheet fills the leaf the crease leaves free');
  assert.equal(SettingsPlacementPolicy.sheetIntersectsVerticalCrease(placement, creases[0], 1440), false,
    'a sheet that straddled the hinge would be drawn on both halves of the device');
  // A crease that reaches the window's edge leaves no leaf to place in, so it is
  // not a usable one and the window's own width decides again.
  const edge = resolve(1440, 960, SettingsSheetKind.Settings, {
    isExpandedFoldable: true,
    verticalCreases: [{ left: 0, width: 1440 }]
  });
  assert.equal(edge.mode, SettingsPlacementMode.Center);
});

test('an overlay hosted by another surface inherits its host answer and its own height', () => {
  // The session action list is not placed by the window: it opens from the
  // session list, so it is postured as that list is postured. Its height is its
  // own — a short sheet wherever it lands.
  const wide = resolve(WIDE_TABLET[0], WIDE_TABLET[1], SettingsSheetKind.SessionDetails);
  const hosted = SettingsPlacementPolicy.hostedOverlay(wide, SettingsPlacementPolicy.SESSION_ACTION_HEIGHT);
  assert.equal(hosted.mode, SettingsPlacementMode.Center, 'a wide host centres the list it opened');
  assert.equal(hosted.width, wide.width);
  assert.equal(hosted.height, SettingsPlacementPolicy.SESSION_ACTION_HEIGHT);
  // A dialog may not be taller than the dialog it opened from.
  assert.equal(
    SettingsPlacementPolicy.hostedOverlay(wide, wide.height + 100).height,
    wide.height
  );
  // Every other host keeps the bottom sheet it always had.
  const compact = resolve(COMPACT_PHONE[0], COMPACT_PHONE[1], SettingsSheetKind.SessionDetails);
  const hostedCompact = SettingsPlacementPolicy.hostedOverlay(
    compact,
    SettingsPlacementPolicy.SESSION_ACTION_HEIGHT
  );
  assert.equal(hostedCompact.mode, SettingsPlacementMode.Bottom);
  assert.equal(hostedCompact.width, 0);
  assert.equal(hostedCompact.height, SettingsPlacementPolicy.SESSION_ACTION_HEIGHT);
});

test('the compact default is the bottom sheet, and an unmeasured window does not crash', () => {
  // Call sites default to `compactBottom` before the window has been measured, and
  // a first layout pass can report zeros. Both have to answer the bottom sheet.
  assert.equal(SettingsPlacementPolicy.compactBottom(SettingsSheetKind.Settings).mode,
    SettingsPlacementMode.Bottom);
  assert.equal(SettingsPlacementPolicy.compactBottom(SettingsSheetKind.WorkspaceTools).mode,
    SettingsPlacementMode.Bottom);
  for (const kind of EVERY_KIND) {
    const unbounded = SettingsPlacementPolicy.resolve(AdaptiveLayoutInput.empty(), kind);
    assert.equal(unbounded.mode, SettingsPlacementMode.Bottom, `${kind} on an unmeasured window`);
  }
});

test('the narrow side of the breakpoint is still a bottom sheet', () => {
  // The breakpoint is 600 vp: 599 is a phone, 600 is a wide window. The two are
  // asserted together so a change to either bound moves this test.
  assert.equal(resolve(599, 900, SettingsSheetKind.Settings).mode, SettingsPlacementMode.Bottom);
  const atBreakpoint = resolve(600, 900, SettingsSheetKind.Settings);
  assert.equal(atBreakpoint.mode, SettingsPlacementMode.Center);
  assert.equal(atBreakpoint.width, SettingsPlacementPolicy.TABLET_MIN_WIDTH,
    'a 600 vp window is wide enough to place a sheet but too narrow for the ratio to clear the floor');
});
