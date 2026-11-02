// Independent, read-only foreground witness for any macOS control backend.
// Build: clang -fobjc-arc -fblocks -Wall -Wextra -Werror -framework AppKit \
//   -framework ApplicationServices computer-use-background-witness.m -o witness
// Run: witness --target-pid PID [--target-window ID] --output /tmp/witness.json
// SIGUSR1 requests a new baseline; wait for baseline.sequence to advance before
// an action. SIGTERM/SIGINT write the final observation and exit. No NSApplication,
// windows, activation, event posting, screenshots, or permission prompts are used.
// Window metadata is reduced to PIDs, IDs and stacking; titles are never read.

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

typedef AXError (*OBFAXWindowIDFunction)(AXUIElementRef, CGWindowID *);

static double monotonicSeconds(void) {
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC, &value);
    return value.tv_sec + value.tv_nsec / 1e9;
}

static BOOL writePrivateJSON(NSDictionary *value, NSString *path) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:value
        options:NSJSONWritingPrettyPrinted | NSJSONWritingSortedKeys error:&error];
    if (!data) {
        fprintf(stderr, "JSON serialization failed: %s\n", error.localizedDescription.UTF8String);
        return NO;
    }
    char *temporary = strdup([[path stringByAppendingString:@".XXXXXX"] fileSystemRepresentation]);
    int fd = mkstemp(temporary); // 0600 from creation; rename keeps the file private.
    BOOL ok = fd >= 0;
    size_t offset = 0;
    while (ok && offset < data.length) {
        ssize_t written = write(fd, (const char *)data.bytes + offset, data.length - offset);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) { ok = NO; break; }
        offset += (size_t)written;
    }
    if (fd >= 0 && close(fd) != 0) ok = NO;
    if (ok && rename(temporary, path.fileSystemRepresentation) != 0) ok = NO;
    if (!ok) {
        fprintf(stderr, "Cannot write witness output: %s\n", strerror(errno));
        unlink(temporary);
    }
    free(temporary);
    return ok;
}

static NSDictionary *focusedWindow(pid_t pid, OBFAXWindowIDFunction windowIDFunction) {
    if (!AXIsProcessTrusted()) return @{@"status": @"permission_denied", @"pid": @(pid), @"window_id": NSNull.null};
    if (pid <= 0) return @{@"status": @"no_frontmost_application", @"pid": @(pid), @"window_id": NSNull.null};
    if (!windowIDFunction) return @{@"status": @"window_id_api_unavailable", @"pid": @(pid), @"window_id": NSNull.null};
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    // AX runs off the sampling queue. A slow foreground app must not suppress
    // cursor/activation evidence. This timeout changes only this local AX client.
    AXUIElementSetMessagingTimeout(app, 0.02f);
    CFTypeRef window = NULL;
    AXError result = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &window);
    CGWindowID windowID = kCGNullWindowID;
    if (result == kAXErrorSuccess && window && CFGetTypeID(window) == AXUIElementGetTypeID()) {
        AXUIElementSetMessagingTimeout((AXUIElementRef)window, 0.02f);
        result = windowIDFunction((AXUIElementRef)window, &windowID);
    } else if (result == kAXErrorSuccess) {
        result = kAXErrorNoValue;
    }
    if (window) CFRelease(window);
    CFRelease(app);
    return @{@"status": result == kAXErrorSuccess && windowID != kCGNullWindowID ? @"available" : @"unknown",
             @"pid": @(pid), @"window_id": windowID ? @(windowID) : NSNull.null,
             @"ax_error": @(result)};
}

@interface OBFBackgroundWitness : NSObject
@property pid_t targetPID;
@property CGWindowID targetWindow;
@property NSString *outputPath;
@property double interval;
@property double duration;
@property double started;
@property double lastSample;
@property double lastFlush;
@property double maxSampleGap;
@property double pendingBaseline;
@property NSUInteger sampleCount;
@property NSUInteger lateSampleCount;
@property NSUInteger axSampleCount;
@property NSUInteger baselineSequence;
@property BOOL axInFlight;
@property BOOL stopping;
@property BOOL done;
@property BOOL writeFailed;
@property NSDictionary *initial;
@property NSDictionary *current;
@property NSDictionary *baseline;
@property NSDictionary *latestAX;
@property NSDictionary *previousState;
@property NSMutableArray *changes;
@property NSMutableArray *activations;
@property NSMutableArray *baselines;
@property NSMutableArray *samplingGaps;
@property id activationObserver;
@property dispatch_queue_t axQueue;
@property dispatch_source_t terminateSource;
@property dispatch_source_t interruptSource;
@property dispatch_source_t resetSource;
@property OBFAXWindowIDFunction windowIDFunction;
- (void)sample;
- (void)flush:(BOOL)finished;
- (void)requestStop;
@end

