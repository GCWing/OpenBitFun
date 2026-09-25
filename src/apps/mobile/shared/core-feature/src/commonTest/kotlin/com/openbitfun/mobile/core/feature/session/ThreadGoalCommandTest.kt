package com.openbitfun.mobile.core.feature.session

import kotlin.test.*

class ThreadGoalCommandTest {
    @Test fun wholeCommandAndControlBoundaries() {
        assertNull(parseThreadGoalCommand("/goalie hi"))
        assertNull(parseThreadGoalCommand("hello /goal"))
        assertEquals(ThreadGoalAction.OPEN to null, parseThreadGoalCommand(" /GOAL "))
        assertEquals(ThreadGoalAction.PAUSE to null, parseThreadGoalCommand("/goal pause"))
        assertEquals(ThreadGoalAction.START to "pause\nthen verify", parseThreadGoalCommand("/goal pause\nthen verify"))
        assertEquals(ThreadGoalAction.START to "objective", parseThreadGoalCommand("/goal\nobjective"))
    }
}
