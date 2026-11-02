// Pure presentation math, in target-window coordinates. No input or OS APIs.
// Inspired by open-computer-use's separation of the displayed tip, destination
// and retained spring velocity (CursorMotionModel.swift / SoftwareCursorOverlay.swift).
// Use the closed-form critically damped spring so timer jitter never changes
// the trajectory, and a late frame catches up without a backlog of fixed steps.
#ifndef OBF_POINTER_MOTION_H
#define OBF_POINTER_MOTION_H

#include <math.h>
#include <stdbool.h>

typedef struct {
    double x, y;
    double velocityX, velocityY;
    double targetX, targetY;
} OBFPointerMotion;

static inline void obf_pointer_motion_snap(OBFPointerMotion *motion, double x, double y) {
    *motion = (OBFPointerMotion){.x = x, .y = y, .targetX = x, .targetY = y};
}

static inline bool obf_pointer_motion_active(const OBFPointerMotion *motion) {
    return motion->x != motion->targetX || motion->y != motion->targetY ||
        motion->velocityX != 0 || motion->velocityY != 0;
}

static inline void obf_pointer_motion_axis(double *value, double *velocity, double target, double dt) {
    // A 0.26s response: short moves settle quickly, longer ones decelerate over
    // more frames. Critical damping avoids bouncing past a small click target.
    const double omega = 2 * 3.14159265358979323846 / 0.26;
    double displacement = *value - target;
    double coefficient = *velocity + omega * displacement;
    double decay = exp(-omega * dt);
    *value = target + (displacement + coefficient * dt) * decay;
    *velocity = (*velocity - omega * coefficient * dt) * decay;
}

static inline void obf_pointer_motion_advance(OBFPointerMotion *motion, double dt) {
    if (!isfinite(dt) || dt <= 0) return;
    obf_pointer_motion_axis(&motion->x, &motion->velocityX, motion->targetX, dt);
    obf_pointer_motion_axis(&motion->y, &motion->velocityY, motion->targetY, dt);
    if (hypot(motion->x - motion->targetX, motion->y - motion->targetY) < 0.05 &&
        hypot(motion->velocityX, motion->velocityY) < 0.5) {
        obf_pointer_motion_snap(motion, motion->targetX, motion->targetY);
    }
}

static inline void obf_pointer_motion_retarget(OBFPointerMotion *motion, double x, double y) {
    // Retain both position and velocity, including when a destination repeats.
    motion->targetX = x;
    motion->targetY = y;
}

#endif
