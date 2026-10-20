// The production presentation model can be verified without a desktop session.
#include "../../src/apps/desktop/src/computer_use/pointer_motion.h"
#include <assert.h>
#include <stdio.h>

int main(void) {
    OBFPointerMotion motion;
    obf_pointer_motion_snap(&motion, 100, 80);
    obf_pointer_motion_retarget(&motion, 1000, 700);
    OBFPointerMotion partitioned = motion;
    obf_pointer_motion_advance(&motion, 0.125);
    for (int frame = 0; frame < 15; ++frame) obf_pointer_motion_advance(&partitioned, 1.0 / 120);
    assert(fabs(motion.x - partitioned.x) < 1e-9);
    assert(fabs(motion.y - partitioned.y) < 1e-9);
    assert(fabs(motion.velocityX - partitioned.velocityX) < 1e-8);
    assert(motion.x > 100 && motion.x < 1000);

    // Reversal starts exactly where it was displayed, preserving momentum.
    double x = motion.x, y = motion.y, vx = motion.velocityX, vy = motion.velocityY;
    obf_pointer_motion_retarget(&motion, 30, 60);
    assert(motion.x == x && motion.y == y && motion.velocityX == vx && motion.velocityY == vy);
    obf_pointer_motion_advance(&motion, 0.001);
    assert(fabs(motion.x - x) < 5 && fabs(motion.y - y) < 5);
    assert(motion.velocityX > 0); // No instantaneous sign flip.
    partitioned = motion;
    obf_pointer_motion_retarget(&motion, 30, 60); // Repeated updates do not restart.
    obf_pointer_motion_advance(&motion, 0.05);
    obf_pointer_motion_advance(&partitioned, 0.05);
    assert(motion.x == partitioned.x && motion.velocityX == partitioned.velocityX);
    obf_pointer_motion_advance(&motion, 3); // Suspended frame catches up, not a backlog.
    assert(motion.x == 30 && motion.y == 60 && !obf_pointer_motion_active(&motion));

    // Starting at rest never overshoots; tiny moves and negative desktop
    // coordinates converge as well as a long move across a high-DPI display.
    const double distances[] = {0.1, 80, 1600, -2400};
    for (unsigned int i = 0; i < sizeof(distances) / sizeof(distances[0]); ++i) {
        obf_pointer_motion_snap(&motion, 0, 0);
        obf_pointer_motion_retarget(&motion, distances[i], -distances[i]);
        for (int frame = 0; frame < 240; ++frame) {
            obf_pointer_motion_advance(&motion, 1.0 / 120);
            assert(motion.x / distances[i] >= 0 && motion.x / distances[i] <= 1);
        }
        assert(motion.x == distances[i] && motion.y == -distances[i]);
        assert(!obf_pointer_motion_active(&motion));
    }
    puts("PASS native pointer frame invariance, interruption, repetition, suspension and convergence");
    return 0;
}