@implementation OBFBackgroundWitness
- (double)elapsedMilliseconds { return (monotonicSeconds() - self.started) * 1000.0; }

- (NSDictionary *)stackingForPID:(pid_t)frontPID focused:(NSDictionary *)focused {
    CFArrayRef raw = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
                                               kCGNullWindowID);
    if (!raw) return @{@"status": @"window_list_unavailable"};
    NSArray *windows = CFBridgingRelease(raw);
    NSNumber *focusedID = [focused[@"status"] isEqual:@"available"] ? focused[@"window_id"] : nil;
    NSInteger referenceIndex = -1, targetIndex = -1;
    CGWindowID referenceID = focusedID.unsignedIntValue;
    CGWindowID selectedTargetID = self.targetWindow;
    NSInteger referenceLayer = 0, targetLayer = 0;
    for (NSUInteger index = 0; index < windows.count; index++) {
        NSDictionary *entry = windows[index];
        pid_t pid = [entry[(id)kCGWindowOwnerPID] intValue];
        CGWindowID windowID = [entry[(id)kCGWindowNumber] unsignedIntValue];
        NSInteger layer = [entry[(id)kCGWindowLayer] integerValue];
        if (pid == frontPID && ((focusedID && windowID == focusedID.unsignedIntValue) ||
            (!focusedID && referenceIndex < 0 && layer == 0))) {
            referenceIndex = (NSInteger)index;
            referenceID = windowID;
            referenceLayer = layer;
        }
        if (pid == self.targetPID && ((self.targetWindow && windowID == self.targetWindow) ||
            (!self.targetWindow && targetIndex < 0 && layer == 0))) {
            targetIndex = (NSInteger)index;
            selectedTargetID = windowID;
            targetLayer = layer;
        }
    }
    NSString *relation = @"unknown";
    if (referenceIndex >= 0 && targetIndex >= 0) {
        relation = targetIndex < referenceIndex ? @"above" : (targetIndex > referenceIndex ? @"below" : @"same");
    }
    return @{@"status": @"available", @"reference_source": focusedID ? @"ax_focused_window" : @"frontmost_pid_first_layer_zero_window",
             @"reference_window_id": referenceID ? @(referenceID) : NSNull.null,
             @"reference_index": referenceIndex >= 0 ? @(referenceIndex) : NSNull.null,
             @"reference_layer": referenceIndex >= 0 ? @(referenceLayer) : NSNull.null,
             @"target_window_id": selectedTargetID ? @(selectedTargetID) : NSNull.null,
             @"target_index": targetIndex >= 0 ? @(targetIndex) : NSNull.null,
             @"target_layer": targetIndex >= 0 ? @(targetLayer) : NSNull.null,
             @"target_relative_to_reference": relation};
}

- (void)requestAXForPID:(pid_t)pid {
    if (self.axInFlight || self.stopping) return;
    self.axInFlight = YES;
    dispatch_async(self.axQueue, ^{
        @autoreleasepool {
            double began = [self elapsedMilliseconds];
            NSDictionary *focused = focusedWindow(pid, self.windowIDFunction);
            double completed = [self elapsedMilliseconds];
            dispatch_async(dispatch_get_main_queue(), ^{
                self.latestAX = @{@"started_ms": @(began), @"completed_ms": @(completed), @"focused_window": focused};
                self.axSampleCount++;
                self.axInFlight = NO;
                if (self.stopping) {
                    [self sample];
                    [self flush:YES];
                    self.done = YES;
                }
            });
        }
    });
}

