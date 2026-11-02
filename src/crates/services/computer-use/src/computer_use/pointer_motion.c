#include "pointer_motion.h"

// Windows' Rust renderer uses the same presentation math as AppKit.
void obf_pointer_motion_step(OBFPointerMotion *motion, double dt) {
    obf_pointer_motion_advance(motion, dt);
}
