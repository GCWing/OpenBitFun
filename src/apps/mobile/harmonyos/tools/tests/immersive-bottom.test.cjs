const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Source-level assertions. The immersive bottom is a contract between the
// window (which runs full-screen), the chat page (whose fade owns the bottom
// edge), every other scrolling surface (whose viewport runs to the screen edge
// and whose content ends in a tail spacer) and each surface's fixed bottom
// controls (which keep the navigation bar clear themselves). None of that is
// visible in a unit test of a policy object, and all of it is exactly what a
// later edit is most likely to undo by accident, so it is asserted against the
// files that carry it.
function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

const entryAbility = source('entry/src/main/ets/entryability/EntryAbility.ets');
const conversationView = source('entry/src/main/ets/pages/components/ConversationView.ets');
const windowService = source('entry/src/main/ets/services/WindowSystemBarService.ets');
const moduleConfig = source('entry/src/main/module.json5');
const appShell = source('entry/src/main/ets/pages/components/AppShell.ets');
const appSidebar = source('entry/src/main/ets/pages/components/AppSidebar.ets');
const miniAppSurface = source('entry/src/main/ets/pages/components/MiniAppSurface.ets');
const settingsSheet = source('entry/src/main/ets/pages/components/SettingsSheet.ets');
const workspaceToolsPanel = source('entry/src/main/ets/pages/components/WorkspaceToolsPanel.ets');
const workspacePicker = source('entry/src/main/ets/pages/components/SidebarWorkspacePicker.ets');
const connectView = source('entry/src/main/ets/pages/components/ConnectView.ets');
const filePreviewSurface = source('entry/src/main/ets/pages/components/FilePreviewSurface.ets');
const remoteSessionList = source('entry/src/main/ets/pages/components/RemoteSessionList.ets');
const sessionActionSurface = source('entry/src/main/ets/pages/components/SessionActionSurface.ets');
const sessionDetailsView = source('entry/src/main/ets/pages/components/SessionDetailsView.ets');
const conversationViewSettings = source('entry/src/main/ets/pages/components/ConversationViewSettings.ets');
const welcomeHome = source('entry/src/main/ets/pages/components/WelcomeHome.ets');
const remoteSurfaceHost = source('entry/src/main/ets/pages/components/remote/RemoteSurfaceHost.ets');
const wideConversationHost = source('entry/src/main/ets/pages/components/WideConversationHost.ets');

// Reads one component's build() chain, so an assertion can name the root box a
// page paints without reaching into the file's other builders.
function buildChain(sourceText) {
  const start = sourceText.indexOf('build() {');
  assert.notEqual(start, -1, 'the component must keep its build()');
  const end = sourceText.indexOf('\n  @Builder', start);
  assert.notEqual(end, -1, 'build() must be followed by another builder');
  return sourceText.slice(start, end);
}

// Reads one @Builder out of a component, so an assertion can name the layer it
// is about instead of counting matches in the whole file.
function builderBody(sourceText, name) {
  const start = sourceText.indexOf(`\n  private ${name}() {`);
  assert.notEqual(start, -1, `${name}() must stay a builder of the component`);
  const end = sourceText.indexOf('\n  @Builder', start);
  assert.notEqual(end, -1, `${name}() must be followed by another builder`);
  return sourceText.slice(start, end);
}

// Collapses a slice to one line so an assertion is about the call, not about
// where the formatter happened to wrap it. Comments drop out first: an
// explanation between a call's arguments is part of the source, not of the call.
function normalize(sourceText) {
  return sourceText.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ');
}

// Reads one chained call out of a slice so the assertions survive rewrapping.
function call(sourceText, name) {
  const start = sourceText.indexOf(`.${name}(`);
  assert.notEqual(start, -1, `the slice must keep its .${name}() call`);
  let depth = 0;
  for (let index = start + name.length + 1; index < sourceText.length; index++) {
    if (sourceText[index] === '(') {
      depth += 1;
    } else if (sourceText[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        return sourceText.slice(start, index + 1).replace(/\s+/g, ' ');
      }
    }
  }
  throw new Error(`unbalanced .${name}() call`);
}

// Counts a literal, so an assertion can be about how many times a call exists
// rather than only about whether it exists at all.
function occurrences(sourceText, needle) {
  return sourceText.split(needle).length - 1;
}

test('the shell runs the window full-screen for every page', () => {
  // Not the welcome page's private trick any more: the transcript can only reach
  // the bottom edge of the screen if the window stops reserving the strip above
  // it, and that has to hold while the chat page is the mounted page.
  assert.match(entryAbility, /mainWindow\.setWindowLayoutFullScreen\(true\)/,
    'the ability must lay the window out full-screen');
  assert.equal(entryAbility.includes('setWindowLayoutFullScreen(false)'), false,
    'no code path may put the window back into a non-immersive layout');
  assert.equal(entryAbility.includes('updateWindowLayout'), false,
    'the welcome page must not switch the window layout any more');
});