- (void)sample {
    double now = monotonicSeconds();
    double elapsed = (now - self.started) * 1000.0;
    if (self.lastSample > 0) {
        double gap = now - self.lastSample;
        self.maxSampleGap = MAX(self.maxSampleGap, gap);
        if (gap > self.interval * 2.0) {
            self.lateSampleCount++;
            [self.samplingGaps addObject:@{@"from_ms": @((self.lastSample - self.started) * 1000.0),
                @"to_ms": @(elapsed), @"duration_ms": @(gap * 1000.0)}];
        }
    }
    self.lastSample = now;
    self.sampleCount++;
    pid_t frontPID = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    CGEventRef event = CGEventCreate(NULL);
    CGPoint cursor = event ? CGEventGetLocation(event) : CGPointMake(NAN, NAN);
    if (event) CFRelease(event);
    BOOL cursorAvailable = isfinite(cursor.x) && isfinite(cursor.y);
    NSDictionary *focused = self.latestAX[@"focused_window"];
    if (!focused || [focused[@"pid"] intValue] != frontPID) {
        focused = @{@"status": @"pending", @"pid": @(frontPID), @"window_id": NSNull.null};
    } else if (elapsed - [self.latestAX[@"completed_ms"] doubleValue] > 100.0) {
        focused = @{@"status": @"stale", @"pid": @(frontPID), @"window_id": NSNull.null};
    }
    NSDictionary *state = @{@"frontmost_pid": @(frontPID),
        @"cursor": @{@"status": cursorAvailable ? @"available" : @"unknown",
                     @"x": cursorAvailable ? @(cursor.x) : NSNull.null,
                     @"y": cursorAvailable ? @(cursor.y) : NSNull.null},
        @"focused_window": focused, @"stacking": [self stackingForPID:frontPID focused:focused]};
    self.current = @{@"monotonic_ms": @(elapsed), @"sample": @(self.sampleCount), @"state": state,
        @"ax_read_started_ms": self.latestAX[@"started_ms"] ?: NSNull.null,
        @"ax_read_completed_ms": self.latestAX[@"completed_ms"] ?: NSNull.null};
    if (!self.initial) self.initial = self.current;
    if (self.previousState && ![self.previousState isEqual:state]) {
        NSMutableArray *fields = [NSMutableArray array];
        for (NSString *key in @[@"frontmost_pid", @"cursor", @"focused_window", @"stacking"]) {
            if (![self.previousState[key] isEqual:state[key]]) [fields addObject:key];
        }
        [self.changes addObject:@{@"observation": self.current, @"changed_fields": fields}];
    }
    self.previousState = state;
    // A reset is acknowledged only after a new AX read started after the request.
    // The AX result may legitimately be unknown or permission_denied.
    if (self.pendingBaseline >= 0 && self.latestAX &&
        [self.latestAX[@"started_ms"] doubleValue] >= self.pendingBaseline &&
        [self.latestAX[@"focused_window"][@"pid"] intValue] == frontPID) {
        self.baselineSequence++;
        self.baseline = @{@"sequence": @(self.baselineSequence), @"requested_ms": @(self.pendingBaseline),
            @"observation": self.current, @"change_index": @(self.changes.count),
            @"activation_index": @(self.activations.count), @"sampling_gap_index": @(self.samplingGaps.count)};
        [self.baselines addObject:self.baseline];
        self.pendingBaseline = -1;
        [self flush:NO];
        printf("BASELINE %lu %.3f\n", (unsigned long)self.baselineSequence, elapsed);
        fflush(stdout);
    }
    [self requestAXForPID:frontPID];
    if (now - self.lastFlush >= 0.25) [self flush:NO];
}

- (void)flush:(BOOL)finished {
    NSDictionary *document = @{@"schema_version": @1, @"witness_pid": @(getpid()),
        @"target_pid": @(self.targetPID), @"target_window_id": self.targetWindow ? @(self.targetWindow) : NSNull.null,
        @"finished": @(finished), @"elapsed_ms": @([self elapsedMilliseconds]),
        @"permissions": @{@"accessibility_trusted": @(AXIsProcessTrusted()),
                          @"screen_recording_preflight": @(CGPreflightScreenCaptureAccess()),
                          @"permission_requested": @NO},
        @"availability": @{@"ax_window_id_function": @(self.windowIDFunction != NULL),
                           @"key_window_id": @"not_exposed_by_public_ax; focused_window_is_reported",
                           @"activation_notifications": @YES},
        @"sampling": @{@"requested_interval_ms": @(self.interval * 1000.0), @"samples": @(self.sampleCount),
                       @"ax_samples": @(self.axSampleCount), @"max_gap_ms": @(self.maxSampleGap * 1000.0),
                       @"gaps_over_twice_interval": @(self.lateSampleCount),
                       @"ax_stale_threshold_ms": @100},
        @"limits": @[@"Observations do not identify whether a change came from the user, a backend, or another process.",
                     @"Polling can miss changes between samples; AX reads and window-list reads are not atomic.",
                     @"AX focused window is asynchronous; read timestamps and unavailable states must be checked.",
                     @"Stacking describes listed on-screen windows, not visual occlusion or other Spaces.",
                     @"Without a supplied target window, the first on-screen layer-zero target window is used."],
        @"start": self.initial ?: (id)NSNull.null, @"current": self.current ?: (id)NSNull.null,
        @"baseline": self.baseline ?: (id)NSNull.null, @"baselines": self.baselines,
        @"changes": self.changes, @"activation_notifications": self.activations, @"sampling_gaps": self.samplingGaps};
    if (!writePrivateJSON(document, self.outputPath)) self.writeFailed = YES;
    self.lastFlush = monotonicSeconds();
}

- (void)requestStop {
    if (self.stopping) return;
    self.stopping = YES;
    if (!self.axInFlight) {
        [self sample];
        [self flush:YES];
        self.done = YES;
    }
}
@end

