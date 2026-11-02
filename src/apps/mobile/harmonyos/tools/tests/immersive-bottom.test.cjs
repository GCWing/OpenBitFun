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
//
// The overlay sheets are the other half of the same contract, and their chrome
// has one owner: the platform. `bindSheet` draws the title bar, the close icon,
// the background and the scrim, so a sheet that paints its own background, draws
// its own close icon or answers `maskColor` itself is the regression — see the
// sheet-chrome tests below.
function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

const entryAbility = source('entry/src/main/ets/entryability/EntryAbility.ets');
const conversationView = source('entry/src/main/ets/pages/components/ConversationView.ets');
const conversationRouteSurface = source('entry/src/main/ets/pages/components/ConversationRouteSurface.ets');
const conversationHeader = source('entry/src/main/ets/pages/components/ConversationHeader.ets');
const conversationHeaderPolicy = source('entry/src/main/ets/pages/policy/ConversationHeaderPolicy.ets');
const conversationHeaderMenu = source('entry/src/main/ets/pages/components/ConversationHeaderMenu.ets');
const composerBar = source('entry/src/main/ets/pages/components/ComposerBar.ets');
const rollbackStagingBar = source('entry/src/main/ets/pages/components/RollbackStagingBar.ets');
const immersiveSurfaceSupport = source('entry/src/main/ets/pages/components/ImmersiveSurfaceSupport.ets');
const navigationBackButton = source('entry/src/main/ets/pages/components/NavigationBackButton.ets');
const systemSymbolIcon = source('entry/src/main/ets/pages/components/SystemSymbolIcon.ets');
const hdsTitleBarSupport = source('entry/src/main/ets/pages/components/HdsTitleBarSupport.ets');
const hdsTitleBarPolicy = source('entry/src/main/ets/pages/policy/HdsTitleBarPolicy.ets');
const hdsTitleBarMaterialService = source('entry/src/main/ets/services/HdsTitleBarMaterialService.ets');
const immersiveBottomPreview = source('entry/src/main/ets/pages/preview/ImmersiveBottomPreview.ets');
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
const adaptiveSheetOptions = source('entry/src/main/ets/pages/components/AdaptiveSheetOptions.ets');
const userMessageFullTextSheet = source('entry/src/main/ets/pages/components/UserMessageFullTextSheet.ets');
const sidebarWorkspaceSection = source('entry/src/main/ets/pages/components/SidebarWorkspaceSection.ets');
const sidebarDeviceGroup = source('entry/src/main/ets/pages/components/SidebarDeviceGroup.ets');
const appRootOverlaySurfaces = source('entry/src/main/ets/pages/components/AppRootOverlaySurfaces.ets');
const appRootPresentation = source('entry/src/main/ets/pages/components/AppRootPresentation.ets');
const connectAccountDevicePage = source('entry/src/main/ets/pages/components/ConnectAccountDevicePage.ets');
const presentationActions = source('entry/src/main/ets/pages/actions/AppRootPresentationActions.ets');
const runtimeComposition = source('entry/src/main/ets/pages/runtime/AppRootRuntimeComposition.ets');

// The sheet titles reach the platform as text, so they have to be real catalog
// entries in both locales: `RemoteI18n.t` maps the dotted key onto a resource
// name (`chat.fullText` -> `chat_fullText`) and asks the resource manager for it.
const resourcesRoot = path.join(__dirname, '../../entry/src/main/resources');
function catalogResourceNames(locale) {
  const entries = JSON.parse(fs.readFileSync(path.join(resourcesRoot, locale, 'element/string.json'), 'utf8')).string;
  return new Set(entries.map((entry) => entry.name));
}
const enUsResourceNames = catalogResourceNames('en_US');
const zhCnResourceNames = catalogResourceNames('zh_CN');

// Every chromed sheet option a file answers itself.
//
// `backgroundColor` is only read where a content root is under test: content
// legitimately paints fills of its own. The other three are chrome wherever they
// appear, so they are checked over the whole tree. Both spellings count — the
// option-object form (`showClose: true`) and the property-assignment form
// (`options.showClose = true`) are the same override.
function chromeOptionsAnsweredIn(sourceText) {
  const found = new Set();
  for (const match of normalize(sourceText).matchAll(/\b(backgroundColor|maskColor|showClose|dragBar)\s*[:=]/g)) {
    found.add(match[1]);
  }
  return [...found].sort();
}

// Reads one component's build() chain, so an assertion can name the root box a
// page paints without reaching into the file's other builders.
function buildChain(sourceText) {
  const start = sourceText.indexOf('build() {');
  assert.notEqual(start, -1, 'the component must keep its build()');
  const end = sourceText.indexOf('\n  @Builder', start);
  assert.notEqual(end, -1, 'build() must be followed by another builder');
  return sourceText.slice(start, end);
}

// Reads one component's build() chain by name.
//
// Two things the plain `buildChain` cannot do and this needs: a file that
// carries more than one struct (the first `build() {` in such a file belongs to
// whichever struct is declared first, which is not the slice a caller means), and
// a component whose `build()` is its last member.
function buildChainOf(sourceText, structName) {
  const declaration = sourceText.indexOf(`export struct ${structName} {`);
  assert.notEqual(declaration, -1, `${structName} must stay a component of its file`);
  const body = sourceText.slice(declaration);
  const start = body.indexOf('build() {');
  assert.notEqual(start, -1, `${structName} must keep its build()`);
  const nextBuilder = body.indexOf('\n  @Builder', start);
  return nextBuilder === -1 ? body : body.slice(start, nextBuilder);
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

// The composer's pill chain.
//
// `AdaptiveComposer()` is not declared `private`, so the shared `builderBody`
// above — which names only private builders — cannot read it. The slice is the
// same one, taken from the declaration this file actually has, and it is what
// carries the pill's floor, blur, edge, shadow and material.
function composerPillChain() {
  const start = composerBar.indexOf('AdaptiveComposer() {');
  assert.notEqual(start, -1, 'ComposerBar must keep its AdaptiveComposer() builder');
  const end = composerBar.indexOf('\n  @Builder', start);
  assert.notEqual(end, -1, 'AdaptiveComposer() must be followed by another builder');
  return composerBar.slice(start, end);
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

// Counts the component material *attribute* — the chained call on a component, not the
// support class's own mapping method and not an option object's field. Both of those
// carry the same name without being the attribute: `HdsTitleBarSupport.systemMaterial(…)`
// is a static method, and `options.systemMaterial = …` is a field write on a value. The
// pattern excludes a preceding identifier character for exactly that reason, so a
// tree-wide assertion is about adopters of the attribute rather than about the name.
function componentMaterialCalls(sourceText) {
  return [...sourceText.matchAll(/(^|[^A-Za-z0-9_$.])\.systemMaterial\(/g)].length;
}

// Every `.ets` source in the entry module's `ets` tree. Some of these contracts
// are about the whole app and not about one file — "one window listener" is the
// clearest of them — and a component that breaks one lives anywhere in the tree.
// `generated/` is left out: it is emitted from the design tokens and carries no
// window code, so a match there would be a generator bug rather than this
// contract moving.
function etsSources(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'generated') {
        continue;
      }
      files.push(...etsSources(path.join(root, entry.name)));
    } else if (entry.name.endsWith('.ets')) {
      files.push(path.join(root, entry.name));
    }
  }
  return files;
}

