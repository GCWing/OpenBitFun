package com.openbitfun.mobile.core.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SessionListPolicyTest {
    @Test
    fun codeCoversBothTheCurrentAndLegacyAgentSpelling() {
        assertTrue(SessionAgentTypes.isCode("code"))
        assertTrue(SessionAgentTypes.isCode("Agentic"))
        assertFalse(SessionAgentTypes.isCode("cowork"))
    }

    @Test
    fun coworkCoversOnlyCowork() {
        assertTrue(SessionAgentTypes.isCowork("Cowork"))
        assertFalse(SessionAgentTypes.isCowork("code"))
        assertFalse(SessionAgentTypes.isCowork(""))
    }

    @Test
    fun agentTypesTheDesktopMayAddBelongToNeitherBucket() {
        assertFalse(SessionAgentTypes.isCode("claw"))
        assertFalse(SessionAgentTypes.isCowork("claw"))
    }

    @Test
    fun acpSessionsStayOffNativeMobileSurfaces() {
        assertFalse(SessionAgentTypes.isMobileVisible("acp:codex"))
        assertFalse(SessionAgentTypes.isMobileVisible("  ACP:custom  "))
        assertTrue(SessionAgentTypes.isMobileVisible("code"))
    }

    @Test
    fun childSessionsStayOffTheFlatMobileList() {
        // Desktop's 侧问 keeps its own session, nested under the conversation it
        // was asked from. A flat list would show it as an unrelated thread.
        val parent = session(id = "parent")
        val child = session(id = "btw", parentSessionId = "parent", relationshipKind = "btw")

        assertTrue(SessionListVisibility.isMobileVisible(parent))
        assertFalse(SessionListVisibility.isMobileVisible(child))
        assertTrue(SessionListVisibility.isChild(child))
        assertFalse(SessionListVisibility.isChild(session(id = "blank", parentSessionId = "  ")))
        assertFalse(SessionListVisibility.isMobileVisible(session(id = "acp", agentType = "acp:codex")))
    }

    private fun session(
        id: String,
        agentType: String = "code",
        parentSessionId: String? = null,
        relationshipKind: String? = null,
    ) = RemoteSession(
        id = id,
        title = id,
        agentType = agentType,
        status = "idle",
        updatedAt = "",
        createdAt = "",
        messageCount = 0,
        workspacePath = null,
        workspaceName = null,
        workspaceIdentity = null,
        parentSessionId = parentSessionId,
        relationshipKind = relationshipKind,
    )

    @Test
    fun untitledSessionsGetTheAgentSpecificWireName() {
        assertEquals("Remote Code Session", SessionNaming.wireSessionName("code", "   "))
        assertEquals("Remote Cowork Session", SessionNaming.wireSessionName("cowork", ""))
        assertEquals("Remote Assistant Session", SessionNaming.wireSessionName("claw", ""))
        assertEquals("Remote Assistant Session", SessionNaming.wireSessionName("chat", ""))
    }

    @Test
    fun aTypedTitleWinsOverTheDefaultAndIsTrimmed() {
        assertEquals("Parser work", SessionNaming.wireSessionName("code", "  Parser work  "))
    }

    @Test
    fun fallbackTitleDropsTheRemotePrefixTheWireNameCarries() {
        assertEquals("Code Session", SessionNaming.fallbackTitle("code"))
        assertEquals("Cowork Session", SessionNaming.fallbackTitle("cowork"))
        assertEquals("Assistant Session", SessionNaming.fallbackTitle("assistant"))
    }
}
