// Black-box lifecycle checks against the production passive AppKit cursor.
#import "../../src/apps/desktop/src/computer_use/macos_capture.m"
#include <assert.h>

void obf_control_native_stopped(uint64_t generation, uint64_t revision, int32_t pid, uint32_t windowID, const char *reason) {
    (void)generation; (void)pid; (void)windowID; (void)reason;
}

static void pump(double duration) {
    NSDate *until = [NSDate dateWithTimeIntervalSinceNow:duration];
    while (until.timeIntervalSinceNow > 0) {
        [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode beforeDate:until];
    }
}
int main(int argc, const char *argv[]) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        pid_t foreground = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
        NSWindow *target = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 320, 240)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        target.title = @"OpenBitFun Pointer Fixture";
        [target orderFrontRegardless];
        pump(0.1);
        double top = CGDisplayBounds(CGMainDisplayID()).size.height - NSMaxY(target.frame);
        obf_pointer_show((uint32_t)target.windowNumber, 180, top + 80, true);
        pump(0.05);
        if (!obfPointerPanel.visible) {
            fprintf(stderr, "pointer missing: target=%u targetOrigin=%.0f,%.0f offset=%.0f,%.0f panel=%p\n", obfPointerTarget, target.frame.origin.x, target.frame.origin.y, obfPointerOffset.x, obfPointerOffset.y, (__bridge void *)obfPointerPanel);
        }
        assert(obfPointerPanel.visible);
        assert(((OBFControlPointerView *)obfPointerPanel.contentView).click);
        pump(2.0);
        assert(obfPointerPanel.visible); // Old 700ms expiry must never return.
        assert(!((OBFControlPointerView *)obfPointerPanel.contentView).click);
        assert(!obfPointerPanel.keyWindow);
        if (argc == 2) {
            NSView *view = obfPointerPanel.contentView;
            NSBitmapImageRep *bitmap = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
            [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
            NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
            assert([png writeToFile:[NSString stringWithUTF8String:argv[1]] atomically:YES]);
        }
        assert(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == foreground);
        // A lifecycle refresh must not interrupt an in-flight move. A retarget
        // starts from the displayed point instead of the old destination.
        double startX = obfPointerMotion.x;
        obf_pointer_show((uint32_t)target.windowNumber, 330, top + 140, true);
        pump(0.025);
        assert(obfPointerFrameTimer != nil);
        assert(obfPointerMotion.x > startX && obfPointerMotion.x < obfPointerMotion.targetX - 1);
        obf_pointer_refresh();
        assert(obfPointerMotion.x < obfPointerMotion.targetX - 1);
        assert(!((OBFControlPointerView *)obfPointerPanel.contentView).click);
        pump(0.7);
        assert(obfPointerFrameTimer == nil);
        assert(obfPointerMotion.x == obfPointerMotion.targetX);
        assert(!((OBFControlPointerView *)obfPointerPanel.contentView).click);
        obf_pointer_show((uint32_t)target.windowNumber, 180, top + 80, false);
        pump(0.05);
        assert(obfPointerMotion.velocityX < 0);
        __block BOOL retainedMomentum = NO;
        obf_pointer_show((uint32_t)target.windowNumber, 300, top + 100, false);
        dispatch_async(dispatch_get_main_queue(), ^{
            retainedMomentum = obfPointerMotion.velocityX < 0 &&
                obfPointerMotion.x != obfPointerMotion.targetX;
        });
        pump(0.02);
        assert(retainedMomentum);
        pump(0.7);
        assert(obfPointerFrameTimer == nil);
        NSPoint previous = obfPointerPanel.frame.origin;
        [target setFrameOrigin:NSMakePoint(120, 110)];
        pump(0.3);
        assert(fabs(obfPointerPanel.frame.origin.x - previous.x - 20) < 1);
        assert(fabs(obfPointerPanel.frame.origin.y - previous.y - 10) < 1);
        NSWindow *cover = [[NSWindow alloc] initWithContentRect:target.frame
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        [cover orderFrontRegardless];
        pump(0.3);
        assert(!obfPointerPanel.visible);
        [cover orderOut:nil];
        pump(0.3);
        assert(obfPointerPanel.visible);
        // A failed retarget must not resurrect the old target's pointer.
        obf_pointer_show(UINT32_MAX, 0, 0, false);
        pump(0.3);
        assert(!obfPointerPanel.visible);
        obf_pointer_show((uint32_t)target.windowNumber, 200, top + 70, false);
        pump(0.2);
        assert(obfPointerPanel.visible);
        obf_pointer_hide();
        pump(0.1);
        assert(!obfPointerPanel.visible && obfPointerTimer == nil && obfPointerFrameTimer == nil);
        assert(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == foreground);
        [target orderOut:nil];
        puts("PASS pointer smooth retargeting, refresh continuity, timer cleanup, persistence, occlusion and foreground preservation");
    }
    return 0;
}
