package com.openbitfun.mobile.app.ui.chat

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationScrollPolicyTest {
    @Test
    fun sticksWhenReaderIsAtTail() {
        assertTrue(
            ConversationScrollPolicy.shouldStickToBottom(
                currentlySticking = false,
                isAtBottom = true,
                isScrollInProgress = false,
            ),
        )
        assertTrue(ConversationScrollPolicy.shouldScrollToBottom(stickToBottom = true, hasRows = true))
    }

    @Test
    fun aDragTakesOverBeforeTheFirstMovementAwayFromTheTail() {
        assertFalse(ConversationScrollPolicy.shouldStickToBottom(
            currentlySticking = true, isAtBottom = true, isScrollInProgress = true,
        ))
    }

    @Test
    fun stopsStickingWhenReaderLeavesTail() {
        assertFalse(
            ConversationScrollPolicy.shouldStickToBottom(
                currentlySticking = true,
                isAtBottom = false,
                isScrollInProgress = true,
            ),
        )
    }

    @Test
    fun resumesAfterExplicitScrollToBottom() {
        assertTrue(
            ConversationScrollPolicy.shouldStickToBottom(
                currentlySticking = false,
                isAtBottom = true,
                isScrollInProgress = false,
            ),
        )
    }

    @Test
    fun doesNotScrollWhenDeltaArrivesWhileReaderIsScrolledUp() {
        assertFalse(
            ConversationScrollPolicy.shouldScrollToBottom(
                stickToBottom = false,
                hasRows = true,
            ),
        )
    }

    @Test
    fun lastItemIndexAccountsForTheLeadingHeader() {
        org.junit.Assert.assertEquals(2, ConversationScrollPolicy.lastItemIndex(rowCount = 3, hasLeadingItem = false))
        org.junit.Assert.assertEquals(3, ConversationScrollPolicy.lastItemIndex(rowCount = 3, hasLeadingItem = true))
        org.junit.Assert.assertEquals(0, ConversationScrollPolicy.lastItemIndex(rowCount = 0, hasLeadingItem = false))
        org.junit.Assert.assertEquals(0, ConversationScrollPolicy.lastItemIndex(rowCount = 0, hasLeadingItem = true))
    }
}
