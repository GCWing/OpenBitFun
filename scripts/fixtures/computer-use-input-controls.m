// Standard AppKit controls and a non-AX canvas, with ordinary inactive-window
// behavior. No acceptsFirstMouse override, makeKeyWindow, or initial focus.
#import <AppKit/AppKit.h>
#include <math.h>
#include <unistd.h>
static NSString *resultPath;
static NSMutableArray *activationHistory, *lifecycleHistory, *observerInput;
static NSTextField *field;
static NSTableView *table;
static NSWindow *targetWindow, *foreignWindow;
static NSMutableArray *events;
static NSMutableString *canvasText;
static NSUInteger buttonActions, canvasDowns, canvasCommandDowns, foreignActions, canvasScrolls, shortcutActions, canvasEscapes;
static double canvasScrollX, canvasScrollY;
static NSDictionary *targets;
static void installLifecycleHistory(void) {
    lifecycleHistory = [NSMutableArray array];
    for (NSNotificationName name in @[NSApplicationDidBecomeActiveNotification, NSApplicationDidResignActiveNotification, NSWindowDidBecomeKeyNotification, NSWindowDidResignKeyNotification, NSWindowDidBecomeMainNotification, NSWindowDidResignMainNotification]) {
        [NSNotificationCenter.defaultCenter addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            NSWindow *window = [note.object isKindOfClass:NSWindow.class] ? note.object : nil;
            [lifecycleHistory addObject:@{@"notification":note.name, @"window_id":@(window.windowNumber), @"time":@(NSProcessInfo.processInfo.systemUptime), @"active":@(NSApp.active), @"key_window_id":@(NSApp.keyWindow.windowNumber)}];
        }];
    }
}
static void publish(void) {
    NSDictionary *data = @{@"bundle_id":NSBundle.mainBundle.bundleIdentifier ?: @"", @"frontmost_pid":@(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier), @"activation_history":activationHistory ?: @[], @"lifecycle_history":lifecycleHistory ?: @[], @"foreign_actions":@(foreignActions), @"selected_count":@(table.selectedRowIndexes.count), @"selected_row":@(table.selectedRow), @"canvas_scrolls":@(canvasScrolls), @"canvas_scroll_x":@(canvasScrollX), @"canvas_scroll_y":@(canvasScrollY), @"button_actions":@(buttonActions), @"shortcut_actions":@(shortcutActions), @"field_text":field.stringValue ?: @"", @"canvas_command_downs":@(canvasCommandDowns), @"canvas_downs":@(canvasDowns), @"canvas_text":canvasText, @"canvas_escape_presses":@(canvasEscapes), @"events":events, @"targets":targets ?: @{}, @"window_id":@(targetWindow.windowNumber), @"key_window":@(targetWindow.keyWindow), @"active":@(NSApp.active)};
    [[NSJSONSerialization dataWithJSONObject:data options:0 error:nil] writeToFile:resultPath atomically:YES];
}
@interface OBFControlsApp : NSApplication
@end
@implementation OBFControlsApp
- (NSEvent *)nextEventMatchingMask:(NSEventMask)mask untilDate:(NSDate *)expiration inMode:(NSRunLoopMode)mode dequeue:(BOOL)dequeue {
    NSEvent *event = [super nextEventMatchingMask:mask untilDate:expiration inMode:mode dequeue:dequeue];
    // Observe actual dequeued events, including a standard control's tracking
    // loop. NSButton consumes mouse-up inside mouseDown:, so sendEvent: alone
    // cannot witness both halves of an otherwise correctly delivered click.
    if (dequeue && (event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeLeftMouseUp)) {
        NSPoint local = event.locationInWindow;
        NSPoint content = [targetWindow.contentView convertPoint:local fromView:nil];
        NSView *hit = event.windowNumber == targetWindow.windowNumber ? [targetWindow.contentView hitTest:content] : nil;
        NSPoint screen = [targetWindow convertPointToScreen:local];
        BOOL outsideFrame = !NSPointInRect(screen, targetWindow.frame);
        [events addObject:@{@"type":@(event.type), @"window_id":@(event.windowNumber), @"target_key_before":@(targetWindow.keyWindow), @"target_active_before":@(NSApp.active), @"outside_frame":@(outsideFrame), @"time":@(NSProcessInfo.processInfo.systemUptime), @"flags":@(event.modifierFlags), @"x":@(local.x), @"y":@(local.y), @"hit":NSStringFromClass(hit.class) ?: @"none"}];
    }
    return event;
}
- (void)sendEvent:(NSEvent *)event {
    [super sendEvent:event];
    publish();
}
@end
@interface OBFPlainCanvas : NSView
@end
@implementation OBFPlainCanvas
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)isAccessibilityElement { return NO; }
- (void)drawRect:(NSRect)dirty { [NSColor.systemBlueColor setFill]; NSRectFill(self.bounds); }
- (void)mouseDown:(NSEvent *)event { canvasDowns++; if (event.modifierFlags & NSEventModifierFlagCommand) canvasCommandDowns++; [self.window makeFirstResponder:self]; publish(); }
- (void)scrollWheel:(NSEvent *)event { canvasScrolls++; canvasScrollX += event.scrollingDeltaX; canvasScrollY += event.scrollingDeltaY; publish(); }
- (void)keyDown:(NSEvent *)event { if (event.keyCode == 53) canvasEscapes++; else if (event.characters) [canvasText appendString:event.characters]; publish(); }
@end
@interface OBFControlsActions : NSObject <NSTextFieldDelegate, NSTableViewDataSource, NSTableViewDelegate>
@end
@implementation OBFControlsActions
- (NSInteger)numberOfRowsInTableView:(NSTableView *)view { return 3; }
- (id)tableView:(NSTableView *)view objectValueForTableColumn:(NSTableColumn *)column row:(NSInteger)row { return [NSString stringWithFormat:@"Row %ld",(long)row]; }
- (void)tableViewSelectionDidChange:(NSNotification *)note { if (targets) publish(); }
- (void)foreignClicked:(id)sender { foreignActions++; publish(); }
- (void)clicked:(id)sender { buttonActions++; publish(); }
- (void)shortcut:(id)sender { shortcutActions++; publish(); }
- (void)controlTextDidChange:(NSNotification *)notification { publish(); }
@end
static NSArray *screenPoint(NSView *view) {
    NSPoint local = [view convertPoint:NSMakePoint(NSMidX(view.bounds),NSMidY(view.bounds)) toView:nil];
    NSPoint screen = [targetWindow convertPointToScreen:local];
    return @[@(screen.x), @(CGDisplayBounds(CGMainDisplayID()).size.height - screen.y)];
}
int main(int argc, const char **argv) { @autoreleasepool {
    if (argc < 2) return 2;
    // Read-only hardware-source idle gate. Do not create NSApplication or
    // windows while the desktop user is actively typing or moving the mouse.
    if (strcmp(argv[1], "--wait-input-idle") == 0) {
        const double quietSeconds = 3.0;
        const double timeoutSeconds = argc > 2 ? strtod(argv[2], NULL) : 20.0;
        const double started = NSProcessInfo.processInfo.systemUptime;
        do {
            NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
            NSNumber *locked = session[@"CGSSessionScreenIsLocked"];
            if ([locked isKindOfClass:NSNumber.class] && locked.boolValue) {
                fprintf(stderr, "INCONCLUSIVE: execution host screen is locked; no observer was activated\n");
                return 75;
            }
            double idle = CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kCGAnyInputEventType);
            if (!isfinite(idle) || idle < 0) {
                fprintf(stderr, "INCONCLUSIVE: hardware input idle state unavailable; no observer was activated\n");
                return 75;
            }
            if (idle >= quietSeconds) {
                printf("Hardware input idle gate: %.3f seconds (HIDSystemState)\n", idle);
                return 0;
            }
            usleep(250000);
        } while (NSProcessInfo.processInfo.systemUptime - started < timeoutSeconds);
        fprintf(stderr, "INCONCLUSIVE: no 3-second hardware input idle window within %.0f seconds; no observer was activated\n", timeoutSeconds);
        return 75;
    }
    activationHistory = [NSMutableArray array];
    installLifecycleHistory();
    [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceDidActivateApplicationNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
        NSRunningApplication *activated = note.userInfo[NSWorkspaceApplicationKey];
        [activationHistory addObject:@{@"pid":@(activated.processIdentifier), @"bundle_id":activated.bundleIdentifier ?: @"", @"time":@(NSProcessInfo.processInfo.systemUptime)}];
    }];
    if (strcmp(argv[1], "--observer") == 0) {
        NSApplication *observer = [NSApplication sharedApplication];
        [observer setActivationPolicy:NSApplicationActivationPolicyRegular];
        NSWindow *window = [[NSWindow alloc] initWithContentRect:(getenv("OPENBITFUN_INPUT_COVER_TARGET") && strcmp(getenv("OPENBITFUN_INPUT_COVER_TARGET"),"1")==0 ? NSMakeRect(80,80,760,340) : NSMakeRect(850,100,240,180)) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        window.title = @"OpenBitFun Foreground Observer";
        NSString *observerPath = argc > 2 ? [NSString stringWithUTF8String:argv[2]] : nil;
        uint32_t observedTarget = argc > 3 ? (uint32_t)strtoul(argv[3], NULL, 10) : 0;
        __block BOOL observerReady = NO;
        __block double readyTime = 0;
        __block CGPoint readyCursor = CGPointZero;
        observerInput = [NSMutableArray array];
        [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown | NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown handler:^NSEvent *(NSEvent *event) {
            [observerInput addObject:@{@"type":@(event.type), @"window_id":@(event.windowNumber), @"flags":@(event.modifierFlags), @"time":@(NSProcessInfo.processInfo.systemUptime)}];
            return event;
        }];
        if (observerPath) [NSTimer scheduledTimerWithTimeInterval:0.03 repeats:YES block:^(NSTimer *timer) {
            NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID));
            NSInteger targetIndex = -1, observerIndex = -1;
            for (NSUInteger i = 0; i < windows.count; i++) {
                uint32_t wid = [windows[i][(id)kCGWindowNumber] unsignedIntValue];
                if (wid == observedTarget) targetIndex = (NSInteger)i;
                if (wid == (uint32_t)window.windowNumber) observerIndex = (NSInteger)i;
            }
            CGEventRef cursorEvent = CGEventCreate(NULL);
            CGPoint cursor = cursorEvent ? CGEventGetLocation(cursorEvent) : CGPointMake(NAN, NAN);
            if (cursorEvent) CFRelease(cursorEvent);
            NSDictionary *state = @{@"cursor_valid":@((BOOL)(isfinite(cursor.x) && isfinite(cursor.y))), @"cursor":@[@(isfinite(cursor.x) ? cursor.x : 0), @(isfinite(cursor.y) ? cursor.y : 0)], @"ready_cursor":@[@(readyCursor.x), @(readyCursor.y)], @"hardware_idle_seconds":@(CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kCGAnyInputEventType)), @"bundle_id":NSBundle.mainBundle.bundleIdentifier ?: @"", @"frontmost_pid":@(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier), @"activation_history":activationHistory, @"lifecycle_history":lifecycleHistory, @"input_events":observerInput, @"ready_time":@(readyTime), @"ready":@(observerReady), @"pid":@(getpid()), @"active":@(observer.active), @"key_window":@(window.keyWindow), @"target_ahead":@((BOOL)(targetIndex >= 0 && observerIndex >= 0 && targetIndex < observerIndex))};
            [[NSJSONSerialization dataWithJSONObject:state options:0 error:nil] writeToFile:observerPath atomically:YES];
        }];
        [window makeKeyAndOrderFront:nil]; [observer activateIgnoringOtherApps:YES];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            [observer activateIgnoringOtherApps:YES]; [window makeKeyAndOrderFront:nil];
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
                CGEventRef cursorEvent = CGEventCreate(NULL);
                if (!cursorEvent) {
                    fprintf(stderr, "INCONCLUSIVE: cursor baseline unavailable\n");
                    exit(75);
                }
                readyCursor = CGEventGetLocation(cursorEvent);
                CFRelease(cursorEvent);
                if (!isfinite(readyCursor.x) || !isfinite(readyCursor.y)) {
                    fprintf(stderr, "INCONCLUSIVE: cursor baseline invalid\n");
                    exit(75);
                }
                readyTime = NSProcessInfo.processInfo.systemUptime;
                observerReady = YES;
                printf("READY %d active=%d key=%d foreground=%d\n",getpid(),observer.active,window.keyWindow,NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier); fflush(stdout);
            });
        });
        [observer run]; return 0;
    }
    resultPath = [NSString stringWithUTF8String:argv[1]];
    events = [NSMutableArray array]; canvasText = [NSMutableString string];
    NSApplication *app = [OBFControlsApp sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    // Miniaturizable so the foreground fixture can exercise minimized-window restore.
    targetWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(100,100,700,300) styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskMiniaturizable backing:NSBackingStoreBuffered defer:NO];
    targetWindow.title = @"OpenBitFun Inactive Controls Fixture";
    targetWindow.releasedWhenClosed = NO;
    OBFControlsActions *actions = [[OBFControlsActions alloc] init];
    // Ordinary AppKit menu dispatch: no event interception or automation hooks.
    NSMenu *mainMenu = [[NSMenu alloc] initWithTitle:@"Fixture"];
    NSMenuItem *menuRoot = [[NSMenuItem alloc] initWithTitle:@"Fixture" action:NULL keyEquivalent:@""];
    NSMenu *fixtureMenu = [[NSMenu alloc] initWithTitle:@"Fixture"];
    NSMenuItem *shortcut = [[NSMenuItem alloc] initWithTitle:@"Count shortcut" action:@selector(shortcut:) keyEquivalent:@"k"];
    shortcut.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagShift;
    shortcut.target = actions;
    [fixtureMenu addItem:shortcut];
    menuRoot.submenu = fixtureMenu;
    [mainMenu addItem:menuRoot];
    app.mainMenu = mainMenu;
    NSButton *button = [NSButton buttonWithTitle:@"Count one action" target:actions action:@selector(clicked:)];
    button.frame = NSMakeRect(20,240,240,30);
    field = [[NSTextField alloc] initWithFrame:NSMakeRect(20,180,300,30)];
    [field setAccessibilityIdentifier:@"fixture-text-field"];
    field.delegate = actions;
    OBFPlainCanvas *canvas = [[OBFPlainCanvas alloc] initWithFrame:NSMakeRect(20,20,300,100)];
    [targetWindow.contentView addSubview:button]; [targetWindow.contentView addSubview:field]; [targetWindow.contentView addSubview:canvas];
    table = [[NSTableView alloc] initWithFrame:NSMakeRect(440,20,220,240)];
    NSTableColumn *column = [[NSTableColumn alloc] initWithIdentifier:@"selection"]; column.width=220;
    [table addTableColumn:column]; table.headerView=nil; table.rowHeight=30; table.allowsMultipleSelection=YES;
    table.dataSource=actions; table.delegate=actions; [table reloadData];
    [table selectRowIndexes:[NSIndexSet indexSetWithIndex:0] byExtendingSelection:NO];
    [targetWindow.contentView addSubview:table];
    foreignWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(1050,100,200,100) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    foreignWindow.title = @"Unbound Fixture Window";
    NSButton *foreign = [NSButton buttonWithTitle:@"Unbound semantic action" target:actions action:@selector(foreignClicked:)];
    foreign.frame=NSMakeRect(10,30,180,30); [foreignWindow.contentView addSubview:foreign];
    [foreignWindow orderFront:nil];
    [targetWindow orderFront:nil];
    NSRect row = [table rectOfRow:1];
    NSPoint tableLocal = [table convertPoint:NSMakePoint(NSMidX(row),NSMidY(row)) toView:nil];
    NSPoint tableScreen = [targetWindow convertPointToScreen:tableLocal];
    targets = @{@"button":screenPoint(button), @"field":screenPoint(field), @"canvas":screenPoint(canvas), @"table":@[@(tableScreen.x), @(CGDisplayBounds(CGMainDisplayID()).size.height-tableScreen.y)]};
    [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidResignActiveNotification object:nil queue:nil usingBlock:^(NSNotification *note) { publish(); }];
    [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidFinishLaunchingNotification object:nil queue:nil usingBlock:^(NSNotification *note) {
        dispatch_async(dispatch_get_main_queue(), ^{
            publish(); printf("READY %d\n",getpid()); fflush(stdout);
        });
    }];
    [app run];
} }
