package com.openbitfun.mobile.app.ui.chat

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HistoryPageArrivalTrackerTest {
    @Test fun layoutCannotRequestAndBounceCannotRearmTheSameGesture() {
        val tracker = HistoryPageArrivalTracker()
        assertFalse(tracker.arrived(true))
        tracker.beginGesture()
        assertFalse(tracker.arrived(false))
        assertTrue(tracker.arrived(true))
        repeat(10) {
            assertFalse(tracker.arrived(false))
            assertFalse(tracker.arrived(true))
        }
        tracker.beginGesture()
        assertTrue(tracker.arrived(true))
        tracker.cancelArrival()
        assertFalse(tracker.arrived(true))
    }
}
