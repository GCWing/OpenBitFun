// Disposable target for the real ComputerUseTool -> desktop host pipeline.
#import <AppKit/AppKit.h>
#include <stdio.h>
static NSString *resultPath;
static NSMutableString *receivedText;
static NSUInteger downs, ups, enters, activations;
static void publish(void) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"downs":@(downs), @"ups":@(ups), @"enters":@(enters), @"activations":@(activations), @"text":receivedText} options:0 error:nil];
    [data writeToFile:resultPath atomically:YES];
}
@interface OBFRoundtripWindow : NSWindow
@end
@implementation OBFRoundtripWindow
- (BOOL)canBecomeKeyWindow { return YES; }
@end
@interface OBFRoundtripEditor : NSView
@end
@implementation OBFRoundtripEditor
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)isAccessibilityElement { return YES; }
- (NSString *)accessibilityRole { return NSAccessibilityTextAreaRole; }
- (NSString *)accessibilityLabel { return @"Fixture editor"; }
- (NSString *)accessibilityValue { return receivedText; }
- (void)drawRect:(NSRect)rect {
    [NSColor.whiteColor setFill]; NSRectFill(self.bounds);
    NSString *text = [@"Computer Use Fixture\n" stringByAppendingString:receivedText];
    [text drawInRect:NSInsetRect(self.bounds, 16, 16) withAttributes:@{NSFontAttributeName:[NSFont systemFontOfSize:20], NSForegroundColorAttributeName:NSColor.blackColor}];
}
- (void)mouseDown:(NSEvent *)event { downs++; [self.window makeFirstResponder:self]; publish(); }
- (void)mouseUp:(NSEvent *)event { ups++; publish(); }
- (void)keyDown:(NSEvent *)event {
    if (event.keyCode == 36) enters++;
    else if (event.characters.length) [receivedText appendString:event.characters];
    self.needsDisplay = YES;
    publish();
}
@end
@interface OBFRoundtripActions : NSObject
- (void)activateFixture:(id)sender;
@end
@implementation OBFRoundtripActions
- (void)activateFixture:(id)sender { activations++; publish(); }
@end
int main(int argc, const char **argv) { @autoreleasepool {
    if (argc != 2) return 2;
    resultPath = [NSString stringWithUTF8String:argv[1]];
    receivedText = [NSMutableString string];
    NSApplication *app = NSApplication.sharedApplication;
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    OBFRoundtripWindow *window = [[OBFRoundtripWindow alloc] initWithContentRect:NSMakeRect(100,100,420,240) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.title = @"Computer Use Roundtrip Fixture";
    window.releasedWhenClosed = NO;
    NSView *root = [[NSView alloc] initWithFrame:NSMakeRect(0,0,420,240)];
    OBFRoundtripEditor *editor = [[OBFRoundtripEditor alloc] initWithFrame:NSMakeRect(0,0,420,180)];
    [root addSubview:editor];
    OBFRoundtripActions *actions = [[OBFRoundtripActions alloc] init];
    NSButton *button = [NSButton buttonWithTitle:@"Fixture semantic action" target:actions action:@selector(activateFixture:)];
    button.frame = NSMakeRect(20,190,240,32);
    [root addSubview:button];
    window.contentView = root;
    [window orderFront:nil];
    [window makeKeyWindow];
    [window makeFirstResponder:editor];
    // A second, larger window deliberately wins legacy PID-only capture.
    // The tool must discover and explicitly select the smaller task window.
    NSWindow *mainWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(700,100,760,500) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    mainWindow.title = @"Computer Use Large Main Fixture";
    mainWindow.releasedWhenClosed = NO;
    mainWindow.backgroundColor = NSColor.purpleColor;
    [mainWindow orderFront:nil];
    publish();
    double y = CGDisplayBounds(CGMainDisplayID()).size.height - 170;
    printf("READY %d 170 %.0f\n",getpid(),y); fflush(stdout);
    [app run];
} }
