// A dedicated inactive target. No user application is inspected or mutated.
#import <AppKit/AppKit.h>
#include <stdio.h>
static NSString *resultPath;
static NSUInteger downs, ups;
static NSMutableArray *locations;
static void publish(void) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"downs":@(downs), @"ups":@(ups), @"locations":locations} options:0 error:nil];
    [data writeToFile:resultPath atomically:YES];
}
@interface OBFInputFixtureView : NSView
@end
@implementation OBFInputFixtureView
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (void)mouseDown:(NSEvent *)event { downs++; [locations addObject:@[@(event.locationInWindow.x), @(event.locationInWindow.y)]]; publish(); }
- (void)mouseUp:(NSEvent *)event { ups++; [locations addObject:@[@(event.locationInWindow.x), @(event.locationInWindow.y)]]; publish(); }
@end
int main(int argc, const char **argv) { @autoreleasepool {
    if(argc != 2) return 2;
    locations = [NSMutableArray array];
    resultPath = [NSString stringWithUTF8String:argv[1]];
    NSApplication *app = NSApplication.sharedApplication;
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100,100,240,160) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    window.backgroundColor = NSColor.windowBackgroundColor;
    window.contentView = [[OBFInputFixtureView alloc] initWithFrame:NSMakeRect(0,0,240,160)];
    window.releasedWhenClosed = NO;
    [window orderFront:nil];
    publish();
    double y = CGDisplayBounds(CGMainDisplayID()).size.height - 210;
    printf("READY %d 160 %.0f\n",getpid(),y); fflush(stdout);
    [app run];
} }
