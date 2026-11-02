// Disposable popup fixture: one main window plus a borderless popup panel
// owned by the same process. Mode "child" attaches the panel as an AppKit child
// window (it inherits the main window's layer, like attached dropdowns); mode
// "menu" leaves it independent at the pop-up menu level, like context menus.
// Like a real menu, the popup closes on any press outside it. Records which
// window each press hit.
#import <AppKit/AppKit.h>

static NSString *resultPath;
static NSMutableArray *mainPresses;
static NSMutableArray *popupPresses;
static NSWindow *mainWindow;
static NSPanel *popup;
static BOOL popupDismissed;

static NSDictionary *globalFrame(NSWindow *window) {
    CGFloat primaryHeight = NSScreen.screens.firstObject.frame.size.height;
    NSRect frame = window.frame;
    return @{@"x": @(frame.origin.x), @"y": @(primaryHeight - NSMaxY(frame)),
             @"width": @(frame.size.width), @"height": @(frame.size.height)};
}

static void writeResult(void) {
    NSDictionary *result = @{
        @"pid": @(getpid()),
        @"window_id": @(mainWindow.windowNumber),
        @"popup_window_id": @(popup.windowNumber),
        @"main_frame": globalFrame(mainWindow),
        @"popup_frame": globalFrame(popup),
        @"popup_visible": @(popup.isVisible),
        @"popup_dismissed": @(popupDismissed),
        @"main_presses": mainPresses,
        @"popup_presses": popupPresses,
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    [data writeToFile:resultPath atomically:YES];
}

@interface RecordingView : NSView
@property(nonatomic, strong) NSColor *fill;
@property(nonatomic, assign) BOOL isPopup;
@end

@implementation RecordingView
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (void)drawRect:(NSRect)dirty {
    [self.fill setFill];
    NSRectFill(self.bounds);
}
- (void)record:(NSEvent *)event phase:(NSString *)phase {
    NSPoint local = [self convertPoint:event.locationInWindow fromView:nil];
    NSDictionary *press = @{@"phase": phase, @"window_id": @(event.windowNumber),
                            @"x": @(local.x), @"y": @(self.bounds.size.height - local.y)};
    [(self.isPopup ? popupPresses : mainPresses) addObject:press];
    writeResult();
}
- (void)mouseDown:(NSEvent *)event { [self record:event phase:@"down"]; }
- (void)mouseUp:(NSEvent *)event { [self record:event phase:@"up"]; }
@end

int main(int argc, const char **argv) {
    @autoreleasepool {
        BOOL child = argc == 3 && strcmp(argv[2], "child") == 0;
        if (argc != 3 || (!child && strcmp(argv[2], "menu") != 0)) {
            fprintf(stderr, "usage: computer-use-popup <result.json> <child|menu>\n");
            return 2;
        }
        resultPath = [NSString stringWithUTF8String:argv[1]];
        mainPresses = [NSMutableArray array];
        popupPresses = [NSMutableArray array];
        NSApplication *app = NSApplication.sharedApplication;
        app.activationPolicy = NSApplicationActivationPolicyRegular;

        NSRect visible = NSScreen.screens.firstObject.visibleFrame;
        NSRect mainRect = NSMakeRect(NSMinX(visible) + 80, NSMaxY(visible) - 440, 480, 360);
        mainWindow = [[NSWindow alloc] initWithContentRect:mainRect
                                                 styleMask:NSWindowStyleMaskTitled
                                                   backing:NSBackingStoreBuffered
                                                     defer:NO];
        mainWindow.title = @"OpenBitFun Popup Fixture";
        mainWindow.releasedWhenClosed = NO;
        RecordingView *mainView = [[RecordingView alloc] initWithFrame:NSMakeRect(0, 0, 480, 360)];
        mainView.fill = [NSColor colorWithSRGBRed:0.10 green:0.20 blue:0.80 alpha:1];
        mainWindow.contentView = mainView;

        NSRect popupRect = NSMakeRect(NSMinX(mainRect) + 60, NSMinY(mainRect) + 60, 200, 120);
        popup = [[NSPanel alloc] initWithContentRect:popupRect
                                           styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                             backing:NSBackingStoreBuffered
                                               defer:NO];
        popup.level = NSPopUpMenuWindowLevel;
        popup.hasShadow = NO;
        popup.opaque = YES;
        popup.releasedWhenClosed = NO;
        popup.becomesKeyOnlyIfNeeded = YES;
        RecordingView *popupView = [[RecordingView alloc] initWithFrame:NSMakeRect(0, 0, 200, 120)];
        popupView.fill = [NSColor colorWithSRGBRed:0.90 green:0.10 blue:0.10 alpha:1];
        popupView.isPopup = YES;
        popup.contentView = popupView;

        [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown
                                              handler:^NSEvent *(NSEvent *event) {
            if (popup.isVisible && event.window != popup) {
                popupDismissed = YES;
                [popup orderOut:nil];
                writeResult();
            }
            return event;
        }];

        [mainWindow orderFront:nil];
        if (child) [mainWindow addChildWindow:popup ordered:NSWindowAbove];
        [popup orderFront:nil];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            writeResult();
            printf("READY %d\n", getpid());
            fflush(stdout);
        });
        [app run];
    }
    return 0;
}