// The whole tree as `[relativePath, text]` pairs, with `/` separators so an
// expectation reads the same on every host.
function etsTree(relativeRoot) {
  const root = path.join(__dirname, '../..', relativeRoot);
  return etsSources(root).map((file) => [
    path.relative(root, file).split(path.sep).join('/'),
    fs.readFileSync(file, 'utf8')
  ]);
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

test('a window read that fails releases its listener and says so', () => {
  // The failure path used to hand back an empty release and zero every inset.
  // Two things followed, and neither was visible from anywhere else: the
  // listener registered one line above stayed on the window for the life of the
  // process — `InsetsBroadcast.close()` had nothing to call, so an app with no
  // mounted surface still held a window listener — and the shared broadcast was
  // pinned to zeroes, so every later avoid-area change re-threw inside the
  // system's own callback with nobody watching and the whole app laid itself out
  // against zero insets. That is the silent whole-app regression this test
  // exists to keep out: the failure has to be released and it has to be logged.
  const observe = windowService.slice(
    windowService.indexOf('static async observeInsets'),
    windowService.indexOf('private static avoidEdges'));
  assert.notEqual(observe.indexOf('} catch'), -1,
    'observeInsets must keep a failure path: a window that cannot answer is not a reason to stop the page rendering');
  const failure = normalize(observe.slice(observe.indexOf('} catch')));
  assert.match(failure, /(?:appWindow\.off\('avoidAreaChange'|detach\(\);)/,
    'the failure path must take the listener it registered back off the window, directly or through the shared ' +
    'release: leaving it registered outlives every unmount, and zeroing the broadcast pins the whole app to zero ' +
    'insets for the rest of the process');
  assert.match(failure, /RemoteLogger\.(?:error|warn)\(/,
    'the failure path must log: silently zeroing every inset is the whole-app regression this path used to cause');
  // The release the failure path calls has to be the one that really detaches,
  // and it has to be guarded by whether `on` registered at all: releasing blind
  // would detach a callback that was never ours.
  assert.match(normalize(windowService),
    /detach = \(\): void => \{ if \(!listening\) \{ return; \} listening = false; appWindow\.off\('avoidAreaChange', onAvoidAreaChange\); \};/,
    'the shared release must be the one place the window listener is taken off, and it must not fire when nothing was registered');
});

test('the whole app subscribes to the window once, not once per surface', () => {
  // One window, one avoid-area fact. Fourteen surfaces each opening their own
  // `getLastWindow` and their own listener meant fourteen subscriptions to the
  // same event and a window during which two surfaces disagreed about the strip
  // between them. There is one read and one listener left, and this is the
  // assertion that keeps a component from quietly growing its own again: the
  // per-component subscription is a regression, however convenient it looks.
  //
  // Counted over the whole `ets` tree, not over the service alone. Counting one
  // file only proved the service did not grow a second listener; a component
  // living in any other file could open one and nothing here would notice, which
  // is exactly the shape this contract exists to forbid.
  const tree = etsTree('entry/src/main/ets');
  const subscribingFiles = tree
    .filter(([, text]) => text.includes("on('avoidAreaChange'"))
    .map(([name]) => name);
  assert.deepEqual(subscribingFiles, ['services/WindowSystemBarService.ets'],
    'the window must be subscribed to from the shared service and nowhere else: any other file registering ' +
    '`avoidAreaChange` is a component holding its own window listener, which the app-wide release cannot reach ' +
    'and which disagrees with the shared numbers between reads');
  assert.equal(tree.reduce((count, [, text]) => count + occurrences(text, "on('avoidAreaChange'"), 0), 1,
    'the window must be subscribed to exactly once, by the shared broadcast: a second listener means a surface opened its own');
  assert.equal(tree.reduce((count, [, text]) => count + occurrences(text, "off('avoidAreaChange'"), 0), 1,
    'the window listener must be released from exactly one place, in the service that opened it: a release ' +
    'anywhere else means a component closed a listener it did not open');
  // `KeyboardReleaseService` is the tree's other window read and a deliberate
  // one: it dismisses the soft keyboard, it is not an inset source, and it opens
  // no avoid-area listener. The one counted here is the shared inset read above,
  // which is the app's only inset source.
  assert.equal(occurrences(windowService, 'window.getLastWindow('), 1,
    'only the shared inset read may ask the window service for insets');

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
  for (const primitive of ['leftPadding', 'rightPadding', 'bottomPadding', 'tailSpacing']) {
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
  // its camera onto that side. The two primitives are split by side because a
  // cutout only ever lands on one of them: a band reserves the side the device
  // claims and keeps its own gutter on the other.
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

test('the bands a layout dump has to read are named', () => {
  // The side strips are invisible in a screenshot. A layout dump is where they
  // can be measured, and a band with side padding shows up there only as the
  // offset between the band's own box and its first child — the box itself does
  // not move. So the bands that carry one are named for the dump, the way the
  // chat page's bottom fade already is: the chat page's top band, and the wide
  // home header band whose box is the window in one parent and the wide detail
  // pane in the other, which is the question its side padding turns on.
  //
  // The chat page's name sits on the box both of its bands are, not on either
  // band: the platform-owned one and the self-drawn one are the same box, and two
  // nodes may not share one id. A dump reads the same either way.
  const top = builderBody(conversationView, 'TopOverlay');
  assert.equal(call(top, 'id'), ".id('conversation-top-band')",
    'the chat page top band must stay named so a dump can read its box against its first child');
  assert.equal(occurrences(conversationView, ".id('conversation-top-band')"), 1,
    'the top band has one box: a second node claiming the name makes the dump ambiguous');
  assert.match(normalize(remoteSurfaceHost), /\.id\('remote-wide-home-band'\)/,
    'the wide home header band must stay named: whether its box is the window or the detail pane is ' +
    'exactly what decides whether its side padding clears a cutout or only indents its content');
  assert.equal(call(builderBody(conversationView, 'BottomOverlay'), 'id'), ".id('conversation-bottom-fade')",
    'the chat page bottom fade must stay named');
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

test('the compact conversation hands its top band to the platform, and paints none of its own', () => {
  // The shell is still immersive, so the app's top edge is still the window's —
  // but on the compact conversation it is the *destination's* band now, not the
  // page's. `titleBar` overlays the content, so what the page keeps is the band's
  // box: its measured height, which is the transcript's content start offset, and
  // the window's side strips, because the band is still the window's full width
  // and the header's own gutter lives inside it.
  //
  // What it may not keep is a fill or a blur. A page band painting the overlay
  // colour and blurring behind a bar that has its own material is the second
  // glass over the first, which is what the plan forbids outright: the platform's
  // gradient blur is the compensating mechanism, and it needs the transcript to
  // run *under* the band rather than below it.
  const platform = builderBody(conversationView, 'PlatformTopBand');
  assert.equal(call(platform, 'padding'),
    '.padding({ left: this.insets.leftPadding(0), right: this.insets.rightPadding(0), top: this.topBandOffset() })',
    'the platform-owned band still reserves the window\'s side strips, and its top padding is the bar\'s height');
  assert.equal(platform.includes('backgroundColor('), false,
    'the platform-owned band must paint no fill of its own: a second fill under the bar is glass over glass');
  assert.equal(platform.includes('backgroundBlurStyle'), false,
    'the platform-owned band must not blur: the bar\'s own material would be blurring a blur');
  assert.equal(platform.includes('TopEdgeFade'), false,
    'the platform-owned band must not carry the self-drawn edge fade: the bar\'s gradient blur is that edge');
  assert.match(normalize(platform), /this\.Header\(\) this\.Mailbox\(\)/,
    'the platform-owned band is still where the rename row and the mailbox live');
  // The offset it reserves is the platform bar's own height *plus the system strip
  // the bar covers*, read from the policy and from the shared binding rather than
  // restated here: the page cannot measure a bar it does not draw, and the app has
  // one measurement point for the strip.
  assert.match(normalize(conversationView),
    /private topBandOffset\(\): number \{ return this\.platformBar \? HdsTitleBarPolicy\.reservedBandHeight\(HdsTitleBarScene\.Conversation, this\.topSafeInset\) : this\.topSafeInset; \}/,
    'the band\'s top offset must be the platform bar plus the strip it covers, from the policy and the binding');

  // The band clears the status bar on the platform's side, which is the defect this
  // pair exists for: an immersive window draws the platform band from the top of the
  // window, so without it the title, the back control and the menu sit on the clock
  // and the indicators. Both halves are asserted together because either one alone
  // leaves the band in the status bar: the platform moves the band below the strip,
  // and the reserved offset is what keeps this pane's rename row below the band.
  const options = staticBody(hdsTitleBarSupport, 'static options(');
  assert.match(normalize(options), /avoidLayoutSafeArea: true,/,
    'the platform band must be told to avoid the safe area: an immersive window draws it from the top of the ' +
    'window, so its title and controls otherwise land in the status bar');
  assert.equal(normalize(options).includes('enableComponentSafeArea'),
    false,
    'the band must not be asked to absorb the strip as a component-level safe area: that option was measured ' +
    'inert in this window (the band\'s content stayed on the strip), so relying on it is how the defect returns');
  // The flag is not device-gated, so it may be unconditional: it starts at 6.0.0(20)
  // and the app's compatibleSdkVersion is 6.0.1(21). A gate here would be a second
  // tier table for something every supported device can name.
  const buildProfile = source('build-profile.json5');
  const compatible = /"compatibleSdkVersion"\s*:\s*"[^"]*\((\d+)\)"/.exec(buildProfile);
  assert.notEqual(compatible, null,
    'the root project must state the API level it is compatible with, in the SDK version\'s own `6.0.1(21)` form');
  assert.ok(Number(compatible[1]) >= 20,
    `enableComponentSafeArea starts at 6.0.0(20) and the app is compatible with API ${compatible[1]}: below that ` +
    'floor the field would need the same gate the 23+ members have');

  // The two bands are one branch each, and the self-drawn one is where the page's
  // own glass lives — the wide pane and the design preview draw it, and neither is a
  // `Navigation` destination.
  assert.match(normalize(conversationView),
    /if \(this\.platformBar\) \{ this\.PlatformTopBand\(\) \} else \{ this\.SelfDrawnTopBand\(\) \}/,
    'the band the page draws must be selected by who owns the chrome, not by a second condition');
  const selfDrawn = builderBody(conversationView, 'SelfDrawnTopBand');
  assert.equal(call(selfDrawn, 'padding'),
    '.padding({ left: this.insets.leftPadding(0), right: this.insets.rightPadding(0), top: this.topSafeInset })',
    'the self-drawn band is the one that reserves the status bar itself, because it is the page\'s own top edge');
  // The wide band is a *content* surface rather than a navigation bar, so it is not a
  // destination's `titleBar`: the platform material never reaches it, and the band
  // paints its own glass. Every value still comes from the shared recipe.
  assert.equal(call(selfDrawn, 'backgroundColor'),
    '.backgroundColor(ImmersiveSurfaceSupport.surfaceFill(ImmersiveSurfaceScene.TOP_CHROME, PAGE_BG_OVERLAY))',
    'the wide band\'s floor is the top-chrome recipe\'s, with the page overlay colour as its fallback');
  assert.equal(call(selfDrawn, 'backgroundBlurStyle'),
    '.backgroundBlurStyle(ImmersiveSurfaceSupport.surfaceBlur(ImmersiveSurfaceScene.TOP_CHROME))',
    'the band\'s blur is the recipe\'s fallback blur');
  assert.equal(call(selfDrawn, 'border'),
    '.border(ImmersiveSurfaceSupport.surfaceHairline(ImmersiveSurfaceScene.TOP_CHROME, TOP_BAND_HAIRLINE_WIDTH))',
    'the band\'s own half-pixel bottom edge is drawn on every device');
  const chain = normalize(codeOf(selfDrawn));
  assert.equal(chain.includes('.systemMaterial('), false,
    'the wide band must not adopt the platform material: the platform does not draw it on a content surface, so ' +
    'the band would be left with no surface at all');
  assert.equal(chain.includes('systemMaterialEffect'), false,
    'the wide band must not name the platform band\'s field: that is the other channel, and one surface has one');
  assert.equal(chain.includes('.backgroundColor(PAGE_BG_OVERLAY)'), false,
    'the band may not paint the page overlay colour itself: the support answers it');
  assert.equal(/(^|[^a-zA-Z.])BlurStyle\./.test(chain), false,
    'the band may not name a BlurStyle: the recipe answers the blur');
  // And the destination is what carries the band: the session route hands the bar
  // its options, and every other destination keeps the page's own header.
  const destination = appRootPresentation.slice(
    appRootPresentation.indexOf('NavigationDestination(name: string) {'));
  assert.equal(occurrences(destination, '.titleBar('), 1,
    'exactly one destination draws the platform title bar');
  assert.match(normalize(destination),
    /if \(AppRouteContract\.isSessionRoute\(name as AppRoute\) && !this\.isWideLayout\(\)\) \{ HdsNavDestination\(\) \{ this\.RouteContent\(name as AppRoute\) \}/,
    'the bar belongs to the compact conversation route alone, and never to the wide composition');
  assert.match(normalize(destination),
    /\.titleBar\(HdsTitleBarSupport\.options\(this\.conversationTitleBarParams\(name as AppRoute\)\)\) \.hideBackButton\(false\)/,
    'the session route must hand its band to the production support class: a second options object here ' +
    'would be a second tier table');
  assert.match(normalize(destination),
    /\} else \{ HdsNavDestination\(\) \{ this\.RouteContent\(name as AppRoute\) \}\.hideTitleBar\(true\)/,
    'every other destination must keep `hideTitleBar(true)` and draw its own header');
});

test('the wide band paints its own glass, and no component surface names the material', () => {
  // The band used to carry the platform material on one of two branches. It carries
  // none now: measured on the API 26 emulator, the platform accepts a material on a
  // content surface and then draws nothing at all, so a band that adopted one had
  // given up its fill, its blur and its edge for an empty box. A content surface
  // paints its own glass and asks the shared recipe for every value of it.
  const band = builderBody(conversationView, 'SelfDrawnTopBand');
  assert.equal(call(band, 'backgroundColor'),
    '.backgroundColor(ImmersiveSurfaceSupport.surfaceFill(ImmersiveSurfaceScene.TOP_CHROME, PAGE_BG_OVERLAY))',
    'the wide band takes its floor from the top-chrome recipe, with PAGE_BG_OVERLAY as the colour it shipped with');
  assert.equal(call(band, 'backgroundBlurStyle'),
    '.backgroundBlurStyle(ImmersiveSurfaceSupport.surfaceBlur(ImmersiveSurfaceScene.TOP_CHROME))',
    'the wide band takes its blur from the top-chrome recipe rather than naming a BlurStyle');
  assert.equal(call(band, 'border'),
    '.border(ImmersiveSurfaceSupport.surfaceHairline(ImmersiveSurfaceScene.TOP_CHROME, TOP_BAND_HAIRLINE_WIDTH))',
    'the wide band asks the recipe for its own half-pixel bottom edge');
  for (const member of ['systemMaterial', 'systemMaterialEffect', 'usesMaterial']) {
    assert.equal(codeOf(band).includes(member), false,
      'the wide band must not name ' + member + ': the platform draws no material on a content surface, so a ' +
      'band that adopted one would paint nothing at all');
  }
  assert.equal(occurrences(normalize(codeOf(band)), 'this.TopBandContent()'), 1,
    'the band mounts its contents once: a second copy is the one that would go stale');
  assert.match(normalize(builderBody(conversationView, 'TopBandContent')),
    /this\.Header\(\) this\.Mailbox\(\)/,
    'the shared band contents are where the header and the mailbox live');

  // The whole tree, not just this band: no component surface adopts the shared
  // material anywhere. This is the count that makes the next adoption fail here
  // rather than on the one device nobody re-reads — and it is the reverse of the
  // branch this file used to require, because the platform draws no material on a
  // component, so an adopter loses a surface instead of gaining one.
  const adopters = etsTree('entry/src/main/ets')
    .filter(([, text]) => componentMaterialCalls(codeOf(text)) > 0)
    .map(([file]) => file)
    .sort();
  assert.deepEqual(adopters, [],
    'no file may call the component material attribute: the window shells answer it through their options, and a ' +
    'content surface that calls it gives up the glass it paints');
});

test('the option channels only name the material when there is one to name', () => {
  // The other way the material reaches a surface is an option object — a sheet, a popup,
  // a menu, a toast — and that channel is a field write on a value rather than a call on
  // a component, so it cannot crash a device below the attribute's floor. What it can do
  // is answer for a surface the platform is already drawing, which is a second material
  // on one box. Every merge method therefore returns the caller's options *before* it
  // names anything, and this is the guard those four have in common.
  const merges = ['static sheetOptions(', 'static popupOptions(', 'static menuOptions(', 'static toastOptions('];
  for (const signature of merges) {
    const body = staticBody(immersiveSurfaceSupport, signature);
    const guard = body.indexOf('material === undefined');
    const assignment = body.indexOf('.systemMaterial =');
    assert.notEqual(guard, -1,
      `${signature} must ask whether there is a material before it names one`);
    assert.notEqual(assignment, -1,
      `${signature} must still be the place the material is merged in`);
    assert.ok(guard < assignment,
      `${signature} must return the caller's options before it writes the material: a device with no material ` +
      'gets the surface it shipped, and the option object never carries the field');
    assert.ok(/return options;|return boundary;/.test(body.slice(guard, assignment)),
      `${signature} must return the caller's options unchanged on the path that has no material`);
  }
});

test('the bottom chrome paints its own glass on every device', () => {
  // What each control paints is not a choice made here: every fill, blur, edge and
  // shadow is asked of the bottom-chrome recipe, which is what keeps the pill and the
  // staging capsule one glass. The platform material is not part of that answer —
  // measured on the API 26 emulator, a component's material is accepted and not drawn,
  // so the control that adopted one was left with no surface of its own.
  const composerPill = composerPillChain();
  const rollbackCapsule = buildChainOf(rollbackStagingBar, 'RollbackStagingBar');

  const surfaces = [
    ['the composer pill', composerPill, 'CARD_OVERLAY'],
    ['the rollback capsule', rollbackCapsule, 'SOFT']
  ];
  for (const [name, slice, fallback] of surfaces) {
    assert.equal(call(slice, 'backgroundColor'),
      '.backgroundColor(ImmersiveSurfaceSupport.surfaceFill(ImmersiveSurfaceScene.BOTTOM_CHROME, ' + fallback + '))',
      name + ' must take its floor from the bottom-chrome recipe, with ' + fallback + ' as the fallback it shipped with');
    const chain = normalize(codeOf(slice));
    assert.equal(chain.includes('systemMaterial'), false,
      name + ' must not name the material attribute: the platform draws none on this surface, so adopting one is ' +
      'how the surface goes transparent');
    assert.equal(chain.includes('usesMaterial'), false,
      name + ' must not ask the material question: its glass does not depend on the device');
    assert.equal(chain.includes('systemMaterialEffect'), false,
      name + ' is a content surface: the platform band field belongs to the compact route alone');
    for (const literal of ["backgroundColor('#", 'MEDIA_BACKGROUND', 'MEDIA_SCRIM']) {
      assert.equal(codeOf(slice).includes(literal), false,
        name + ' must not name ' + literal + ': the bottom chrome is a theme-following surface whose floor comes ' +
        'from the recipe');
    }
  }

  // The pill's edge is the border it always drew: a capsule is an object with an
  // outline, and the outline is the pill's own rather than one a platform surface
  // would have drawn.
  assert.equal(call(composerPill, 'border'), '.border(this.composerEdge())',
    'the edge must be resolved in one place rather than written into the chain');
  assert.match(normalize(composerBar),
    /private composerEdge\(\): BorderOptions \{ return \{ width: this\.presentation === ComposerPresentation\.Compact \? 0\.5 : 1, color: LINE \}; \}/,
    'the pill keeps the border it shipped: the same width per presentation, in the same theme colour');
  assert.equal(call(composerPill, 'backgroundBlurStyle'),
    '.backgroundBlurStyle(ImmersiveSurfaceSupport.surfaceBlur(ImmersiveSurfaceScene.BOTTOM_CHROME))',
    'the pill paints the recipe blur rather than naming a thickness');
  assert.match(normalize(call(composerPill, 'shadow')),
    /^\.shadow\(ImmersiveSurfaceSupport\.surfaceShadow\(ImmersiveSurfaceScene\.BOTTOM_CHROME, \{ radius: this\.presentation === ComposerPresentation\.Floating \? 14 : 18, color: SHADOW_SUBTLE, offsetY: this\.presentation === ComposerPresentation\.Floating \? 4 : 6 \}\)\)$/,
    'the pill keeps its own shadow, offset by presentation');
  assert.equal(/(^|[^a-zA-Z.])BlurStyle\./.test(normalize(codeOf(composerPill))), false,
    'the pill may not name a BlurStyle: the recipe answers the blur');
  // The capsule's edge is the recipe hairline; the hairline's *geometry* — one bottom
  // edge, no sides — is held by immersive-surface-support.test.cjs.
  assert.equal(call(rollbackCapsule, 'border'),
    '.border(ImmersiveSurfaceSupport.surfaceHairline(ImmersiveSurfaceScene.BOTTOM_CHROME, ' +
    'ROLLBACK_BAR_HAIRLINE_WIDTH))',
    'the capsule asks the recipe for its own bottom hairline');

  // The layer the pill sits on is part of the same answer: the fade is what the glass
  // is made of, so every stop comes from the bottom-chrome recipe.
  const gradient = normalize(call(builderBody(conversationView, 'BottomOverlay'), 'linearGradient'));
  assert.match(gradient,
    /colors: \[\s*\[ImmersiveSurfaceSupport\.surfaceFill\(ImmersiveSurfaceScene\.BOTTOM_CHROME, PAGE_BG_FADE\), 0\.0\],\s*\[ImmersiveSurfaceSupport\.surfaceFill\(ImmersiveSurfaceScene\.BOTTOM_CHROME, PAGE_BG_OVERLAY\), 0\.45\],\s*\[ImmersiveSurfaceSupport\.surfaceFill\(ImmersiveSurfaceScene\.BOTTOM_CHROME, PAGE_BG_OVERLAY\), 1\.0\]\s*\]/,
    'every stop of the bottom fade must come from the bottom-chrome surface, and it must be the three stops the page shipped');
  assert.equal(occurrences(gradient, 'PAGE_BG_FADE'), 1,
    'the fade token may appear only as the fallback inside the surface answer');
  assert.equal(occurrences(gradient, 'PAGE_BG_OVERLAY'), 2,
    'the overlay token may appear only as the two fallbacks inside the surface answer');

  // The count is a set, not a number: no surface asks the bottom chrome for a material
  // any more, and the next one that does needs this file read again.
  const adopters = etsTree('entry/src/main/ets')
    .filter(([, text]) => text.includes('materialFor(ImmersiveSurfaceScene.BOTTOM_CHROME)'))
    .map(([file]) => file)
    .sort();
  assert.deepEqual(adopters, [],
    'no surface may adopt a bottom-chrome material: both capsules paint their own glass');
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
  // The file action form is a nested FIT_CONTENT sheet, and it is the card the
  // platform floats above the navigation bar rather than a surface that runs to
  // the screen edge: where the card sits is the platform's placement decision
  // now, so the form no longer reserves the strip itself. What it does own is
  // that its one action is the shared footer — the hand-drawn row it used to
  // carry is what the platform title bar and its close icon replaced, and the
  // close icon used to land on top of that row's Submit button.
  const actionForm = normalize(builderBody(workspaceToolsPanel, 'FileActionForm'));
  assert.match(actionForm, /SheetActionFooter\(\{ label: this\.fileActionTitle\(\), primary: true, isEnabled: this\.canSubmitFileAction\(\)/,
    'the form\'s one action must be the shared footer, named after the action it submits');
  assert.match(actionForm, /onAction: \(\) => this\.onIntent\(\{ type: 'file-action-submit' \}\)/,
    'the footer must submit the action the form is open for');
  assert.equal(actionForm.includes("RemoteI18n.t('common.cancel')"), false,
    'the form must not draw a Cancel button: the platform close icon is the cancellation, and a second one ' +
    'beside it is the row whose Submit the platform close icon covered');
  assert.equal(actionForm.includes('.backgroundColor(INK)'), false,
    'the submit button must not be hand-drawn inside the form: the shared footer owns that fill');
  assert.equal(actionForm.includes('file-action-cancel'), false,
    'the form must not carry its own cancel path: dismissals reach onWillDismiss at the host instead');
  assert.equal(actionForm.includes('bottomPadding'), false,
    'the form must not inset its own bottom edge: the platform floats this card above the bar');
  assert.match(normalize(workspaceToolsPanel),
    /private canSubmitFileAction\(\): boolean \{ return !this\.state\.busy && \(this\.state\.fileAction === 'delete' \|\| this\.state\.fileActionName\.trim\(\)\.length > 0\); \}/,
    'the action must stay locked while a submission is in flight and while the name is empty, except for the ' +
    'delete that already has its target');
  assert.match(actionForm,
    /\.padding\(\{ left: SHEET_HORIZONTAL_PADDING, right: SHEET_HORIZONTAL_PADDING, top: 20 \}\)/,
    'the form rows must keep the sheet contract\'s own gutter');
  // The sheet is the nested one, so its options are read here: the platform fits
  // the card to its content and translates the keyboard the name field raises in
  // whatever placement its host resolved — the bottom edge, or the middle of a
  // wide window — and a dismissal still ends the action.
  assert.match(normalize(workspaceToolsPanel),
    /private fileActionSheetOptions\(\): SheetOptions \{ const options: SheetOptions = AdaptiveSheetOptions\.form\( this\.fileActionPlacement, this\.fileActionTitle\(\) \); options\.onWillDismiss = \(action: DismissSheetAction\): void => \{ if \(!this\.state\.busy\) \{ this\.onIntent\(\{ type: 'file-action-cancel' \}\); action\.dismiss\(\); \} \}; return ImmersiveSurfaceSupport\.sheetOptions\(ImmersiveSurfaceScene\.MODAL_SHEET, options\); \}/,
    'the nested sheet must take the platform title bar\'s text, its host\'s placement, and keep ending its ' +
    'action on every dismissal');
  // The form is a sheet inside the panel's sheet, so it inherits the panel's
  // placement rather than deciding one: the shell resolves the panel's, and the
  // panel hands it down.
  assert.match(normalize(sidebarWorkspaceSection),
    /WorkspaceToolsPanel\(\{ state: this\.workspaceTools, onIntent: this\.onWorkspaceTools, fileActionPlacement: this\.workspaceToolsPlacement \}\)/,
    'the panel must hand its own placement to the form it opens');
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
  // The sidebar's section carries the tools sheet and the session details sheet
  // its rows' action menu opens: one carrier each, and the workspace picker keeps
  // the root chain's single sheet.
  const section = normalize(sidebarWorkspaceSection);
  assert.match(section,
    /Row\(\) \{\}\.height\(0\) \.bindSheet\(\$\$this\.workspaceTools\.visible, this\.WorkspaceTools\(\), this\.workspaceToolsSheetOptions\(\)\) Row\(\) \{\}\.height\(0\) \.bindSheet\(\$\$this\.showSessionDetails, this\.SessionDetailsSheet\(\), this\.sessionDetailsSheetOptions\(\)\)/,
    'the tools sheet and the rows\' details sheet must each bind on their own carrier node');
  assert.match(section,
    /\.margin\(\{ top: 10 \}\) \.bindSheet\(\$\$this\.showWorkspacePicker/,
    'the workspace picker must stay the root chain\'s only sheet');
});

test('the drawer\'s session rows reach the runtime through the host chain', () => {
  // The drawer's session rows had an entry point that led nowhere: the row raised
  // a session-actions event, no host in the production tree consumed it, and the
  // long press — the only way in — was a no-op. A chain like this one is what a
  // single unit test cannot see, because every link is a different file that its
  // neighbour can drop without any other test noticing, so the whole path is
  // pinned here: the row's two entry points and the popup they open, the surface
  // the section builds, the placement and the delete both hosts wire, and the
  // runtime member at the far end.
  const row = normalize(sidebarDeviceGroup);
  const section = normalize(sidebarWorkspaceSection);

  // The row contributes the intent and the anchor. The intent is the session, so
  // the host never has to look one up in a list it may not hold (a row of a
  // device that is not the active one has no entry there).
  assert.match(row,
    /LongPressGesture\(\{ repeat: false \}\)\.onAction\(\(\) => \{ this\.onOpenSessionActions\(this\.currentSession\(row\)\); \}\)/,
    'the long press must report the session its menu is about');
  assert.match(row, /\.onClick\(\(\) => this\.onOpenSessionActions\(this\.currentSession\(row\)\)\)/,
    'the row must also carry a visible entry point: a long press alone is undiscoverable');
  assert.match(row, /accessibilityText\(RemoteI18n\.t\('session\.actions'\)\)/,
    'the row\'s entry point must be labelled like the session list\'s');
  assert.match(row,
    /bindPopup\(this\.showActionMenu\(row\), ImmersiveSurfaceSupport\.popupOptions\(ImmersiveSurfaceScene\.FLOATING_MENU, \{ builder: \(\) => \{ this\.actionsPopup\(\) \}, placement: Placement\.Right/,
    'the row must anchor the menu on the floating-menu popup, so the bubble carries the material');
  assert.match(row, /onStateChange: \(event\) => \{ if \(!event\.isVisible\) \{ this\.onCloseSessionActions\(\); \} \}/,
    'every dismissal — an outside tap, a chosen action, an anchor that went away — must release the session');
  assert.match(row, /actionSessionKey: this\.actionSessionKey,/, 'the device group must forward the open key');
  assert.match(row, /onDeleteSession: this\.onDeleteSession,/, 'the device group must forward the delete');
  assert.match(row,
    /@Builder private SessionActionsPopup\(\) \{ this\.sessionActionsPopup\(\) \}/,
    'the device group must hand the section\'s surface on through a builder of its own');
  assert.match(row, /actionsPopup: \(\) => \{ this\.SessionActionsPopup\(\) \}/,
    'the pass-through must stay an arrow: a method reference arrives bound to the workspace group');

  // The section owns the surface: the shared policy's answer for a remote session,
  // in the popover presentation the row anchors, with the material the popup
  // bubble supplies instead of a card of its own.
  assert.match(section, /presentation: SessionActionPresentation\.Popover,/,
    'the menu must stay the anchored popover the row binds, not a sheet');
  assert.match(section,
    /immersiveMaterial: ImmersiveSurfaceSupport\.usesMaterial\(ImmersiveSurfaceScene\.FLOATING_MENU\)/,
    'the popover must adopt the floating-menu material the session list\'s rows adopt');
  assert.match(section,
    /canViewDetails: this\.actionCapabilities\(\)\.canViewDetails, canDelete: this\.actionCapabilities\(\)\.canDelete/,
    'the menu must offer what the session list offers for the same rows');
  assert.match(section,
    /return SessionActionPolicy\.resolve\(SessionActionScope\.Remote, this\.actionSession\.agentType, false\);/,
    'the capabilities must come from the shared policy, not from a second answer here');
  assert.match(section, /onViewDetails: \(\) => this\.openActionSessionDetails\(\),/,
    'the detail action must open the details sheet this section hosts');
  assert.match(section,
    /private deleteActionSession\(\): void \{ const session = this\.actionSession; this\.closeSessionActions\(\); this\.onDeleteSession\(session\); \}/,
    'the delete action must reset the menu and then report the session to the host');
  assert.match(section, /private closeSessionActions\(\): void \{ this\.actionSession = emptyRemoteSession\(\); \}/,
    'closing must release the session the menu was about');
  assert.match(section, /actionSessionKey: this\.actionSessionKey\(\),/, 'the section must pass the open key down');
  assert.match(section, /sessionActionsPopup: \(\) => \{ this\.SessionActionsPopup\(\) \},/,
    'the section must hand the rows the surface to render, as an arrow over its own builder');

  // Both hosts — the compact drawer and the wide master pane, which carry the same
  // rows — wire that event to the runtime action and place the details sheet.
  const hosts = [
    ['the compact drawer', appRootOverlaySurfaces],
    ['the wide master pane', wideConversationHost]
  ];
  for (const [name, text] of hosts) {
    assert.match(normalize(text), /sessionDetailsPlacement: this\.sessionDetailsPlacement,/,
      `${name} must hand the section the placement its details sheet lands in`);
    assert.match(normalize(text), /onDeleteSession: this\.actions\.onSidebar\.deleteSession,/,
      `${name} must wire the rows' delete to the sidebar action, not to the empty one`);
  }

  // The far end: the member each host names is implemented by the runtime, and the
  // empty actions a fixture mounts still answer it so every host compiles.
  const actions = normalize(runtimeComposition);
  const onSidebar = actions.slice(actions.indexOf('onSidebar: {'), actions.indexOf('onSettings: {'));
  assert.match(onSidebar,
    /deleteSession: \(session: RemoteSession\): void => \{ this\.conversationController\.deleteHomeSession\(session\); \}/,
    'the sidebar delete action must reach the runtime delete flow');
  assert.match(normalize(presentationActions), /openSession: \(\) => \{\}, deleteSession: \(\) => \{\}/,
    'the empty actions must keep answering the member');
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
  assert.equal(call(normalize(welcomeHome), 'expandSafeArea'),
    '.expandSafeArea([SafeAreaType.SYSTEM, SafeAreaType.CUTOUT], ' +
      '[SafeAreaEdge.START, SafeAreaEdge.END, SafeAreaEdge.BOTTOM])',
    'the dock fill must reach the screen edge on the sides as well as the bottom: `wide()` is a logical-width ' +
    'test and a side cutout is not, so a landscape window below 600vp, a split screen, a free window and a ' +
    'hover posture all leave this column sitting on the window\'s side edges with no side claim and a page-colour sliver beside its fill');
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
  //   home dock                   the bottom edge and both sides. The sides are
  //                               only load-bearing in one combination, but it
  //                               is a reachable one: the dock has a fill of its
  //                               own only in the compact composition, while a
  //                               side cutout exists in any landscape window —
  //                               including a sub-600vp one, a split screen, a
  //                               free window or a hover posture, where the dock
  //                               does sit on the window's side edges. In the
  //                               `wide()` composition the dock paints
  //                               TRANSPARENT, so the extra claim draws nothing.
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
      '[SafeAreaEdge.START, SafeAreaEdge.END, SafeAreaEdge.BOTTOM]']
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

test('every top band the status bar shows through is a theme-following page colour, or a material that answers for it', () => {
  // The window's status-bar content colour is one value for the whole window and
  // follows the colour mode alone (see `updateSystemBars` in EntryAbility): the
  // light ink on a light band, the dark ink on a dark one. That single value is
  // correct for every page shipped today for one reason only — every top band the
  // window shows through the transparent status bar is a theme-following page
  // colour, or a surface the platform's material answers for — and this test is
  // what turns that from a coincidence into a contract.
  //
  // Each entry names the band that owns the window's top edge and the semantic
  // colour it paints with, and then answers the one question this file cannot
  // measure: whether that band hands its fill to a material. A band that becomes
  // media chrome (`MEDIA_BACKGROUND` / `MEDIA_SCRIM`, dark in both appearances) or
  // a hard-coded colour puts the light-mode ink on a dark band, and the clock and
  // the status icons stop being readable against it.
  //
  // The overlay sheets are deliberately absent. They used to appear here — the
  // connect sheet's root was the one band allowed to hand its fill to the
  // immersive material — but a sheet's band is the platform's background now, and
  // a sheet content root that paints one is a second background over the sheet's
  // own (see the sheet-chrome tests below). The material column is what keeps
  // that from growing back silently: it is stated per row rather than left as a
  // comment, so the count below can actually fail — whether the clock stays
  // legible over a material is the platform's answer, and this file can no longer
  // measure a colour it does not paint.
  //
  // The compact conversation's own band is the platform's now (see the title bar
  // tests below), which is why its row names the box the page still owns and
  // carries no colour of its own: a token of `null` is that answer.
  //
  // The wide band is the one row whose fill does not come from a bare token: it asks
  // the top-chrome recipe for its floor, which is what keeps the band's glass and the
  // band's blur from being two different answers. That is why it is the one row marked
  // as taking its floor from the shared recipe, and why the token still has to be
  // stated — it is what the band paints, on every device.
  const bands = [
    ['the drawer panel', builderBody(appSidebar, 'SidebarContent'), 'SIDEBAR_BG', false],
    ['the wide chat page top band', builderBody(conversationView, 'SelfDrawnTopBand'), 'PAGE_BG_OVERLAY', true],
    ['the chat page platform band', builderBody(conversationView, 'PlatformTopBand'), null, false],
    ['the gallery root', buildChain(miniAppSurface), 'PAGE_BG', false],
    ['the file preview root', buildChain(filePreviewSurface), 'PAGE_BG', false],
    ['the compact home root', builderBody(remoteSurfaceHost, 'CompactHomeContent'), 'PAGE_BG', false],
    ['the wide home root', builderBody(remoteSurfaceHost, 'FlowPlaceholder'), 'PAGE_BG', false],
    ['the wide home pane', builderBody(wideConversationHost, 'RemoteHomeContent'), 'PAGE_BG', false],
    ['the wide home detail', builderBody(wideConversationHost, 'RemoteHomeDetail'), 'PAGE_BG', false],
    ['the wide chat pane', builderBody(wideConversationHost, 'RemoteChatContent'), 'PAGE_BG', false],
    ['the welcome page', buildChain(welcomeHome), 'WELCOME_PAGE_BG', false]
  ];
  const unreadable = 'the status bar icons are drawn in the colour-mode ink, so a top band that is dark in ' +
    'that same appearance makes them unreadable: handle the band and the system bar content colour together ' +
    '(see `updateSystemBars` in EntryAbility) instead of repainting the band on its own';
  // The guard is only a guard while every row states its floor answer, so the column is
  // asserted before it is counted: a row that drops the column is a row whose band
  // nobody has answered for.
  for (const [name, , , shared] of bands) {
    assert.equal(typeof shared, 'boolean',
      `${name} must state whether its band takes its floor from the shared recipe rather than a bare token: ` +
      'that column is the one this test cannot read off the source, so it has to be answered here');
  }
  // Exactly one band takes its floor from the shared recipe, and it is the wide chat
  // page's own top band. The count is a set, not a number: a second row marked true is
  // a band whose colour this test can no longer read, and a missing row is the wide
  // band quietly going back to a fixed fill.
  assert.deepEqual(bands.filter((band) => band[3] === true).map((band) => band[0]),
    ['the wide chat page top band'],
    'the wide chat page top band is the one band whose floor comes from the shared recipe: every other top ' +
    'band paints the theme-following colour its row names, in every appearance');
  for (const [name, slice, token, shared] of bands) {
    if (token === null) {
      // The platform owns this band's paint, so the tooth is the reverse one: the
      // page may not add a fill or a blur over the platform's own material.
      assert.equal(slice.includes('backgroundColor('), false,
        `${name} is the platform's band: the page may not paint a fill under it`);
      assert.equal(slice.includes('backgroundBlurStyle'), false,
        `${name} is the platform's band: the page may not blur behind its material`);
    } else if (shared) {
      // The band asks the support for its floor and its blur, and the support answers
      // the recipe's own values on every device — the platform draws no material on a
      // content surface, so the band must paint its own glass and name no material.
      assert.equal(call(slice, 'backgroundColor'),
        `.backgroundColor(ImmersiveSurfaceSupport.surfaceFill(ImmersiveSurfaceScene.TOP_CHROME, ${token}))`,
        `${name} must take its floor from the shared recipe, with ${token} as the colour it shipped with`);
      assert.equal(codeOf(slice).includes('.systemMaterial('), false,
        `${name} must not adopt a material: the platform draws none on a content surface, so the band would ` +
        'be left with no floor, no blur and no edge at all');
      assert.equal(codeOf(slice).includes('systemMaterialEffect'), false,
        `${name} is a content surface: the platform band's field is the other channel and belongs to the ` +
        'compact route alone');
    } else {
      assert.match(normalize(slice), new RegExp(`\\.backgroundColor\\(${token}\\)`),
        `${name} must paint its top band with the theme-following ${token}`);
    }
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

test('the platform draws the sheet chrome, and the shared options answer none of it', () => {
  // A sheet's title bar, its close icon, its background and its scrim are the
  // platform's, and `AdaptiveSheetOptions` is where that decision lives. It used
  // to answer all four itself — a transparent sheet whose content then had to
  // paint the fill, a hand-drawn close icon beside the platform's, the app's own
  // scrim over the page — and every answer was one more way for a sheet to stop
  // looking like a sheet. What is left is geometry plus the title bar's text.
  const adaptive = normalize(adaptiveSheetOptions);
  assert.deepEqual(chromeOptionsAnsweredIn(adaptiveSheetOptions), [],
    'the shared options must answer none of the platform\'s chrome: every override here was a sheet that ' +
    'stopped looking like one');
  // The title is the one thing a call site has to supply, because only the call
  // site knows what the sheet is; it reaches the platform as `SheetTitleOptions`,
  // with a second line where the header it replaces carried one.
  assert.match(adaptive,
    /const sheetTitle: SheetTitleOptions = subtitle === undefined \? \{ title: title \} : \{ title: title, subtitle: subtitle \};/,
    'the title must reach the platform as SheetTitleOptions, subtitle included');
  assert.match(adaptive, /options\.title = sheetTitle;/,
    'the title has to land on the sheet options');
  for (const [name, signature] of [
    ['fromPlacement', /static fromPlacement\(\n    placement: SettingsPlacement,\n    title\?: ResourceStr,\n    subtitle\?: ResourceStr\n  \): SheetOptions \{/],
    ['form', /static form\(\n    placement: SettingsPlacement,\n    title\?: ResourceStr,\n    subtitle\?: ResourceStr\n  \): SheetOptions \{/]
  ]) {
    assert.match(adaptiveSheetOptions, signature,
      `${name} must keep its geometry parameters and take the title bar's two lines`);
  }

  // `fromPlacement` is the generic path: the placement's mode is the only thing
  // that picks a sheet type, and the placement's own geometry is the only height
  // and width it states. A bottom placement is the fallback the other two modes
  // are carved out of, so a window that resolved no centred or side placement
  // keeps the band at the bottom edge.
  assert.match(adaptive,
    /static fromPlacement\( placement: SettingsPlacement, title\?: ResourceStr, subtitle\?: ResourceStr \): SheetOptions \{ const options: SheetOptions = \{ keyboardAvoidMode: SheetKeyboardAvoidMode\.RESIZE_ONLY \}; if \(placement\.mode === SettingsPlacementMode\.FoldOperate\) \{ options\.height = placement\.height; return AdaptiveSheetOptions\.withTitle\(options, title, subtitle\); \} if \(placement\.mode === SettingsPlacementMode\.Side\) \{ options\.height = placement\.height; options\.width = placement\.width; options\.preferType = SheetType\.SIDE; return AdaptiveSheetOptions\.withTitle\(options, title, subtitle\); \} if \(placement\.mode === SettingsPlacementMode\.Center\) \{ options\.height = placement\.height; options\.width = placement\.width; options\.preferType = SheetType\.CENTER; return AdaptiveSheetOptions\.withTitle\(options, title, subtitle\); \} options\.height = placement\.height > 0 \? placement\.height : SheetSize\.LARGE; return AdaptiveSheetOptions\.withTitle\(options, title, subtitle\); \}/,
    'the shared placement builder must take its type and its geometry from the resolved placement: the ' +
    'centred dialog and the side panel are the same call site answering a different window');

  // The `form` builder is the nested one, and it answers less than that: the
  // platform fits the card to the rows the form holds, and the keyboard is
  // translated as well as resized because those rows end in the name field the
  // keyboard is open for — only the placement's *position* is left to decide, so
  // only a centred placement names a type. A bottom sheet that claimed FIT_CONTENT
  // would keep the fit and gain no type, which is why the two are asserted
  // together: the fit height, the translate-and-resize keyboard, and the centred
  // type as the one branch.
  assert.match(adaptive,
    /static form\( placement: SettingsPlacement, title\?: ResourceStr, subtitle\?: ResourceStr \): SheetOptions \{ const options: SheetOptions = \{ height: SheetSize\.FIT_CONTENT, keyboardAvoidMode: SheetKeyboardAvoidMode\.TRANSLATE_AND_RESIZE \}; if \(placement\.mode === SettingsPlacementMode\.Center\) \{ options\.width = placement\.width; options\.preferType = SheetType\.CENTER; \} return AdaptiveSheetOptions\.withTitle\(options, title, subtitle\); \}/,
    'the nested form must keep the platform-fit height, its translated keyboard and its resolved placement');
  // The action sheet's own geometry is gone: it used to be a fixed 300vp band
  // decided at the call site, which is exactly the phone answer a wide window
  // should not get. Its height now arrives as `SESSION_ACTION_HEIGHT` through the
  // host's placement, and the builder may not hold a second copy of it.
  assert.doesNotMatch(adaptive, /fixedHeight|height: number|SheetSize\.MEDIUM/,
    'the shared builders may not hold a sheet\'s height of their own: it arrives with the placement');

  // And no call site may put the chrome answers back. `backgroundColor` is not in
  // this list because content legitimately paints fills — what may not happen is a
  // *sheet* answering it, which the roots test below covers one sheet at a time.
  const tree = etsTree('entry/src/main/ets');
  for (const override of ['maskColor', 'showClose', 'dragBar']) {
    const files = tree
      .filter(([, text]) => new RegExp(`\\b${override}\\s*[:=]`).test(normalize(text)))
      .map(([name]) => name);
    assert.deepEqual(files, [],
      `no sheet may answer \`${override}\` any more: it is the platform's own chrome`);
  }
});

test('every sheet in the tree is a host this contract knows and names', () => {
  // The list is the count guard: a new `bindSheet` host is a surface whose title,
  // whose background and whose dismissal all have to be decided, and the cheapest
  // way to forget that is to add one somewhere convenient. The file action form
  // inside the workspace tools sheet (`WorkspaceToolsPanel`) is a host of its own
  // and is listed for the same reason: it is a nested sheet over another sheet,
  // and it names itself and closes itself the way every other host here does.
  const tree = etsTree('entry/src/main/ets');
  const hosts = tree.filter(([, text]) => text.includes('.bindSheet(')).map(([name]) => name).sort();
  assert.deepEqual(hosts, [
    'pages/components/AppRootPresentation.ets',
    'pages/components/AppShell.ets',
    'pages/components/ConversationView.ets',
    'pages/components/RemoteSessionList.ets',
    'pages/components/SidebarWorkspaceSection.ets',
    'pages/components/WorkspaceToolsPanel.ets',
    'pages/preview/ImmersiveBottomPreview.ets'
  ], 'a new sheet host belongs in this list, with its platform title decided');
});

test('the sheet name travels into the platform title bar through the catalog', () => {
  // The hand-drawn header used to say what each sheet was, in the app's own words
  // and its own layout. Removing it without moving that text into the platform
  // title bar would leave the sheets anonymous, so every host names its sheet
  // here — through `RemoteI18n`, never as a literal, and in both catalogs.
  const named = [
    ['the settings sheet', appShell,
      "AdaptiveSheetOptions.fromPlacement( this.settingsPlacement, RemoteI18n.t('settings.title') )"],
    ['the connect sheet', appShell,
      "AdaptiveSheetOptions.fromPlacement( this.connectPlacement, RemoteI18n.t('connect.chooseConnectionTitle') )"],
    ['the remote view settings sheet', appRootPresentation,
      "AdaptiveSheetOptions.fromPlacement( this.remoteViewSettingsPlacement, RemoteI18n.t('viewSettings.title'), RemoteI18n.t('viewSettings.subtitle') )"],
    ['the full-text sheet', conversationView,
      "AdaptiveSheetOptions.fromPlacement(this.fullTextSheetPlacement, RemoteI18n.t('chat.fullText'))"],
    ['the session action sheet', remoteSessionList,
      "AdaptiveSheetOptions.fromPlacement( SettingsPlacementPolicy.hostedOverlay( this.sessionDetailsPlacement, SettingsPlacementPolicy.SESSION_ACTION_HEIGHT ), RemoteI18n.t('session.actions'), this.actionSessionTitle() || RemoteI18n.t('sidebar.untitled') )"],
    ['the session details sheet', remoteSessionList,
      "AdaptiveSheetOptions.fromPlacement( this.sessionDetailsPlacement, RemoteI18n.t('session.details'), this.detailsSession().title || RemoteI18n.t('sidebar.untitled') )"],
    ['the workspace tools sheet', sidebarWorkspaceSection,
      "title: { title: RemoteI18n.t('workspaceTools.title') }"],
    ['the workspace picker sheet', sidebarWorkspaceSection,
      "AdaptiveSheetOptions.fromPlacement( this.workspacePickerPlacement, RemoteI18n.t('sidebar.selectWorkspace'), this.workspacePickerSubtitle() )"],
    ['the drawer session details sheet', sidebarWorkspaceSection,
      "AdaptiveSheetOptions.fromPlacement( this.sessionDetailsPlacement, RemoteI18n.t('session.details'), this.detailsSession.title || RemoteI18n.t('sidebar.untitled') )"],
    ['the view settings preview', source('entry/src/main/ets/pages/preview/ImmersiveBottomPreview.ets'),
      "AdaptiveSheetOptions.fromPlacement( this.viewSettingsPlacement, RemoteI18n.t('viewSettings.title'), RemoteI18n.t('viewSettings.subtitle'))"],
    ['the nested file action form', workspaceToolsPanel,
      'AdaptiveSheetOptions.form( this.fileActionPlacement, this.fileActionTitle() )']
  ];
  for (const [name, text, snippet] of named) {
    assert.ok(normalize(text).includes(snippet),
      `${name} must hand its name to the platform title bar: the header that used to show it is gone`);
    for (const match of snippet.matchAll(/RemoteI18n\.t\('([a-zA-Z0-9_.]+)'\)/g)) {
      const resourceName = match[1].replace(/\./g, '_');
      assert.ok(enUsResourceNames.has(resourceName),
        `${name}: ${match[1]} must be a catalog entry, not a literal (en_US/${resourceName} is missing)`);
      assert.ok(zhCnResourceNames.has(resourceName),
        `${name}: ${match[1]} must be in the Chinese catalog too: the two stay in key lockstep`);
    }
  }
});

test('the nested file action form names its sheet from the catalog too', () => {
  // The form's name is not one string: it is whichever action the form is open
  // for, so what the platform title bar receives is that resolver's answer. Every
  // branch therefore has to be a catalog key in both locales — a literal here
  // would put an untranslated action name in the system bar, and the system bar
  // is now the only place the action is named — and the action set itself is
  // pinned, because a branch that disappears is a file action that lost its name
  // (the drawer's own buttons and its file menu read the same keys).
  const resolver = normalize(workspaceToolsPanel.slice(
    workspaceToolsPanel.indexOf('private fileActionTitle()'),
    workspaceToolsPanel.indexOf('private canSubmitFileAction()')));
  const keys = [...resolver.matchAll(/RemoteI18n\.t\('([a-zA-Z0-9_.]+)'\)/g)].map((match) => match[1]);
  assert.deepEqual(keys, [
    'workspaceTools.newFile',
    'workspaceTools.mkdir',
    'workspaceTools.rename',
    'workspaceTools.upload',
    'workspaceTools.confirmDelete'
  ], 'the form must name every action it can be opened for, through the catalog');
  for (const key of keys) {
    const resourceName = key.replace(/\./g, '_');
    assert.ok(enUsResourceNames.has(resourceName),
      `${key} must be a catalog entry, not a literal (en_US/${resourceName} is missing)`);
    assert.ok(zhCnResourceNames.has(resourceName),
      `${key} must be in the Chinese catalog too: the two stay in key lockstep`);
  }
  // And the resolver's answer is what the platform title bar shows: the sheet's
  // options are the only place the action is named now that its row is gone.
  assert.match(normalize(workspaceToolsPanel),
    /AdaptiveSheetOptions\.form\( this\.fileActionPlacement, this\.fileActionTitle\(\) \)/,
    'the nested form must hand the action\'s name to the platform title bar, in its host\'s placement');
});

test('the migrated sheet roots paint no background and no heading of their own', () => {
  // The platform sheet's background is the band every one of these surfaces sits
  // on, and the platform title bar is the heading above them. A root that paints
  // its own fill is a second background over the sheet's — on the material path
  // it covers the material the sheet just adopted, and on the fallback path it
  // puts the app's page colour inside a system sheet. The rule per surface is
  // "the material switch, the header and the close icon are gone", and for the
  // roots whose builder paints nothing at all it is the stronger "no fill in the
  // builder", which is what keeps one from growing back.
  const roots = [
    // name, component source, its struct name, and whether its own builder paints
    // any fill at all today (a control's fill is content, not a root band).
    ['the connect sheet', connectView, 'ConnectView', true],
    ['the connect sheet\'s account step', connectAccountDevicePage, 'ConnectAccountDevicePage', true],
    ['the settings sheet', settingsSheet, 'SettingsSheet', true],
    ['the remote view settings sheet', conversationViewSettings, 'ConversationViewSettings', true],
    ['the session details sheet', sessionDetailsView, 'SessionDetailsView', true],
    ['the full-text sheet', userMessageFullTextSheet, 'UserMessageFullTextSheet', true],
    ['the workspace picker sheet', workspacePicker, 'SidebarWorkspacePicker', false],
    ['the workspace tools sheet', workspaceToolsPanel, 'WorkspaceToolsPanel', false]
  ];
  for (const [name, text, structName, paintsNothing] of roots) {
    assert.equal(text.includes('immersiveMaterial'), false,
      `${name} must not switch a fill of its own on the material: the material belongs to the sheet container, ` +
      'and this content root must let it through');
    const root = normalize(buildChainOf(text, structName));
    assert.equal(root.includes('SheetCloseHeader('), false,
      `${name} must not draw a header: the platform title bar is the heading`);
    assert.equal(root.includes('SheetCloseButton('), false,
      `${name} must not draw a close icon: the platform title bar has one`);
    if (paintsNothing) {
      assert.equal(root.includes('.backgroundColor('), false,
        `${name} must not paint a background: the sheet the platform presents is the band, and a root fill ` +
        'is a second one over it (over the material on the material path)');
    }
  }

  // The two roots that are not fill-free paint controls, not bands — so what is
  // pinned here is the band each one used to paint: the picker's fixed confirm
  // row and its workspace rows, and the tools panel's own fill and its form's.
  const pickerRoot = normalize(buildChainOf(workspacePicker, 'SidebarWorkspacePicker'));
  assert.equal(pickerRoot.includes('.backgroundColor(PAGE_BG)'), false,
    'the picker must not paint a page band: its confirm row and its rows sit on the sheet the platform presents');
  assert.match(normalize(workspacePicker),
    /\.backgroundColor\(this\.isSelected\(this\.currentWorkspace\(row\)\) \? SOFT : TRANSPARENT\)/,
    'an unselected workspace row must show the sheet through, with the selected one keeping its highlight');
  assert.equal(normalize(buildChainOf(workspaceToolsPanel, 'WorkspaceToolsPanel')).includes('immersiveMaterial'), false,
    'the tools panel must not paint a fill of its own: the file action form it holds is the same surface');

  // The action sheet shares its component with the row's action popover, so the
  // split is inside that component: the popover keeps the card it is anchored
  // with, the sheet presentation paints nothing over the platform's sheet.
  const actionSurface = normalize(sessionActionSurface);
  assert.match(actionSurface, /\.backgroundColor\(this\.paintsOwnCard\(\) \? this\.cardFill\(\) : TRANSPARENT\)/,
    'the action surface must paint its card only where no sheet presents it');
  assert.match(actionSurface, /return this\.presentation === SessionActionPresentation\.Popover;/,
    'the popover must stay the presentation that owns its card');
  assert.equal(actionSurface.includes('SheetCloseHeader('), false,
    'the action surface waits for its close on the platform title bar in the sheet presentation');

  // The two fills left in the tree that switch on a material are the two anchored
  // surfaces no sheet presents: the harness-profile menu and the action popover.
  // A third is a sheet content root that went back to painting its own fill.
  const tree = etsTree('entry/src/main/ets');
  const selfPainted = tree
    .filter(([, text]) => text.includes('immersiveMaterial ? TRANSPARENT :'))
    .map(([name]) => name).sort();
  assert.deepEqual(selfPainted, [
    'pages/components/HarnessProfileMenu.ets',
    'pages/components/SessionActionSurface.ets'
  ], 'the only surfaces that still switch their own fill on the material are the ones no sheet presents');
});

test('the connect sheet fills its content area and names itself once', () => {
  // Two things the connect sheet got wrong once the platform took its chrome, and
  // both were the old hand-drawn header's leftovers.
  //
  // The heading: the platform title bar says `connect.chooseConnectionTitle`, and
  // the page drew the same key again under it. The key may appear wherever the
  // sheet options are assembled; it may not appear in the content.
  assert.equal(normalize(connectView).includes("RemoteI18n.t('connect.chooseConnectionTitle')"), false,
    'the connect content must not draw the heading the platform title bar already shows: it is the same key');
  assert.match(normalize(appShell),
    /AdaptiveSheetOptions\.fromPlacement\( this\.connectPlacement, RemoteI18n\.t\('connect\.chooseConnectionTitle'\) \);/,
    'the connect sheet must keep its name on the platform title bar');

  // The fill: the hero was a 36vp-rounded card standing in for the sheet's own
  // top corners, which the platform draws now — a rounded band under a square
  // title bar is a card inside a card, with the radius showing as a notch. It is
  // a full-bleed band instead, anchored to the content area's own top edge, and
  // the old negative margin that pulled the content up over it is gone with it.
  const hero = normalize(builderBody(connectView, 'HeroWash'));
  assert.match(hero, /\.width\('100%'\) \.height\(CONNECT_HERO_HEIGHT\) \.backgroundColor\(CONNECT_HERO_BG\) \.clip\(true\)/,
    'the hero must be a full-bleed band the sheet\'s own background shows through under');
  assert.equal(hero.includes('borderRadius(36)'), false,
    'the hero must not round its own top corners: the platform sheet\'s corners are the ones on screen');
  assert.equal(hero.includes('.position({ x: 112'), false,
    'the wash must not be anchored to x offsets measured on one window: the sheet is a clamped dialog on a ' +
    'tablet and the full width on a phone, so its blobs hang off its edges instead');
  const intro = normalize(builderBody(connectView, 'IntroPairingPage'));
  assert.equal(intro.includes('margin({ top: -'), false,
    'the content must not be pulled up under the hero: the band owns the top of the page now');
  assert.match(intro, /this\.HeroWash\(\)/,
    'the intro step must open with the hero band, flush with the content area\'s top edge');

  // And the way out: the sheet closes through the platform chrome alone. A header
  // control that dismissed it was a second close icon beside the title bar's, and
  // it is gone from both steps, from the events they expose, and from the action
  // contract that carried it.
  for (const [name, text] of [['the connect sheet', connectView],
    ['the connect sheet\'s account step', connectAccountDevicePage]]) {
    assert.equal(text.includes('NavigationBackButton'), false,
      `${name} must not draw a return key: the platform title bar closes the sheet`);
    assert.equal(text.includes('onBack'), false,
      `${name} must not expose a dismissal event of its own`);
  }
  assert.equal(presentationActions.includes('readonly back: () => void;'), false,
    'the connect action contract must not carry the dismissal the platform chrome performs');
  assert.equal(normalize(presentationActions).includes('onConnect: { back: () => {}'), false,
    'the empty connect actions must not carry it either');
  assert.equal(runtimeComposition.includes('onConnect: {\n      back:'), false,
    'no runtime connect action may dismiss the sheet: that is the platform title bar\'s, the scrim\'s and the ' +
    'swipe\'s, and all three reach the sheet options');
  const tree = etsTree('entry/src/main/ets');
  assert.deepEqual(
    tree.filter(([, text]) => text.includes('onConnect.back')).map(([name]) => name),
    [],
    'nothing may call a connect dismissal action any more');
  // What all three of those dismissal paths land on, so the state still resets
  // however the sheet was left: the settings sheet's own pattern.
  assert.match(normalize(appShell),
    /options\.onWillDismiss = \(action: DismissSheetAction\): void => \{ this\.shellState\.showConnectSheet = false; action\.dismiss\(\); \};/,
    'the connect sheet must reset its state on every interactive dismissal');
});

test('the signed-in connect step has a preview scenario that mounts it', () => {
  // The account device list is the connect sheet's other step, and it only mounts
  // when the fixture seeds an account: a scenario that opens the sheet with an
  // empty account id lands on the intro page instead and silently stops covering
  // it. Both halves are pinned here — the sheet has to open, and the seed has to
  // be authenticated — so a future edit cannot quietly turn this back into the
  // intro page's scenario.
  const preview = source('entry/src/main/ets/pages/preview/ImmersiveBottomPreview.ets');
  const normalized = normalize(preview);
  assert.match(normalized,
    /this\.connectAuthed = scenarioId\.endsWith\('-connect-authed'\);/,
    'the preview must recognise the signed-in scenario by name');
  assert.match(normalized,
    /this\.shellState\.showConnectSheet = this\.connectAuthed \|\| scenarioId\.endsWith\('-connect'\);/,
    'the signed-in scenario must open the connect sheet: its id does not end in `-connect`');
  const seed = normalized.slice(normalized.indexOf('if (this.connectAuthed) {'));
  assert.match(seed,
    /this\.remotePageState\.setAccountUserId\('preview-user'\);/,
    'the signed-in scenario must seed an account id: an empty one routes the sheet to its intro page');
  assert.match(seed,
    /this\.previewActions = previewActionsWithDevices\(connectDevices\(\)\);/,
    'the signed-in scenario must mount the fixture\'s own devices, never the account service');
  // The device source itself: the connect sheet reads the same list the settings
  // panel does, and it is the fixture's — a preview may not call the service.
  assert.match(normalized,
    /onConnect: \{ openAccount: base\.onConnect\.openAccount, connect: base\.onConnect\.connect, clearPairing: base\.onConnect\.clearPairing, cloudListDevices: async \(\): Promise<CloudAccountDevice\[\]> => devices,/,
    'the connect action\'s device list must be the fixture\'s devices');
  // Three rows, so the step renders each state it has: the controlled desktop,
  // an offline one and an online idle one.
  const devices = preview.slice(preview.indexOf('function connectDevices()'),
    preview.indexOf('function sidebarWorkspaces()'));
  assert.equal((devices.match(/deviceId: '/g) || []).length, 3,
    'the fixture must offer exactly the three rows the step can show');
  assert.match(normalize(devices),
    /\{ deviceId: 'account-desktop-2', deviceName: 'Loft desktop', online: false, lastSeenAt: 1 \}/,
    'the fixture must keep an offline row: a device list with no offline device stops covering that state');
  assert.match(normalize(preview),
    /this\.remotePageState\.setControlTarget\('account_device', 'account-desktop-1', 'Studio desktop'\);/,
    'the fixture must keep a controlled desktop: the "controlling" row is one of the states under test');
  // And the ability opens it: the scenario has to be in the preview whitelist,
  // or `aa start` silently loads the real app instead of the fixture.
  assert.ok(entryAbility.includes("scenarioId === 'immersive-bottom-connect-authed'"),
    'the scenario must be registered in the ability\'s preview whitelist');
});

test('only the surfaces no sheet presents still draw their own header', () => {
  // The hand-drawn header is gone from every `bindSheet` surface, and this is the
  // list of what is left, with the reason each one keeps it:
  //
  //   LanguageSettingsPanel    the Settings sheet's own sub-page — its header
  //                            closes the *page* (back to the settings home), it
  //                            does not dismiss the sheet;
  //   OpenBitFunAccountLoginPage  the same component renders inside the compact
  //                            account content cover, where there is no platform
  //                            sheet chrome at all;
  //   ModelServiceSettingsPanel   the model-service panel, which no surface
  //                            mounts today.
  //
  // A new file here is a surface that went back to drawing sheet chrome, and a
  // `SheetCloseButton` outside the shared header is a second close icon.
  const tree = etsTree('entry/src/main/ets');
  const drawing = (needle) => tree.filter(([, text]) => text.includes(needle)).map(([name]) => name).sort();
  assert.deepEqual(drawing('SheetCloseHeader('), [
    'pages/components/LanguageSettingsPanel.ets',
    'pages/components/ModelServiceSettingsPanel.ets',
    'pages/components/OpenBitFunAccountLoginPage.ets'
  ], 'the hand-drawn header must stay on the surfaces no sheet presents, and nowhere else');
  assert.deepEqual(drawing('SheetCloseButton('), ['pages/components/SheetCloseHeader.ets'],
    'the shared header must stay the only consumer of the hand-drawn close button');
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

test('the binding and the broadcast keep the lifecycle branches their state depends on', () => {
  // Four single lines carry the whole "a surface only reads insets while it is
  // mounted, and the app only holds the window while a surface is" rule, and not
  // one of them is load-bearing for any other assertion in this file. Each
  // deletion breaks a different real path, so they are pinned by name.
  // The broadcast is declared above the binding in the file, so each is read
  // from its own declaration to the next one that follows it.
  const broadcast = normalize(windowService.slice(
    windowService.indexOf('class InsetsBroadcast'),
    windowService.indexOf('export class WindowInsetsBinding')));
  const binding = normalize(windowService.slice(windowService.indexOf('export class WindowInsetsBinding')));
  assert.match(binding, /unbind\(\): void \{ this\.disposed = true;/,
    'unbind must mark the binding disposed: without it the shared broadcast keeps writing later changes into a ' +
    'surface that is already gone and the dead surface relayouts on every avoid-area change');
  assert.match(binding,
    /const callback: WindowInsetListener = \(insets: WindowInsets\): void => \{ if \(this\.disposed\) \{ return; \}/,
    'the callback must keep its disposed guard: the broadcast delivers a change that can land across an unmount, ' +
    'and without the guard a surface that is no longer mounted is still written to');
  assert.match(binding,
    /const previous = this\.subscription; this\.subscription = sharedInsetsBroadcast\.subscribe\(context, callback\); if \(previous\) \{ previous\(\); \}/,
    'bind must release its previous registration: binding twice would leave the first callback on the shared ' +
    'subscription, so the surface is updated twice and the broadcast counts a subscriber that no longer exists');
  assert.match(broadcast, /private close\(\): void \{ this\.opened = false;/,
    'close must clear opened: left true, the broadcast believes it is still open, so after the last surface ' +
    'closes and a new one opens the window listener is never rebuilt and the insets never update again');
});

// The platform title bar's own contract.
//
// `HdsNavDestination.titleBar` starts at 5.1.0(18) and the app's
// compatibleSdkVersion is 6.0.1(21), so the band itself is available everywhere —
// but `ScrollEffectType.IMMERSIVE_GRADIENT_BLUR`, `systemMaterialEffect` and every
// `hdsMaterial` member start at 6.1.0(23), and a member that does not exist is not
// a value the platform can ignore. The tier table therefore lives in a pure policy,
// the two platform spellings live in one support class, and each of them sits
// behind a gate the assertions below read as an *order*: a gate that is a flag
// beside a member is the same bug as no gate at all.

// A source slice with its comments taken out, so an assertion reads what the file
// names rather than what it explains: every file here names the platform members
// in its comments, and only one of them may name them in code.
function codeOf(sourceText) {
  return sourceText.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

// One static method of a class, read from its own signature to its own closing
// brace: a method's body ends with a two-space `}`, which no nested block reaches,
// so an assertion is about this method rather than about the next one.
function staticBody(sourceText, signature) {
  const start = sourceText.indexOf(signature);
  assert.notEqual(start, -1, `${signature} must stay a member of its class`);
  const end = sourceText.indexOf('\n  }\n', start + signature.length);
  return sourceText.slice(start, end === -1 ? sourceText.length : end + 4);
}

test('the title bar\'s 23+ members are reachable only through the gate', () => {
  // The gate is a return *before* the member. Both of the support class's mapping
  // methods start with it, which is what makes the policy's own vocabulary the
  // only thing a caller can hand them: below API 23 the answer is the plain
  // gradient blur and no material at all.
  const gated = (slice, member, gate) => {
    const memberAt = slice.indexOf(member);
    assert.notEqual(memberAt, -1, `${member} must stay in the method that maps the decision`);
    const gateAt = slice.indexOf(gate);
    assert.notEqual(gateAt, -1, `the capability gate must stay in front of ${member}`);
    assert.ok(gateAt < memberAt, `${member} must be named after the gate, never before it`);
  };
  gated(staticBody(hdsTitleBarSupport, 'static scrollEffectType('),
    'ScrollEffectType.IMMERSIVE_GRADIENT_BLUR', 'if (!decision.immersiveBlur) {');
  // `systemMaterial` names no platform member itself: it answers with the gated
  // call into the two mappers that do, so the call is what the gate has to sit in
  // front of, and the mappers are reached from nowhere else.
  gated(staticBody(hdsTitleBarSupport, 'static systemMaterial('),
    'HdsTitleBarSupport.materialTypeFor(decision)', 'if (!decision.materialAttached) {');
  const classBody = codeOf(hdsTitleBarSupport).slice(
    codeOf(hdsTitleBarSupport).indexOf('export class HdsTitleBarSupport'));
  const materialGateAt = classBody.indexOf('if (!decision.materialAttached) {');
  for (const mapper of ['materialTypeFor', 'materialLevelFor']) {
    assert.equal(occurrences(classBody, `${mapper}(`), 2,
      `${mapper} must be declared once and called once: a second caller is a route around the gate`);
    const callAt = classBody.indexOf(`HdsTitleBarSupport.${mapper}(decision)`);
    assert.ok(callAt > classBody.indexOf('static systemMaterial('),
      `${mapper} must be called by the gated answer`);
    assert.ok(callAt > materialGateAt, `${mapper} must be called after the gate, never before it`);
    assert.ok(callAt < classBody.indexOf(`private static ${mapper}(`),
      `${mapper} must be called from the gated answer rather than from its own declaration`);
  }

  // The field itself is attached from that gated answer and from nothing else: a
  // literal in `style()` would be a 23+ member handed to a 21/22 device.
  const style = normalize(staticBody(hdsTitleBarSupport, 'static style('));
  assert.match(style,
    /const material: SystemMaterialParams \| undefined = HdsTitleBarSupport\.systemMaterial\(decision\); if \(material !== undefined\) \{ style\.systemMaterialEffect = material; \}/,
    'the material effect may only be attached from the gated answer');
  assert.match(style, /scrollEffectType: HdsTitleBarSupport\.scrollEffectType\(decision\)/,
    'the blur type may only come from the gated answer');

  // And the platform spellings are named in that one file. A call site that passed
  // one of them straight into a `titleBar` would bypass the gate on every device
  // the app supports, and no single-file assertion here could see it; the service
  // may read `hdsMaterial` because its own 26+ gate is asserted by
  // `hds-titlebar-policy.test.cjs` against a stub that records every member read.
  const gatedMembers = ['ScrollEffectType.IMMERSIVE_GRADIENT_BLUR', 'systemMaterialEffect', 'hdsMaterial.'];
  for (const [relative, text] of etsTree('entry/src/main/ets')) {
    const body = codeOf(text);
    for (const member of gatedMembers) {
      const owner = member === 'hdsMaterial.' ? 'services/HdsTitleBarMaterialService.ets' :
        'pages/components/HdsTitleBarSupport.ets';
      if (relative === 'pages/components/HdsTitleBarSupport.ets' || relative === owner) {
        continue;
      }
      assert.equal(body.includes(member), false,
        `${relative} must not name ${member}: the 23+ members are named inside the support class's gate, ` +
        'and a call site that names one passes it to every device the app supports');
    }
  }
});

test('the platform band is themed, and its two ends are two ends of one gradient', () => {
  // Both ends of the scroll effect are always configured, and they differ in
  // exactly one place: the floor is transparent while the content is at the top
  // and the page's overlay colour once the transcript has scrolled under it. That
  // is the gradient blur's two ends, and it is also the dynamic inversion's
  // evidence — the platform can only follow a resource colour it was given.
  const style = normalize(staticBody(hdsTitleBarSupport, 'static style('));
  assert.match(style,
    /originalStyle: HdsTitleBarSupport\.barStyle\(false\), scrollEffectStyle: HdsTitleBarSupport\.barStyle\(true\)/,
    'both ends of the scroll effect must be configured, and configured as two different ends');
  const barStyle = normalize(staticBody(hdsTitleBarSupport, 'private static barStyle('));
  assert.match(barStyle, /backgroundColor: scrolledUnder \? PAGE_BG_OVERLAY : TRANSPARENT/,
    'the two ends must differ in the floor they paint: the same colour twice is a band that never changes');

  // Every colour is a Theme token, and the keys are the closed vocabulary the
  // title bar's style has: a literal here is a band that stops following the
  // appearance, which is the one thing the theme cannot fix for it.
  const themeImport = /import \{([^}]+)\} from '\.\/Theme';/.exec(hdsTitleBarSupport);
  assert.notEqual(themeImport, null, 'the support class must read its colours from the theme');
  const tokens = themeImport[1].split(',').map((token) => token.trim());
  const values = [...barStyle.matchAll(
    /(?:backgroundColor|mainTitleColor|subTitleColor|iconColor):\s*(?:[A-Za-z0-9_]+ \? )?([A-Za-z0-9_]+)(?: : ([A-Za-z0-9_]+))?/g)]
    .flatMap((match) => [match[1], match[2]].filter((value) => value !== undefined));
  const distinct = [...new Set(values)].sort();
  assert.deepEqual(distinct, ['INK', 'MUTED', 'PAGE_BG_OVERLAY', 'TRANSPARENT'],
    'the band states a colour for its floor, its two lines and the platform return glyph\'s ink, and nothing ' +
    'else: the chips are the platform\'s, so there is no chip fill or menu colour to state');
  for (const value of distinct) {
    assert.ok(tokens.includes(value),
      `${value} must be a Theme token imported by the support class: a literal colour stops following the appearance`);
  }
  // The key vocabulary is re-derived from `barStyle`: the return glyph's *ink* is
  // stated (the platform's own default for it is the immersive pair — light while
  // the floor is transparent — so at rest in the light appearance the platform drew
  // a white arrow on a light chip and the way out of a conversation was invisible),
  // and nothing else about that control is: no `backgroundColor`, because the chip
  // is the platform's, and no `menuStyle` at all, because the menu trigger is a
  // symbol modifier that already carries the theme's ink.
  const keys = [...barStyle.matchAll(
    /\b(backgroundStyle|contentStyle|titleStyle|menuStyle|backIconStyle|backgroundColor|iconColor|mainTitleColor|subTitleColor)\b/g)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(keys)].sort(), ['backgroundStyle', 'contentStyle', 'titleStyle', 'backIconStyle',
    'backgroundColor', 'iconColor', 'mainTitleColor', 'subTitleColor'].sort(),
    'the band answers the floor, the two text lines and the return glyph\'s ink, and every one of its parts ' +
    'answers its own key');
  // Each control's block is read *whole*, and asserted as a key set: a block is a set
  // of keys, so `{ backgroundColor, iconColor }` is the same defect as the same two
  // keys in the other order, and a guard that read only the first key of a block would
  // pass one of the two spellings of the very thing it exists to stop. The vocabulary
  // is one key, and only the return control has a block at all: the chip's fill is the
  // platform's, and the menu trigger's symbol modifier already carries the theme's ink.
  const controlBlocks = [...barStyle.matchAll(/(menuStyle|backIconStyle): \{([^}]*)\}/g)]
    .map((match) => [match[1], [...match[2].matchAll(/(\w+)\s*:/g)].map((key) => key[1])]);
  assert.deepEqual(controlBlocks.map((block) => block[0]), ['backIconStyle'],
    'the return control is the only control the band styles at all: a `menuStyle` is a second chip the menu ' +
    'trigger does not need, and there is no third control to answer for');
  assert.deepEqual(controlBlocks[0][1].slice().sort(), ['iconColor'],
    'the return glyph may state its ink and nothing else: a `backgroundColor` there is the app recolouring the ' +
    'platform\'s own chip, in any key order, and a `menuStyle` is a second chip the menu trigger does not need');
  for (const [name, text] of [['HdsTitleBarSupport', hdsTitleBarSupport], ['HdsTitleBarPolicy', hdsTitleBarPolicy],
    ['HdsTitleBarMaterialService', hdsTitleBarMaterialService], ['ConversationHeaderMenu', conversationHeaderMenu]]) {
    assert.equal(/0x[0-9a-fA-F]|'#/.test(codeOf(text)), false,
      `${name} must not carry a bare colour: the one place a band's colour is decided is the theme`);
  }
});

test('the band carries the platform\'s own controls, and a surface wears one material', () => {
  // Neither control is the app's any more. The band configures no `content.backIcon`
  // at all, so the platform draws its own return control — an `icon` left out of a
  // `backIcon` block would be an empty slot, not the platform's arrow — and the menu
  // trigger is the system four-dot symbol. The assets that used to fill those slots
  // were a 38x59 return bitmap and a 64x19 overflow bitmap: HDS sizes its icon slot to
  // a 24vp square, so the wide one was rendered as a dark blob, which is the defect
  // this pins against. A screenshot cannot tell a squashed bitmap from a symbol.
  //
  // What the app still owns about that platform control is its ink, and only its ink:
  // measured on the phone, the platform's default for the return glyph while the floor
  // is transparent is a light colour on a chip that follows the appearance, so the
  // arrow was unreadable in the light appearance at rest. `barStyle()` therefore states
  // `backIconStyle.iconColor` and nothing else about either control.
  const content = normalize(staticBody(hdsTitleBarSupport, 'static conversationParams('));
  assert.match(content, /menuLabel: RemoteI18n\.t\('sidebar\.more'\)/,
    'the menu trigger must keep its label: the platform draws the glyph, the app still owns the words');
  assert.match(content, /menuAnchorId: CONVERSATION_HEADER_MENU_ANCHOR_ID/,
    'the trigger must hand the conversation the id its menu opens against');
  const body = codeOf(hdsTitleBarSupport);
  assert.equal(occurrences(body, "$r('sys.symbol.square_grid_2x2')"), 1,
    'the band must name the system four-dot symbol exactly once: one trigger, one glyph');
  assert.equal(occurrences(body, 'SystemSymbolIcon.modifier('), 1,
    'the band must carry that symbol in the platform modifier an HDS icon slot takes: a `ResourceStr` there ' +
    'is an image slot, and the platform draws its own back control from the same vocabulary');
  assert.equal(occurrences(codeOf(systemSymbolIcon),
    "import { SymbolGlyphModifier } from '@kit.ArkUI';"), 1,
    'the platform symbol value has one home: the design kit is the only API family the band\'s own files read');
  assert.equal(occurrences(body, "$r('app.media."), 0,
    'the band must name no app asset at all: `remote_ref_back` and `remote_ref_more` were the two bitmaps ' +
    'forced into the platform\'s square icon slots, and the platform supplies both controls now');
  assert.equal(/backIcon\s*:\s*\{/.test(body), false,
    'the band must configure no `backIcon` content block: the platform\'s own control is reached by omitting the ' +
    'block, and a block whose `icon` is unset draws an empty slot instead of an arrow');
  const backInk = /backIconStyle: \{([^}]*)\}/.exec(normalize(staticBody(hdsTitleBarSupport, 'private static barStyle(')));
  assert.notEqual(backInk, null,
    'the return glyph\'s ink must be stated once in `barStyle`: the platform\'s own default for it is the ' +
    'immersive pair, which is invisible on the light chip while the floor is transparent');
  assert.match(backInk[1], /iconColor: INK/,
    'that ink must be the theme\'s own, so the platform\'s colour inversion still follows the appearance');
  // The return asset must stay on disk, because production still draws it: it is the
  // glyph of the app's own floating return control (`NavigationBackButton`, guarded
  // below). The overflow asset is deliberately *not* asserted here any more:
  // `remote_ref_more` is retained as the app's approved overflow glyph, but no
  // production surface on this platform draws it now — its siblings in the same
  // reference set (`remote_ref_menu`) are in that state too — so a loop that required
  // it would pin a file nothing reads and would fail a legitimate later asset pruning
  // instead of describing what the app does.
  assert.ok(fs.existsSync(path.join(__dirname, '../../entry/src/main/resources/base/media', 'remote_ref_back.png')),
    'remote_ref_back must stay on disk: the app\'s own floating return control still draws it');
  assert.match(normalize(navigationBackButton), /src: \$r\('app\.media\.remote_ref_back'\)/,
    'the app\'s own floating return control must keep its approved asset: only the platform band gave it up');

  // One material channel per surface, and the two bands are on different sides of it.
  // The compact route's band is a navigation bar: its material arrives through the
  // platform's own options field. The wide band is a *content* surface, and a content
  // surface paints its own glass — the platform accepts a material there and draws
  // nothing, so a band that adopted one would have no surface at all. Each band names
  // the channel it is on, and neither names the other one.
  assert.equal(codeOf(hdsTitleBarSupport).includes('uiMaterial'), false,
    'the band must not adopt the app\'s own immersive material: the platform draws this one');
  assert.equal(/systemMaterial\s*[:=]/.test(codeOf(hdsTitleBarSupport)), false,
    'the band must not answer the app\'s `systemMaterial` option as well');
  assert.equal(codeOf(builderBody(conversationView, 'PlatformTopBand')).includes('systemMaterial'), false,
    'the platform band is a navigation bar: its material arrives through the options the support builds, and ' +
    'adopting the app\'s component material on the same box would be a second one');
  const wideBand = builderBody(conversationView, 'SelfDrawnTopBand');
  assert.equal(codeOf(wideBand).includes('.systemMaterial('), false,
    'the wide band is a content surface: the platform draws no material on one, so the band paints its own glass');
  assert.equal(codeOf(wideBand).includes('systemMaterialEffect'), false,
    'the wide band may not name the platform band\'s field either: its surface is not the platform\'s to draw');
  for (const [name, text] of [['ConversationView', conversationView], ['AppRootPresentation', appRootPresentation],
    ['ConversationRouteSurface', conversationRouteSurface]]) {
    const body = codeOf(text);
    assert.equal(body.includes('systemMaterialEffect'), false,
      `${name} must not write the platform field itself: the band's material comes from the support class`);
    assert.equal(body.includes('uiMaterial'), false,
      `${name} must not put the app's own material on the platform's band`);
  }

  // The menu the trigger opens is the app's floating menu, material included: it
  // is the same shared options object every other menu in the app uses, anchored
  // by the id the band handed its icon.
  assert.match(normalize(conversationView),
    /getPromptAction\(\)\.openMenu\( content, \{ id: CONVERSATION_HEADER_MENU_ANCHOR_ID \}, ImmersiveSurfaceSupport\.menuOptions\(ImmersiveSurfaceScene\.FLOATING_MENU\) \)/,
    'the anchored menu must open against the band\'s anchor with the shared floating-menu material');
  assert.match(normalize(conversationView),
    /const content = new ComponentContent<ConversationHeaderMenuParams>\( uiContext, wrapBuilder<\[ConversationHeaderMenuParams\]>\(conversationHeaderMenuBuilder\), params \)/,
    'the menu must render the shared builder: a member method reference here crashes across the layer');
  assert.match(normalize(conversationView),
    /getPromptAction\(\)\.closeMenu\(content\)/,
    'the menu must be closed by the node it was opened with, so the row that opens the editor is not left under it');
});

test('the rename moved into the menu, and the title is not a control under the platform bar', () => {
  // The platform's title is text: it has no tap handler, so the entry that used to
  // live on the title is a menu row now, and the row opens the editor in the
  // content area under the bar rather than in the chrome.
  const menu = normalize(conversationHeaderPolicy.slice(conversationHeaderPolicy.indexOf('static menu(')));
  assert.match(menu,
    /items\.push\(new ConversationHeaderMenuItem\( ConversationHeaderMenuAction\.Rename, 'chat\.rename', 'remote_actions_rename' \)\)/,
    'the menu must offer the rename row, and offer it the same way on both surfaces that migrate');
  // The row's label is a real catalog entry in both locales, like every other key
  // that reaches the platform as text.
  for (const [locale, names] of [['en_US', enUsResourceNames], ['zh_CN', zhCnResourceNames]]) {
    assert.ok(names.has('chat_rename'), `chat.rename must exist in ${locale}: the row is a label, not a literal`);
  }
  // Where the platform owns the band the header draws no row at all, which is what
  // removes the tap target: the gesture lives on the title inside `HeaderRow`.
  assert.match(normalize(conversationHeader),
    /if \(!this\.platformBar\) \{ this\.HeaderRow\(\) \} if \(this\.showTitleEditor\) \{ this\.TitleEditor\(\) \}/,
    'the header must drop its own row where the platform owns the band, and keep only the rename editor');
  assert.match(normalize(conversationHeader), /backgroundColor\(\(this\.translucent \|\| this\.platformBar\) \? TRANSPARENT : PAGE_BG\)/,
    'the header may not paint a fill under the platform\'s bar: that is the second glass again');
  assert.match(normalize(conversationHeader),
    /@Monitor\('renameRequest'\) onRenameRequested\(\): void \{ if \(this\.platformBar && this\.allowRename\) \{/,
    'the request must only open the row where the platform owns the trigger');
  assert.match(normalize(conversationView),
    /if \(id === ConversationHeaderMenuAction\.Rename\) \{ this\.renameRequest \+= 1; return; \}/,
    'the row must ask the content area to open its editor');
  assert.match(normalize(conversationView),
    /private get platformBar\(\): boolean \{ return this\.options\.platformBar; \}/,
    'the pane must read the platform-bar flag from its options, not from a second source');
});

test('the preview drives the real band rather than a second copy of its parameters', () => {
  // The platform title bar only exists inside a `Navigation`, and the app's root
  // is the only other place one is built: a fixture that restated the band's
  // parameters would be a second tier table, and the capture would stop describing
  // the app the day one of the two moved.
  const preview = normalize(immersiveBottomPreview);
  assert.match(preview, /this\.hdsTitleBar = scenarioId\.endsWith\('-hds-titlebar'\) \|\| scenarioId\.endsWith\('-hds-titlebar-dark'\);/,
    'the scenario must be recognised by name');
  assert.match(preview, /HdsNavigation\(this\.pageStack\)/, 'the fixture must mount the platform container');
  assert.match(preview, /\.navDestination\(this\.TitleBarDestination\)/,
    'the fixture must reach the band through a destination: a nav bar has no title bar of its own here');
  assert.match(preview, /\.titleBar\(HdsTitleBarSupport\.options\(this\.titleBarParams\(\)\)\)/,
    'the fixture must build its band from the production support class');
  assert.match(preview,
    /import \{ HdsTitleBarContentParams, HdsTitleBarSupport \} from '\.\.\/components\/HdsTitleBarSupport';/,
    'the fixture must import the production class rather than copy its parameters');
  assert.match(preview,
    /import \{ ConversationHeaderPolicy, ConversationHeaderPresentation \} from '\.\.\/policy\/ConversationHeaderPolicy';/,
    'the fixture\'s title must come from the header policy the pane itself reads');
  assert.match(preview, /HdsTitleBarSupport\.conversationParams\(presentation, \{/,
    'the fixture must let the support class assemble the content: the label is the app\'s and the two controls ' +
    'are the platform\'s, and a fixture that named either could drift from it');
  assert.match(preview, /options\.platformBar = this\.hdsTitleBar;/,
    'the pane under the bar must be told who owns its top edge');
  // The fixture names the tier table no more than it names the controls: the symbol
  // and the app's bitmaps both belong to production, and a fixture that restated one
  // would keep its capture looking right after the app had moved on.
  for (const literal of ['GRADIENT_BLUR', 'systemMaterialEffect', 'hdsMaterial', 'remote_ref_', 'square_grid_2x2']) {
    assert.equal(preview.includes(literal), false,
      `the fixture must not restate ${literal}: the tier table and the band's controls belong to production`);
  }
  // The trigger's request travels the way the app root's does — as state the pane
  // consumes by sequence — because the pane is not the component that was tapped.
  assert.match(preview, /this\.previewMenuSeq \+= 1;/,
    'the fixture\'s trigger must raise a sequence');
  assert.match(preview, /next\.conversationHeaderMenuSeq = this\.previewMenuSeq;/,
    'the request must reach the pane through the projected state it monitors');
  // And the ability opens it: a scenario that is not in the whitelist loads the
  // real app instead of the fixture, silently.
  for (const id of ['immersive-bottom-hds-titlebar', 'immersive-bottom-hds-titlebar-dark']) {
    assert.ok(entryAbility.includes(`scenarioId === '${id}'`),
      `${id} must be registered in the ability's preview whitelist`);
  }
  assert.ok(entryAbility.includes("scenarioId === 'immersive-bottom-hds-titlebar-dark'") &&
    entryAbility.includes('COLOR_MODE_DARK'),
    'the dark scenario must be able to ask for the dark appearance');
});