static dispatch_source_t signalSource(int value, dispatch_block_t handler) {
    signal(value, SIG_IGN);
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, (uintptr_t)value, 0,
                                                     dispatch_get_main_queue());
    dispatch_source_set_event_handler(source, handler);
    dispatch_resume(source);
    return source;
}

static BOOL parseNumber(const char *value, unsigned long long maximum, unsigned long long *result) {
    if (!value || !*value || *value == '-') return NO;
    char *end = NULL;
    errno = 0;
    unsigned long long parsed = strtoull(value, &end, 10);
    if (errno || !end || *end || !parsed || parsed > maximum) return NO;
    *result = parsed;
    return YES;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        OBFBackgroundWitness *witness = [OBFBackgroundWitness new];
        witness.interval = 0.01;
        witness.pendingBaseline = 0;
        for (int index = 1; index < argc; index++) {
            NSString *argument = @(argv[index]);
            if ([argument isEqual:@"--help"]) {
                puts("Usage: witness --target-pid PID [--target-window ID] --output PATH [--duration-ms MS] [--interval-ms MS]");
                puts("SIGUSR1: new baseline; SIGTERM/SIGINT: final output and clean exit. No UI or input is generated.");
                return 0;
            }
            if (index + 1 >= argc) { fprintf(stderr, "Missing argument value\n"); return 2; }
            const char *value = argv[++index];
            unsigned long long number = 0;
            if ([argument isEqual:@"--output"]) witness.outputPath = [@(value) stringByStandardizingPath];
            else if ([argument isEqual:@"--target-pid"] && parseNumber(value, INT_MAX, &number)) witness.targetPID = (pid_t)number;
            else if ([argument isEqual:@"--target-window"] && parseNumber(value, UINT32_MAX, &number)) witness.targetWindow = (CGWindowID)number;
            else if ([argument isEqual:@"--duration-ms"] && parseNumber(value, UINT_MAX, &number)) witness.duration = number / 1000.0;
            else if ([argument isEqual:@"--interval-ms"] && parseNumber(value, 1000, &number) && number >= 5) witness.interval = number / 1000.0;
            else { fprintf(stderr, "Invalid argument: %s\n", argument.UTF8String); return 2; }
        }
        if (!witness.targetPID || !witness.outputPath.length) {
            fprintf(stderr, "--target-pid and --output are required; see --help\n");
            return 2;
        }
        witness.started = monotonicSeconds();
        witness.changes = [NSMutableArray array];
        witness.activations = [NSMutableArray array];
        witness.baselines = [NSMutableArray array];
        witness.samplingGaps = [NSMutableArray array];
        witness.axQueue = dispatch_queue_create("org.openbitfun.background-witness.ax", DISPATCH_QUEUE_SERIAL);
        witness.windowIDFunction = (OBFAXWindowIDFunction)dlsym(RTLD_DEFAULT, "_AXUIElementGetWindow");
        witness.activationObserver = [NSWorkspace.sharedWorkspace.notificationCenter
            addObserverForName:NSWorkspaceDidActivateApplicationNotification object:nil queue:NSOperationQueue.mainQueue
            usingBlock:^(NSNotification *notification) {
                NSRunningApplication *application = notification.userInfo[NSWorkspaceApplicationKey];
                [witness.activations addObject:@{@"monotonic_ms": @([witness elapsedMilliseconds]),
                    @"activated_pid": @(application.processIdentifier),
                    @"sampled_frontmost_pid": @(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)}];
            }];
        witness.terminateSource = signalSource(SIGTERM, ^{ [witness requestStop]; });
        witness.interruptSource = signalSource(SIGINT, ^{ [witness requestStop]; });
        witness.resetSource = signalSource(SIGUSR1, ^{
            if (!witness.stopping) witness.pendingBaseline = [witness elapsedMilliseconds];
        });
        [witness sample];
        [witness flush:NO];
        if (witness.writeFailed) return 1;
        NSTimer *timer = [NSTimer scheduledTimerWithTimeInterval:witness.interval repeats:YES block:^(NSTimer *unused) {
            (void)unused;
            if (!witness.stopping) [witness sample];
            if (witness.duration > 0 && monotonicSeconds() - witness.started >= witness.duration) [witness requestStop];
        }];
        timer.tolerance = 0;
        while (!witness.done) {
            @autoreleasepool {
                [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
            }
        }
        [timer invalidate];
        [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:witness.activationObserver];
        dispatch_source_cancel(witness.terminateSource);
        dispatch_source_cancel(witness.interruptSource);
        dispatch_source_cancel(witness.resetSource);
        return witness.writeFailed ? 1 : 0;
    }
}
