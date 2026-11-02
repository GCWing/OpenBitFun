#import <AppKit/AppKit.h>
#import <CoreMedia/CoreMedia.h>
@interface NSObject (OBFCaptureTimingFixture)
@property(nonatomic) CMTime lastObservedSample;
@property(nonatomic) CMTime inputBarrier;
@end
#include <stdio.h>
#include <stdatomic.h>
static atomic_bool stoppedWithIdentity;
static atomic_uint stopCount;
static uint32_t expectedWindow;
static uint64_t expectedGeneration = 1;
extern uint32_t obf_capture_validate_target(int32_t, uint32_t, char *, size_t);
extern void *obf_capture_start(int32_t, uint32_t, uint64_t, char *, size_t);
extern void obf_capture_mark_input(void *);
extern int obf_capture_bounds(void *, double *, char *, size_t);
extern int obf_capture_frame(void *, uint8_t **, size_t *, uint32_t *, uint32_t *, uint32_t *, double *, uint64_t *, char *, size_t);
extern void obf_capture_free(void *);
extern void obf_capture_stop(void *);
extern void obf_pointer_show(uint32_t, double, double, bool);
extern void obf_pointer_hide(void);
void obf_control_native_stopped(uint64_t generation, uint64_t revision, int32_t pid, uint32_t windowID, const char *reason) {
    atomic_fetch_add(&stopCount, 1);
    if(generation == expectedGeneration && pid == getpid() && windowID == expectedWindow) atomic_store(&stoppedWithIdentity, true);
    fprintf(stderr, "Stopped: %s\n", reason);
}
// Opt-in diagnostic for a real application: only reads captured frames and
// prints window identity/geometry. No pixels are persisted and no input is sent.
static void observeApp(pid_t pid) {
 dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
   char error[1024]={0}; pid_t before=NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
   void *h=obf_capture_start(pid,0,1,error,sizeof(error));
   if(!h){fprintf(stderr,"START_ERROR %s\n",error);exit(1);}
   int result=0; uint32_t bound=0;
   for(int i=0;i<20;i++){
     uint8_t *bytes=NULL;size_t length=0;uint32_t w=0,ht=0,wid=0;double bounds[4]={0};uint64_t sequence=0;
     if(!obf_capture_frame(h,&bytes,&length,&w,&ht,&wid,bounds,&sequence,error,sizeof(error))){fprintf(stderr,"FRAME_ERROR %s\n",error);result=1;break;}
     if(i==0)bound=wid;
     if(wid!=bound || atomic_load(&stopCount)){result=1;break;}
     obf_capture_free(bytes);
     CFArrayRef raw=CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID);
     uint32_t first=0;
     for(NSDictionary *win in CFBridgingRelease(raw)){
       if([win[(id)kCGWindowOwnerPID] intValue]==pid && [win[(id)kCGWindowLayer] intValue]==0){ first=[win[(id)kCGWindowNumber] unsignedIntValue];break;}
     }
     printf("observation=%d bound_window=%u first_layer0_window=%u frame=%ux%u sequence=%llu foreground=%d\n",i,bound,first,w,ht,sequence,NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
     [NSThread sleepForTimeInterval:0.15];
   }
   printf("foreground_before=%d after=%d native_stop_count=%u\n",before,NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier,atomic_load(&stopCount));
   if (before != NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier) {
     fprintf(stderr, "FAIL foreground changed during observation (user activity also invalidates this assertion)\n"); result = 1;
   }
   obf_capture_stop(h);exit(result);
 });
}
int main(int argc, const char **argv) { @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--locked") == 0) {
        NSDictionary *state = CFBridgingRelease(CGSessionCopyCurrentDictionary());
        if (![state[@"CGSSessionScreenIsLocked"] boolValue]) { puts("SKIP execution host is not locked"); return 2; }
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        __block int result = 1;
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            char error[1024] = {0};
            void *handle = obf_capture_start(getpid(), 0, 1, error, sizeof(error));
            if (!handle && strstr(error, "SESSION_LOCKED:")) { printf("PASS %s\n", error); result = 0; }
            else { fprintf(stderr, "FAIL unexpected lock result: %s\n", error); if (handle) obf_capture_stop(handle); }
            dispatch_semaphore_signal(done);
        });
        if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC))) {
            fprintf(stderr, "FAIL locked capture did not fail promptly\n"); return 1;
        }
        return result;
    }
    if (argc == 3 && strcmp(argv[1], "--app-pid") == 0) {
        char *end = NULL;
        long selectedPid = strtol(argv[2], &end, 10);
        if (!end || *end || selectedPid <= 0 || selectedPid > INT32_MAX) return 2;
        NSApplication *app = NSApplication.sharedApplication;
        [app setActivationPolicy:NSApplicationActivationPolicyProhibited];
        observeApp((pid_t)selectedPid);
        [app run];
        return 0;
    }
    BOOL minimize = argc > 1 && strcmp(argv[1], "--minimized") == 0;
    NSApplication *app = NSApplication.sharedApplication;
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow *target = [[NSWindow alloc] initWithContentRect:NSMakeRect(100,100,240,160) styleMask:(minimize ? NSWindowStyleMaskTitled | NSWindowStyleMaskMiniaturizable : NSWindowStyleMaskBorderless) backing:NSBackingStoreBuffered defer:NO];
    target.backgroundColor = NSColor.redColor;
    target.releasedWhenClosed = NO;
    [target orderFront:nil];
    NSWindow *cover = [[NSWindow alloc] initWithContentRect:NSMakeRect(90,90,260,180) styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
    cover.backgroundColor = NSColor.blueColor;
    cover.releasedWhenClosed = NO;
    [cover orderFront:nil];
    uint32_t targetID = (uint32_t)target.windowNumber;
    expectedWindow = targetID;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0), ^{
        char error[1024] = {0};
        void *handle = obf_capture_start(getpid(), targetID, 1, error, sizeof(error));
        int result = 1;
        if (!handle) fprintf(stderr,"FAIL start: %s\n",error);
        else {
            uint8_t *bytes = NULL; size_t length=0; uint32_t width=0,height=0,windowID=0; uint64_t sequence=0; double bounds[4]={0};
            if (!obf_capture_frame(handle,&bytes,&length,&width,&height,&windowID,bounds,&sequence,error,sizeof(error))) fprintf(stderr,"FAIL frame: %s\n",error);
            else {
                size_t center = ((height/2)*width + width/2)*4;
                printf("Frame %ux%u target=%u returned=%u sequence=%llu center RGBA=%u,%u,%u,%u bounds=%.0f,%.0f,%.0f,%.0f\n",width,height,targetID,windowID,sequence,bytes[center],bytes[center+1],bytes[center+2],bytes[center+3],bounds[0],bounds[1],bounds[2],bounds[3]);
                if(windowID==targetID && bytes[center]>180 && bytes[center]>bytes[center+1]*3 && bytes[center]>bytes[center+2]*3) { puts("PASS occluded-window capture: target red pixels, not blue covering window"); result=0; }
                obf_capture_free(bytes);
            }
            if (result == 0) {
                // Use the production timestamp barrier and real ScreenCaptureKit
                // callbacks, including idle frames for an unchanged window.
                obf_capture_mark_input(handle);
                CMTime barrier = [(__bridge id)handle inputBarrier];
                uint8_t *fresh = NULL; size_t freshLength = 0;
                uint32_t freshWidth = 0, freshHeight = 0, freshWindow = 0;
                uint64_t freshSequence = 0; double freshBounds[4] = {0};
                if (!obf_capture_frame(handle, &fresh, &freshLength, &freshWidth, &freshHeight,
                                       &freshWindow, freshBounds, &freshSequence, error, sizeof(error)) ||
                    CMTimeCompare([(__bridge id)handle lastObservedSample], barrier) < 0) {
                    fprintf(stderr, "FAIL capture returned a pre-input sample: %s\n", error); result = 1;
                } else puts("PASS post-input observation waits for a newer complete or idle sample");
                if (fresh) obf_capture_free(fresh);
                // Re-observation after unrelated window ordering and an invalid
                // target lookup must retain the original stream identity.
                int invalid = obf_capture_validate_target(getpid(), UINT32_MAX, error, sizeof(error));
                if (invalid || !strstr(error, "TARGET_WINDOW_UNAVAILABLE")) {
                    fprintf(stderr, "FAIL invalid candidate was accepted: %s\n", error); result = 1;
                }
                for (int observation = 0; observation < 20 && result == 0; observation++) {
                    uint8_t *repeat = NULL; size_t repeatLength = 0;
                    uint32_t repeatWidth = 0, repeatHeight = 0, repeatWindow = 0;
                    uint64_t repeatSequence = 0; double repeatBounds[4] = {0};
                    if (!obf_capture_frame(handle, &repeat, &repeatLength, &repeatWidth, &repeatHeight,
                                           &repeatWindow, repeatBounds, &repeatSequence, error, sizeof(error)) ||
                        repeatWindow != targetID || atomic_load(&stoppedWithIdentity)) {
                        fprintf(stderr, "FAIL persistent observation %d: %s\n", observation, error); result = 1;
                    }
                    if (repeat) obf_capture_free(repeat);
                    [NSThread sleepForTimeInterval:0.05];
                }
                if (result == 0) puts("PASS failed target validation and 20 observations preserve the same live capture");
            }
            if (result == 0) {
                dispatch_sync(dispatch_get_main_queue(), ^{ [cover orderOut:nil]; [target orderFrontRegardless]; });
                [NSThread sleepForTimeInterval:0.15];
                pid_t foreground = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
                uint32_t humanMovesBefore = CGEventSourceCounterForEventType(kCGEventSourceStateHIDSystemState, kCGEventMouseMoved);
                CGEventRef beforeEvent = CGEventCreate(NULL);
                CGPoint beforePointer = CGEventGetLocation(beforeEvent); CFRelease(beforeEvent);
                obf_pointer_show(targetID, 220, CGDisplayBounds(CGMainDisplayID()).size.height - 180, true);
                [NSThread sleepForTimeInterval:0.2];
                __block BOOL markerVisible = NO;
                dispatch_sync(dispatch_get_main_queue(), ^{
                    for(NSWindow *window in NSApp.windows) {
                        if([NSStringFromClass(window.contentView.class) isEqualToString:@"OBFControlPointerView"] && window.visible && window.ignoresMouseEvents) markerVisible = YES;
                    }
                });
                CGEventRef afterEvent = CGEventCreate(NULL);
                CGPoint afterPointer = CGEventGetLocation(afterEvent); CFRelease(afterEvent);
                BOOL humanMoved = CGEventSourceCounterForEventType(kCGEventSourceStateHIDSystemState, kCGEventMouseMoved) != humanMovesBefore;
                if (!markerVisible || foreground != NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier || (!humanMoved && !CGPointEqualToPoint(beforePointer, afterPointer))) {
                    fprintf(stderr,"FAIL native pointer visible=%d foreground=%d/%d pointer=%.0f,%.0f/%.0f,%.0f\n",markerVisible,foreground,NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier,beforePointer.x,beforePointer.y,afterPointer.x,afterPointer.y); result = 1;
                } else {
                    puts("PASS real nonactivating pointer window is visible and does not change foreground app");
                    if(humanMoved) puts("NOTE concurrent human pointer motion; cursor position assertion not evaluated");
                    else puts("PASS native feedback leaves the human cursor unchanged");
                }
                obf_pointer_hide();
                dispatch_sync(dispatch_get_main_queue(), ^{ [target setFrameOrigin:NSMakePoint(110,100)]; });
                [NSThread sleepForTimeInterval:0.15]; // WindowServer commits the AppKit geometry asynchronously.
                double inputBounds[4] = {0};
                if (!obf_capture_bounds(handle, inputBounds, error, sizeof(error)) || inputBounds[0] != 110) {
                    fprintf(stderr,"FAIL input-only geometry retained stale origin: %s\n",error); result=1;
                } else puts("PASS input geometry updates after movement without copying or encoding a frame");
                uint8_t *movedBytes = NULL; size_t movedLength = 0;
                uint32_t movedWidth=0,movedHeight=0,movedWindow=0; uint64_t movedSequence=0; double movedBounds[4]={0};
                int moved = obf_capture_frame(handle,&movedBytes,&movedLength,&movedWidth,&movedHeight,&movedWindow,movedBounds,&movedSequence,error,sizeof(error));
                if (!moved || movedBounds[0] != 110) {
                    fprintf(stderr,"FAIL moved geometry not refreshed: %s\n",error); result=1;
                } else puts("PASS moved window returns the new coordinate basis");
                if(movedBytes) obf_capture_free(movedBytes);
                dispatch_sync(dispatch_get_main_queue(), ^{ [target setFrame:NSMakeRect(110,100,280,190) display:YES]; });
                [NSThread sleepForTimeInterval:0.15];
                movedBytes = NULL;
                int resized = obf_capture_frame(handle,&movedBytes,&movedLength,&movedWidth,&movedHeight,&movedWindow,movedBounds,&movedSequence,error,sizeof(error));
                if (!resized || movedWidth != 280 || movedHeight != 190 || movedBounds[2] != 280 || movedBounds[3] != 190) {
                    fprintf(stderr,"FAIL resized stream did not produce matching pixels: %s\n",error); result=1;
                } else puts("PASS resized window updates SCStream and waits for matching frame dimensions");
                if(movedBytes) obf_capture_free(movedBytes);
            }
            if (result == 0) {
                dispatch_sync(dispatch_get_main_queue(), ^{ if(minimize) [target miniaturize:nil]; else [target orderOut:nil]; target.backgroundColor = NSColor.greenColor; [target display]; });
                [NSThread sleepForTimeInterval:minimize ? 1.0 : 0.3];
                uint8_t *hiddenBytes = NULL; size_t hiddenLength = 0;
                uint32_t hiddenWidth=0,hiddenHeight=0,hiddenWindow=0; uint64_t hiddenSequence=0; double hiddenBounds[4]={0};
                int hidden = obf_capture_frame(handle,&hiddenBytes,&hiddenLength,&hiddenWidth,&hiddenHeight,&hiddenWindow,hiddenBounds,&hiddenSequence,error,sizeof(error));
                if (hidden) {
                    size_t center = ((hiddenHeight/2)*hiddenWidth+hiddenWidth/2)*4;
                    fprintf(stderr,"HIDDEN frame center after changing background to green: %u,%u,%u\n",hiddenBytes[center],hiddenBytes[center+1],hiddenBytes[center+2]);
                    result = 1;
                    obf_capture_free(hiddenBytes);
                } else if (!strstr(error,"TARGET_")) {
                    fprintf(stderr,"FAIL target invisibility returned an ambiguous state: %s\n",error); result=1;
                } else printf("PASS %s window returns explicit target unavailability\n",minimize ? "minimized" : "hidden");
                obf_capture_stop(handle);
                handle = NULL;
                dispatch_sync(dispatch_get_main_queue(), ^{ if(minimize) [target deminiaturize:nil]; [target orderFrontRegardless]; });
                [NSThread sleepForTimeInterval:1.0];
                expectedGeneration = 2;
                atomic_store(&stoppedWithIdentity, false);
                handle = obf_capture_start(getpid(), targetID, expectedGeneration, error, sizeof(error));
                if(!handle) { fprintf(stderr,"FAIL restored target restart: %s\n",error); result=1; }
            }
            if (result == 0) {
                dispatch_sync(dispatch_get_main_queue(), ^{ [target close]; });
                [NSThread sleepForTimeInterval:0.2];
                uint8_t *closedBytes = NULL; size_t closedLength = 0;
                uint32_t closedWidth=0,closedHeight=0,closedWindow=0; uint64_t closedSequence=0; double closedBounds[4]={0};
                int closed = obf_capture_frame(handle,&closedBytes,&closedLength,&closedWidth,&closedHeight,&closedWindow,closedBounds,&closedSequence,error,sizeof(error));
                if (closed || !atomic_load(&stoppedWithIdentity)) {
                    fprintf(stderr,"FAIL closed target did not revoke capture with its identity: %s\n",error); result=1;
                } else puts("PASS closed window revokes capture with its original generation and target");
                if(closedBytes) obf_capture_free(closedBytes);
            }
            obf_capture_stop(handle);
        }
        dispatch_async(dispatch_get_main_queue(), ^{ [target close]; [cover close]; exit(result); });
    });
    [app run];
} }