test('neither system bar sets a background so the page owns their strips', () => {
  // The window runs full-screen, so the status bar's strip is the page's own
  // top edge: the drawer's fill and the chat page's blurred header band are what
  // should show there. The strips are transparent by platform default and carry
  // the page's own background through, so the ability must not set a background
  // colour on them at all. An opaque bar painted the page colour over both — it
  // clipped the sidebar's title — and it also sat over the pull-down
  // notification centre's frosted background as a white strip. The content
  // colour is what keeps the clock and the icons legible either way.
  const bars = call(normalize(entryAbility), 'setWindowSystemBarProperties');
  assert.equal(bars.includes('statusBarColor:'), false,
    'the status bar must keep the platform default background instead of setting one');
  assert.equal(bars.includes('navigationBarColor:'), false,
    'the navigation bar must keep the platform default background instead of setting one');
  assert.match(bars, /statusBarContentColor: content/,
    'the status bar icons must keep following the colour mode');
  assert.match(bars, /navigationBarContentColor: content/,
    'the navigation bar icons must keep following the colour mode');
});

test('the window inset service is the only place the strip is measured', () => {
  assert.match(windowService, /export class WindowInsetsBinding/,
    'the insets must be shared through one binding');
  assert.match(windowService, /bottomPadding\(designSpacing: number\): number \{[\s\S]*?Math\.max\(designSpacing, this\.bottom\)/,
    'the binding must keep the design spacing wherever it already clears the strip');
  assert.match(windowService, /appWindow\.on\('avoidAreaChange'/, 'the binding must follow avoid-area changes');
  assert.match(windowService, /appWindow\.off\('avoidAreaChange'/, 'the binding must release its listener');
});

test('the whole app subscribes to the window once, not once per surface', () => {
  // One window, one avoid-area fact. Fourteen surfaces each opening their own
  // `getLastWindow` and their own listener meant fourteen subscriptions to the
  // same event and a window during which two surfaces disagreed about the strip
  // between them. There is one read and one listener left, and this is the
  // assertion that keeps a component from quietly growing its own again: the
  // per-component subscription is a regression, however convenient it looks.
  assert.equal(occurrences(windowService, "appWindow.on('avoidAreaChange'"), 1,
    'the window must be subscribed to exactly once, by the shared broadcast: a second listener means a component opened its own');
  assert.equal(occurrences(windowService, "appWindow.off('avoidAreaChange'"), 1,
    'the window must be released exactly once: a second release means a component closed a listener it did not open');
  assert.equal(occurrences(windowService, 'window.getLastWindow('), 2,
    'only the full-screen setup and the shared inset read may ask for the window');

  // Reference counted: the first registration opens the shared subscription and
  // the last release closes it, so the app holds the window for exactly as long
  // as one surface is actually mounted on it.
  const broadcast = normalize(windowService.slice(
    windowService.indexOf('class InsetsBroadcast'),
    windowService.indexOf('const sharedInsetsBroadcast')));
  assert.match(broadcast, /subscribe\(context: Context, listener: WindowInsetListener\): WindowInsetSubscription/,
    'a binding must register its callback with the broadcast rather than with the window');
  assert.match(broadcast, /if \(this\.listeners\.length === 1\) \{ this\.open\(context\); \} listener\(this\.current\);/,
    'the first registration must open the shared window subscription and hand the new subscriber the current value');
  assert.match(broadcast, /if \(this\.listeners\.length === 0\) \{ this\.close\(\); \}/,
    'the last release must close the shared window subscription');
  assert.match(broadcast, /if \(generation !== this\.generation \|\| this\.listeners\.length === 0\) \{ subscription\(\); return; \}/,
    'a window read that resolves after the last release, or after a later open, must be handed straight back');
  assert.match(normalize(windowService), /this\.subscription = sharedInsetsBroadcast\.subscribe\(context, callback\);/,
    'the binding must take its registration from the shared broadcast');

  // The binding's public shape is what the 14+ surfaces are written against, so
  // it stays: bind/unbind keep their signature, and every padding primitive the
  // pages consume is still here. A page that needs the top strip mounts a
  // binding — the one-shot read it used to have could not follow a rotation.
  assert.match(windowService, /bind\(uiContext: UIContext, context: Context\): void \{/,
    'the binding must keep the bind signature every surface already calls');
  assert.match(windowService, /unbind\(\): void \{/, 'the binding must keep its unbind');
  for (const primitive of ['leftPadding', 'rightPadding', 'sidePadding', 'bottomPadding', 'tailSpacing']) {
    assert.match(windowService, new RegExp(`${primitive}\\(designSpacing: number\\): number \\{`),
      `the binding must keep ${primitive} as its own primitive`);
  }
  assert.equal(windowService.includes('topSystemInsetPx'), false,
    'the one-shot status-bar read must stay gone: it could not follow a rotation, and the binding it was folded into can');
  assert.match(normalize(welcomeHome), /\.padding\(\{ top: this\.insets\.top \}\)/,
    'the welcome page must reserve the top strip from the shared binding');
});

test('the insets merge every avoid area that claims an edge, cutout included', () => {
  // The camera cutout is an avoid area of its own: the framework's SYSTEM area
  // is the status bar and the navigation bar only, so a model that read those
  // two could not express a cutout at all — and the cutout is the one area that
  // moves, onto a side edge, as soon as the device rotates. More than one area
  // can claim the same edge, and they overlap rather than stack, so an edge is
  // the widest claim among them: the merge is one `Math.max` per edge, the same
  // merge the official `handleCutoutAvoidArea` sample performs.
  assert.match(windowService, /export function mergeAvoidEdges\(areas: AvoidEdges\[\]\): AvoidEdges/,
    'the per-edge merge must stay a function of its own, not be buried in the reader');
  const merge = normalize(windowService.slice(
    windowService.indexOf('export function mergeAvoidEdges'),
    windowService.indexOf('export class WindowSystemBarService')));
  for (const edge of ['top', 'bottom', 'left', 'right']) {
    assert.match(merge, new RegExp(`${edge} = Math\\.max\\(${edge}, area\\.${edge}\\)`),
      `the merge must take the widest claim on the ${edge} edge`);
  }
  const insetsOf = normalize(windowService.slice(windowService.indexOf('private static insetsOf')));
  for (const type of ['TYPE_SYSTEM', 'TYPE_NAVIGATION_INDICATOR', 'TYPE_CUTOUT']) {
    assert.match(insetsOf, new RegExp(type),
      `${type} must be one of the areas the insets are read from`);
  }
  // The keyboard keeps owning the bottom strip while it is up: `RESIZE` has
  // already lifted the page above it (see ConversationView), so reserving the
  // navigation indicator as well would count the same strip twice.
  assert.match(insetsOf, /bottom: keyboardVisible \? 0 : merged\.bottom/,
    'the keyboard must keep taking the bottom strip while it is visible');
});

test('the binding exposes the side strips and the paddings that consume them', () => {
  // Left and right are 0 on a portrait phone, so `max(design, strip)` is exactly
  // the design value there and the change is invisible until a device rotates
  // its camera onto that side. The three primitives are there because a cutout
  // only ever lands on one side: a full-width band reserves the side the device
  // claims and keeps its own gutter on the other, while a control that has to
  // stay centred reserves the wider of the two on both.
  for (const edge of ['top', 'bottom', 'left', 'right']) {
    assert.match(windowService, new RegExp(`@Trace ${edge}: number = 0;`),
      `the binding must publish the ${edge} strip`);
    assert.match(windowService, new RegExp(`this\\.${edge} = uiContext\\.px2vp\\(insets\\.${edge}\\)`),
      `the binding must convert the ${edge} strip to vp like the others`);
  }
  assert.match(normalize(windowService),
    /leftPadding\(designSpacing: number\): number \{ return Math\.max\(designSpacing, this\.left\); \}/,
    'a side strip must only ever raise its own side above the design spacing');
  assert.match(normalize(windowService),
    /rightPadding\(designSpacing: number\): number \{ return Math\.max\(designSpacing, this\.right\); \}/,
    'a side strip must only ever raise its own side above the design spacing');
  assert.match(normalize(windowService),
    /sidePadding\(designSpacing: number\): number \{ return Math\.max\(designSpacing, Math\.max\(this\.left, this\.right\)\); \}/,
    'a control that stays centred reserves the wider of the two sides');
});

test('the module declares the cutout as an avoid area', () => {
  // Without this metadata the page does not avoid the camera cutout at all: the
  // framework only treats it as an avoid area once the module asks, so neither
  // the side strips below nor a background expanded into it would exist. It is a
  // module-level entry, not a per-ability one: the declaration has to sit before
  // the abilities array starts.
  const moduleBlock = moduleConfig.slice(moduleConfig.indexOf('"module"'), moduleConfig.lastIndexOf('"abilities"'));
  assert.match(moduleBlock, /"name": "avoid_cutout",[\s\S]*?"value": "true"/,
    'the module must declare avoid_cutout before its abilities');
});

test('the binding owns both strip numbers a surface needs', () => {
  // bottomPadding is for a fixed control: the design's spacing, or the strip if
  // the strip is larger. tailSpacing is for the end of a scrolling surface: the
  // strip plus the design's own breathing, because the last row has to rest
  // above the bar once the surface that runs under it stops scrolling.
  assert.match(windowService,
    /tailSpacing\(designSpacing: number\): number \{[\s\S]*?return this\.bottom \+ designSpacing;/,
    'the binding must expose the tail spacer a scrolling surface ends with');
});

test('the chat page bottom layer reaches the screen edge and its composer does not move', () => {
  const bottom = builderBody(conversationView, 'BottomOverlay');
  // The layer's box grows by the strip, so its own gradient fills it — and it
  // carries the side strips too, because the layer is the window's full width
  // and the composer's own gutter lives inside it...
  assert.equal(call(bottom, 'padding'),
    '.padding({ left: this.insets.leftPadding(0), right: this.insets.rightPadding(0), bottom: this.bottomSafeInset })');
  // ...it may paint into the strip even where the page area still stops above
  // it, and it is named so a layout dump can be read against the pixels.
  assert.equal(call(bottom, 'expandSafeArea'),
    '.expandSafeArea([SafeAreaType.SYSTEM, SafeAreaType.CUTOUT], ' +
      '[SafeAreaEdge.START, SafeAreaEdge.END, SafeAreaEdge.BOTTOM])');
  assert.equal(call(bottom, 'id'), ".id('conversation-bottom-fade')");
  // The transcript borrows the layer's measured height, which is what lets the
  // last message scroll above the fade instead of under the composer.
  assert.match(bottom, /this\.bottomInset = newArea\.height as number;/,
    'the transcript inset must keep following the layer it is measured from');
});

test('the chat page header band reserves the status bar itself', () => {
  // The shell is immersive, so the page draws from the top of the window and the
  // band is what has to keep the header out of the status bar. Its own box is
  // the transcript's content start offset, so the two stay in step. The band is
  // the window's full width as well, which is what makes its sides the sides the
  // camera cutout rotates onto; the header's own gutter is inside it and is not
  // restated here.
  const top = builderBody(conversationView, 'TopOverlay');
  assert.equal(call(top, 'padding'),
    '.padding({ left: this.insets.leftPadding(0), right: this.insets.rightPadding(0), top: this.topSafeInset })');
  assert.match(top, /\.backgroundColor\(PAGE_BG_OVERLAY\)/,
    'the band that carries the inset must stay the one that paints the header');
});

test('every surface whose top edge is the screen edge reserves the status bar', () => {
  // Immersive layout moved every page's origin to the top of the window, so the
  // first row of a full-screen surface is what has to keep clear of the status
  // bar. The band that owns the surface's fill carries the padding, which is
  // what keeps that fill reaching the top of the window while the controls start
  // below the clock and the indicators: the drawer panel's title, the gallery's
  // back control, the preview's header and the home headers' drawer control are
  // all one strip lower than they were while the page area ended below it.
  assert.match(normalize(builderBody(appSidebar, 'SidebarContent')),
    /\.padding\(\{ left: this\.insets\.leftPadding\(20\), right: this\.insets\.rightPadding\(20\), top: this\.insets\.top \}\)/,
    'the drawer panel must reserve the strip above its title');
  assert.match(normalize(miniAppSurface),
    /\.height\(56 \+ this\.insets\.top\)\s*\.padding\(\{ left: this\.insets\.leftPadding\(12\), right: this\.insets\.rightPadding\(12\), top: this\.insets\.top \}\)/,
    'the mini-app gallery header must reserve the strip');
  assert.match(normalize(filePreviewSurface),
    /\.height\(68 \+ this\.insets\.top\)[\s\S]*?\.padding\(\{ left: this\.insets\.leftPadding\(8\), right: this\.insets\.rightPadding\(8\), top: 8 \+ this\.insets\.top, bottom: 8 \}\)/,
    'the file preview header must reserve the strip');
  assert.match(normalize(remoteSurfaceHost),
    /\.padding\(\{ left: this\.insets\.leftPadding\(0\), right: this\.insets\.rightPadding\(0\), top: this\.insets\.top \}\)/,
    'the compact home header must reserve the strip');
  assert.match(normalize(remoteSurfaceHost),
    /\.height\(76 \+ this\.insets\.top\)\s*\.padding\(\{ left: this\.insets\.leftPadding\(16\), right: this\.insets\.rightPadding\(16\), top: 14 \+ this\.insets\.top, bottom: 12 \}\)/,
    'the wide home header must reserve the strip');
  // A floating control on a pane whose top edge is the window's keeps the strip
  // clear itself, the way the surfaces' fixed bottom controls keep the
  // navigation bar clear. Its left edge is the window's edge in the collapsed
  // wide layout, so the same offset carries the side strip.
  assert.match(normalize(wideConversationHost),
    /\.position\(\{ x: this\.insets\.leftPadding\(12\), y: 12 \+ this\.insets\.top \}\)/,
    'the floating master-restore control must reserve the strip');
  for (const [name, text] of [['RemoteSurfaceHost', remoteSurfaceHost],
    ['WideConversationHost', wideConversationHost]]) {
    assert.match(text, /@Local insets: WindowInsetsBinding = new WindowInsetsBinding\(\);/,
      `${name} must hold the shared inset binding`);
    assert.match(text, /this\.insets\.bind\(this\.getUIContext\(\), context\)/,
      `${name} must bind the insets while it is mounted`);
    assert.match(text, /this\.insets\.unbind\(\)/, `${name} must release the insets when it goes`);
  }
});

test('the settings sheet viewport reaches the screen edge and its rows end in a tail spacer', () => {
  // The sheet is a bindSheet, which the framework does not inset while the
  // window is immersive, so its own box decides where content can scroll. The
  // root must not carry a bottom padding any more: that shrinks the viewport
  // and leaves a band of bare page colour under the navigation bar.
  const build = normalize(settingsSheet.slice(
    settingsSheet.indexOf('build() {'),
    settingsSheet.indexOf('@Builder', settingsSheet.indexOf('build() {'))));
  assert.equal(/\.padding\(\{[^}]*bottom/.test(build), false,
    'the sheet root must not shrink its own viewport away from the screen edge');
  assert.match(normalize(settingsSheet),
    /\.padding\(\{ left: SHEET_HORIZONTAL_PADDING, right: SHEET_HORIZONTAL_PADDING, top: 22, bottom: this\.insets\.tailSpacing\(34\) \}\)/,
    "the sheet's scrolling column must end in the strip plus its own breathing");
});

test('the mini-app gallery viewport reaches the screen edge and its grid ends in a tail spacer', () => {
  // The gallery container must not carry a bottom padding: the grid is the
  // surface's bottom edge and its tiles have to roll under the navigation bar.
  assert.match(normalize(miniAppSurface),
    /\.padding\(\{ left: 16, right: 16 \}\)/,
    'the gallery container must keep only its horizontal padding');
  assert.equal(/\.padding\(\{[^}]*bottomPadding/.test(miniAppSurface), false,
    'the gallery must not shrink its viewport away from the screen edge');
  const grid = normalize(miniAppSurface.slice(miniAppSurface.indexOf('Grid() {')));
  assert.match(grid, /GridItem\(\) \{ Column\(\) \.width\('100%'\) \.height\(this\.insets\.tailSpacing\(24\)\) \}/,
    'the grid must end with a tail spacer row');
  assert.match(grid, /\.columnStart\(0\)/,
    'the tail spacer must start at the first column');
  assert.match(grid, /\.columnEnd\(this\.galleryColumns\(\) - 1\)/,
    'the tail spacer must span to the last column');
  assert.match(grid, /\.columnsTemplate\(this\.galleryColumnsTemplate\(\)\)/,
    'the grid template and the spacer span must stay one decision');
});

test('the sidebar list scrolls under the bar and its floating footer keeps the strip clear', () => {
  // The sidebar is a scrolling session list with a floating footer, which is
  // the chat page's shape: the viewport runs to the panel's own bottom edge,
  // the footer keeps its distance from that edge itself, and the list ends in
  // a tail spacer so its last row rests above the navigation bar.
  const content = normalize(builderBody(appSidebar, 'SidebarContent'));
  assert.match(content,
    /\.padding\(\{ left: this\.insets\.leftPadding\(20\), right: this\.insets\.rightPadding\(20\), top: this\.insets\.top \}\)/,
    'the panel root must reserve the status bar without shrinking its scrolling viewport');
  assert.match(content, /\.padding\(\{ bottom: this\.scrollTailPadding\(\) \}\)/,
    'the session list must end in a tail spacer');
  assert.match(content, /\.margin\(\{ bottom: this\.footerBottomPadding\(\) \}\)/,
    'the footer and its fade must keep the strip clear themselves');
  assert.match(normalize(appSidebar),
    /private scrollTailPadding\(\): number \{[\s\S]*?\(this\.usesCompactFooter\(\) \? 84 : 120\) \+ this\.insets\.bottom;/,
    'the tail must clear the floating footer and the strip');
  assert.match(normalize(appSidebar),
    /private footerBottomPadding\(\): number \{[\s\S]*?return this\.insets\.bottomPadding\(16\);/,
    'the footer must keep the design spacing wherever the strip is already clear');
});

test('the workspace tools sheet scrolls under the bar and its fixed controls do not', () => {
  // The tools sheet is a full-height bindSheet: its file list runs to the screen
  // edge and ends in a tail spacer, while the terminal key row and the upload
  // controls are fixed bottom controls that keep the strip clear themselves.
  const build = normalize(workspaceToolsPanel.slice(
    workspaceToolsPanel.indexOf('build() {'),
    workspaceToolsPanel.indexOf('@Builder', workspaceToolsPanel.indexOf('build() {'))));
  assert.equal(build.includes('.padding({ left: 16, right: 16, bottom'), false,
    'the panel root must not shrink its scrolling viewport');
  assert.match(normalize(workspaceToolsPanel),
    /ListItem\(\) \{ Column\(\)\.width\('100%'\)\.height\(this\.insets\.tailSpacing\(16\)\) \}/,
    'the file list must end in a tail spacer');
  assert.match(normalize(workspaceToolsPanel),
    /\.margin\(\{ bottom: this\.insets\.bottomPadding\(16\) \}\)/,
    'the fixed bottom controls must keep the strip clear');
  // The file action form is a FIT_CONTENT sheet: its buttons are the fixed
  // controls at the screen edge, so the form's own bottom padding is what keeps
  // them out of the strip.
  assert.match(normalize(workspaceToolsPanel),
    /\.padding\(\{ left: 20, right: 20, top: 20, bottom: this\.insets\.bottomPadding\(24\) \}\)/,
    'the file action form must keep its buttons out of the strip');
});

test('the workspace tools editor keeps its card above the bar', () => {
  // The editor is a WebView: its scrolling and padding live inside the web
  // renderer, so the ArkUI tail spacer cannot reach its content and the card is
  // fixed content instead — its bottom edge stops at the navigation bar's top,
  // the same clearance the terminal key row keeps.
  const editor = normalize(builderBody(workspaceToolsPanel, 'Editor'));
  assert.match(editor,
    /\.backgroundColor\(CARD\) \.margin\(\{ bottom: this\.insets\.bottomPadding\(16\) \}\)/,
    'the editor card must stop at the bar top instead of running under it');
});

test('the remaining bottom sheets keep their content out of the bar', () => {
  // The session action sheet is a fixed-height bottom sheet: its action rows
  // are fixed controls, so the surface's bottom padding is strip-aware — the
  // sheet host resolves it, because only the host knows which presentation
  // sits at the screen edge.
  assert.match(normalize(sessionActionSurface),
    /\.padding\(\{ left: 16, right: 16, top: 10, bottom: this\.bottomPadding \}\)/,
    'the action surface must take its bottom padding from its host');
  assert.match(normalize(remoteSessionList),
    /bottomPadding: presentation === SessionActionPresentation\.BottomSheet \? this\.insets\.bottomPadding\(18\) : 18/,
    'the bottom-sheet presentation must clear the strip, the popover must not grow');
  // The session details and view settings sheets are scrolling surfaces: their
  // viewport runs to the screen edge and their content ends in a strip-aware
  // tail, the same contract the settings sheet keeps.
  assert.match(normalize(sessionDetailsView),
    /\.padding\(\{ left: 20, right: 20, top: 8, bottom: this\.insets\.tailSpacing\(24\) \}\)/,
    'the session details tail must clear the strip');
  assert.match(normalize(conversationViewSettings),
    /\.padding\(\{ left: 20, right: 20, bottom: this\.insets\.tailSpacing\(24\) \}\)/,
    'the view settings tail must clear the strip');
});

test('the session sheets each bind on their own node', () => {
  // A node carries at most one bindSheet: chaining the action sheet and the
  // details sheet on one node left the first sheet unopenable, so the action
  // sheet binds on its own zero-height carrier row and the details sheet stays
  // on the root — the same pattern the sidebar's section uses for its pair.
  const build = normalize(remoteSessionList.slice(
    remoteSessionList.indexOf('build() {'),
    remoteSessionList.indexOf('@Builder', remoteSessionList.indexOf('build() {'))));
  assert.match(build, /Row\(\) \{\}\.height\(0\) \.bindSheet\(\$\$this\.showSessionActionSheet/,
    'the action sheet must bind on its own carrier node');
  assert.match(build, /\.alignItems\(HorizontalAlign\.Start\) \.bindSheet\(\$\$this\.showSessionDetails/,
    'the details sheet must be the root chain\'s only sheet');
});

test('the full-height sheets keep their fixed bottom controls out of the bar', () => {
  // These surfaces do not scroll at their bottom edge; their fixed controls
  // carry the strip (or their design spacing, where the strip is already clear)
  // so no control sits in the navigation bar's strip.
  assert.match(normalize(workspacePicker),
    /\.padding\(\{ top: 12, bottom: this\.insets\.bottomPadding\(16\) \}\)/,
    'the workspace picker confirm button must clear the strip');
  assert.match(normalize(connectView),
    /\.padding\(\{ bottom: this\.insets\.bottomPadding\(28\) \}\)/,
    'the connect sheet status strip must clear the strip');
});

test('the file preview scrollers end in strip-aware tails', () => {
  // The preview scrollers already run to the screen edge; their tails are what
  // rests the last line above the navigation bar.
  assert.match(normalize(filePreviewSurface),
    /\.padding\(\{ left: 12, right: 12, top: 14, bottom: this\.insets\.tailSpacing\(24\) \}\)/,
    'the text preview tail must clear the strip');
  assert.match(normalize(filePreviewSurface),
    /\.padding\(\{ left: 16, right: 16, top: 16, bottom: this\.insets\.tailSpacing\(28\) \}\)/,
    'the markdown preview tail must clear the strip');
});

test('the welcome dock reads the strip through the shared binding', () => {
  // The dock paints into the strip (expandSafeArea carries its background to
  // the screen edge), so its buttons must keep their clearance from a measured
  // strip: the design spacing where it is already taller, the strip itself
  // where a device's indicator is higher. A hard-coded clearance only looked
  // right on the reference device.
  assert.match(normalize(welcomeHome),
    /bottom: this\.wide\(\) \? 0 : this\.insets\.bottomPadding\(G\.welcomeDockBottom\)/,
    'the dock must lift its content by the strip wherever the indicator is taller');
  assert.match(welcomeHome,
    /\.expandSafeArea\(\[SafeAreaType\.SYSTEM, SafeAreaType\.CUTOUT\], \[SafeAreaEdge\.BOTTOM\]\)/,
    'the dock fill must still reach the screen edge');
});

test('every background that owns a screen edge claims the cutout as well', () => {
  // The CUTOUT area is described separately from SYSTEM — which the framework
  // defines as the status bar and the navigation bar — so a fill that claims the
  // system area alone stops short of a notch and shows the page colour beside
  // it. These are the four full-bleed backgrounds of the shell: the drawer's
  // floor, the account cover's scrim, the chat page's bottom fade and the home
  // dock.
  for (const [name, text, expected] of [['AppShell', appShell, 2],
    ['ConversationView', conversationView, 1], ['WelcomeHome', welcomeHome, 1]]) {
    const claims = (text.match(/\.expandSafeArea\(\[SafeAreaType\.SYSTEM, SafeAreaType\.CUTOUT\]/g) ?? []).length;
    assert.equal(claims, expected, `${name} must claim the cutout wherever it claims the system area`);
    const systemOnly = (text.match(/\.expandSafeArea\(\[SafeAreaType\.SYSTEM\]/g) ?? []).length;
    assert.equal(systemOnly, 0, `${name} must not leave a fill on the system area alone`);
  }
});

test('each fill names the edges its own box actually touches', () => {
  // Naming the cutout type is only half of the claim: `expandSafeArea` takes
  // effect per edge and only where the component's own boundary meets that
  // edge's safe-area boundary. A cutout in landscape sits on the window's left
  // or right edge, so a fill that named only TOP/BOTTOM claimed nothing at all
  // on the one edge the rotated cutout lands on, however clearly it named the
  // type. Each of the four fills now names exactly the edges its box owns:
  //
  //   drawer floor / cover scrim  the window itself, all four edges;
  //   chat page's bottom fade     the window's full width and its bottom edge,
  //                               while its top edge sits mid-pane — naming TOP
  //                               would claim a strip it never touches;
  //   home dock                   the bottom edge only, because the composition
  //                               that gives the dock a fill of its own is the
  //                               compact one, and a side cutout only exists in
  //                               a window wide enough for `wide()`, which swaps
  //                               that fill for a centred, capped column.
  const shellBuild = appShell.slice(appShell.indexOf('build() {'),
    appShell.indexOf('@Builder', appShell.indexOf('build() {')));
  for (const [name, slice, expected] of [
    ['the drawer floor', shellBuild,
      '[SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM, SafeAreaEdge.START, SafeAreaEdge.END]'],
    ['the account cover scrim', builderBody(appShell, 'CompactLoginCover'),
      '[SafeAreaEdge.TOP, SafeAreaEdge.BOTTOM, SafeAreaEdge.START, SafeAreaEdge.END]'],
    ['the chat page bottom fade', builderBody(conversationView, 'BottomOverlay'),
      '[SafeAreaEdge.START, SafeAreaEdge.END, SafeAreaEdge.BOTTOM]'],
    ['the home dock', builderBody(welcomeHome, 'Actions'),
      '[SafeAreaEdge.BOTTOM]']
  ]) {
    assert.equal(call(slice, 'expandSafeArea'),
      `.expandSafeArea([SafeAreaType.SYSTEM, SafeAreaType.CUTOUT], ${expected})`,
      `${name} must claim exactly the edges its box owns`);
  }
});


test('every surface whose side edge is the screen edge reserves the side strips', () => {
  // The side strips are the camera cutout, which a rotated device moves onto the
  // window's left or right edge. A full-width band consumes them per side —
  // `max(design, strip)` — so the design's own gutter survives on a device that
  // claims no side strip at all, which is every portrait phone.
  //
  // The sheets and covers are deliberately absent: `bindSheet` and
  // `bindContentCover` inset their own page horizontally, so their rows never
  // reach the window's side edges and a side padding there would only move
  // content that was already clear.
  for (const [name, text, pattern] of [
    ['the drawer panel', appSidebar,
      /\.padding\(\{ left: this\.insets\.leftPadding\(20\), right: this\.insets\.rightPadding\(20\), top: this\.insets\.top \}\)/],
    ['the compact home header', remoteSurfaceHost,
      /\.padding\(\{ left: this\.insets\.leftPadding\(0\), right: this\.insets\.rightPadding\(0\), top: this\.insets\.top \}\)/],
    ['the wide home header', remoteSurfaceHost,
      /\.padding\(\{ left: this\.insets\.leftPadding\(16\), right: this\.insets\.rightPadding\(16\), top: 14 \+ this\.insets\.top, bottom: 12 \}\)/],
    ['the gallery header', miniAppSurface,
      /\.padding\(\{ left: this\.insets\.leftPadding\(12\), right: this\.insets\.rightPadding\(12\), top: this\.insets\.top \}\)/],
    ['the preview header', filePreviewSurface,
      /\.padding\(\{ left: this\.insets\.leftPadding\(8\), right: this\.insets\.rightPadding\(8\), top: 8 \+ this\.insets\.top, bottom: 8 \}\)/],
    ['the chat header band', conversationView,
      /\.padding\(\{ left: this\.insets\.leftPadding\(0\), right: this\.insets\.rightPadding\(0\), top: this\.topSafeInset \}\)/],
    ['the composer layer', conversationView,
      /\.padding\(\{ left: this\.insets\.leftPadding\(0\), right: this\.insets\.rightPadding\(0\), bottom: this\.bottomSafeInset \}\)/]
  ]) {
    assert.match(normalize(text), pattern, `${name} must consume the side strips through the binding`);
  }
  assert.match(normalize(wideConversationHost),
    /\.position\(\{ x: this\.insets\.leftPadding\(12\), y: 12 \+ this\.insets\.top \}\)/,
    'the floating control must take its x offset through the binding as well');
});

test('every surface that owns a bottom edge reads the shared binding, not a constant', () => {
  for (const [name, text] of [['AppSidebar', appSidebar], ['MiniAppSurface', miniAppSurface],
    ['SettingsSheet', settingsSheet], ['ConversationView', conversationView],
    ['WorkspaceToolsPanel', workspaceToolsPanel], ['SidebarWorkspacePicker', workspacePicker],
    ['ConnectView', connectView], ['FilePreviewSurface', filePreviewSurface],
    ['RemoteSessionList', remoteSessionList], ['SessionDetailsView', sessionDetailsView],
    ['ConversationViewSettings', conversationViewSettings], ['WelcomeHome', welcomeHome]]) {
    assert.match(text, /@Local insets: WindowInsetsBinding = new WindowInsetsBinding\(\);/,
      `${name} must hold the shared inset binding`);
    assert.match(text, /this\.insets\.bind\(this\.getUIContext\(\), context\)/,
      `${name} must bind the insets while it is mounted`);
    assert.match(text, /this\.insets\.unbind\(\)/, `${name} must release the insets when it goes`);
  }
});

test('every top band the status bar shows through is a theme-following page colour', () => {
  // The window's status-bar content colour is one value for the whole window and
  // follows the colour mode alone (see `updateSystemBars` in EntryAbility): the
  // light ink on a light band, the dark ink on a dark one. That single value is
  // correct for every page shipped today for one reason only — every top band the
  // window shows through the transparent status bar is a theme-following page
  // colour — and this test is what turns that from a coincidence into a contract.
  //
  // Each entry names the band that owns the window's top edge and the semantic
  // colour it paints with. A band that becomes media chrome (`MEDIA_BACKGROUND` /
  // `MEDIA_SCRIM`, dark in both appearances) or a hard-coded colour puts the
  // light-mode ink on a dark band, and the clock and the status icons stop being
  // readable against it.
  const bands = [
    ['the drawer panel', builderBody(appSidebar, 'SidebarContent'), 'SIDEBAR_BG'],
    ['the chat header band', builderBody(conversationView, 'TopOverlay'), 'PAGE_BG_OVERLAY'],
    ['the gallery root', buildChain(miniAppSurface), 'PAGE_BG'],
    ['the file preview root', buildChain(filePreviewSurface), 'PAGE_BG'],
    ['the compact home root', builderBody(remoteSurfaceHost, 'CompactHomeContent'), 'PAGE_BG'],
    ['the wide home root', builderBody(remoteSurfaceHost, 'FlowPlaceholder'), 'PAGE_BG'],
    ['the wide home pane', builderBody(wideConversationHost, 'RemoteHomeContent'), 'PAGE_BG'],
    ['the wide home detail', builderBody(wideConversationHost, 'RemoteHomeDetail'), 'PAGE_BG'],
    ['the wide chat pane', builderBody(wideConversationHost, 'RemoteChatContent'), 'PAGE_BG'],
    ['the connect sheet root', buildChain(connectView), 'CARD'],
    ['the welcome page', buildChain(welcomeHome), 'WELCOME_PAGE_BG']
  ];
  const unreadable = 'the status bar icons are drawn in the colour-mode ink, so a top band that is dark in ' +
    'that same appearance makes them unreadable: handle the band and the system bar content colour together ' +
    '(see `updateSystemBars` in EntryAbility) instead of repainting the band on its own';
  for (const [name, slice, token] of bands) {
    assert.match(normalize(slice), new RegExp(`\\.backgroundColor\\(${token}\\)`),
      `${name} must paint its top band with the theme-following ${token}`);
    for (const forbidden of ['MEDIA_BACKGROUND', 'MEDIA_SCRIM']) {
      assert.equal(slice.includes(forbidden), false,
        `${name} must not paint its top band with ${forbidden} (dark in both appearances): ${unreadable}`);
    }
    assert.equal(slice.includes("backgroundColor('#"), false,
      `${name} must not paint its top band with a hard-coded colour: ${unreadable}`);
  }

  // The same rule for the fills that reach the screen edge rather than sitting in
  // a band: the status bar strip carries whatever the page paints there, so the
  // surfaces that own it are the ones that have to keep their own ink legible on
  // it. Each of the three already reads a theme-following token above.
  for (const [name, text] of [['AppShell', appShell], ['ConversationView', conversationView],
    ['WelcomeHome', welcomeHome]]) {
    assert.equal(text.includes('MEDIA_BACKGROUND'), false,
      `${name} must not paint a screen-edge fill with media chrome: ${unreadable}`);
  }
});

test('the chat page owns the keyboard avoidance the bottom rule assumes', () => {
  // `insetsOf` hands the bottom strip to the keyboard while it is visible,
  // because `KeyboardAvoidMode.RESIZE` has already lifted the page above it:
  // reserving the navigation indicator as well would count the same strip twice.
  // The mode is set by the chat page itself and only while that page is mounted,
  // so the rule leans on a page it cannot see. Without RESIZE the keyboard is
  // still up and the bottom strip is still handed to it, so the bottom is
  // reserved by the keyboard and the navigation bar both - the composer and
  // everything docked below the transcript sit under the keyboard with a
  // bar-sized hole beneath them.
  const appear = conversationView.slice(conversationView.indexOf('aboutToAppear(): void {'),
    conversationView.indexOf('aboutToDisappear(): void {'));
  const disappear = conversationView.slice(conversationView.indexOf('aboutToDisappear(): void {'),
    conversationView.indexOf('build() {'));
  assert.match(conversationView, /private previousKeyboardAvoidMode: KeyboardAvoidMode = /,
    'the chat page must keep the mode it found, so it can put it back');
  assert.match(appear, /this\.previousKeyboardAvoidMode = this\.getUIContext\(\)\.getKeyboardAvoidMode\(\);/,
    'the chat page must read the current keyboard avoid mode before it changes it');
  assert.match(appear, /this\.getUIContext\(\)\.setKeyboardAvoidMode\(KeyboardAvoidMode\.RESIZE\);/,
    'the chat page must set RESIZE while it is mounted: the bottom inset rule in WindowSystemBarService ' +
    'assumes the keyboard has already lifted the page, so without RESIZE the bottom is reserved by the ' +
    'keyboard and the navigation bar at once');
  assert.match(disappear,
    /this\.getUIContext\(\)\.setKeyboardAvoidMode\(this\.previousKeyboardAvoidMode\);/,
    'the chat page must restore the mode it found when it goes, so the rest of the shell keeps the platform default');
});

test('the side gesture area is deliberately not tracked, and says so', () => {
  // `TYPE_SYSTEM_GESTURE` is the region a system return gesture can start from,
  // and the official immersive sample reads it beside the areas this app merges.
  // The omission here is a recorded decision with a follow-up rather than an
  // oversight, so the note and the behaviour are asserted together: the day one
  // of them moves, the other has to move with it.
  assert.match(windowService, /TYPE_SYSTEM_GESTURE/,
    'the decision not to track the gesture area must stay recorded next to the merge it belongs to');
  const insetsOf = normalize(windowService.slice(windowService.indexOf('private static insetsOf')));
  assert.equal(insetsOf.includes('TYPE_SYSTEM_GESTURE'), false,
    'reading the gesture area is a new decision: it moves where every full-width band starts, so it must not ' +
    'be merged in as a drive-by, and the note above the merge has to be rewritten with it');
});
