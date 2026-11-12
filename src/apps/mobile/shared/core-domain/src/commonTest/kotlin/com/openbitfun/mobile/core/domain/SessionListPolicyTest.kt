package com.openbitfun.mobile.core.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
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

    @Test
    fun legacyConstructorsKeepTopLevelSessionsAndWorkspaceOwnership() {
        val local = RemoteWorkspaceIdentity("/repo", null, null)
        val ssh = RemoteWorkspaceIdentity("/repo", "connection", "host", "ssh-workspace")
        val legacy = RemoteSession("legacy", "Legacy", "code", "idle", "", "", 0, "/repo", null)
        val scoped = RemoteSession("scoped", "Scoped", "code", "idle", "", "", 0, "/repo", null,
            workspaceIdentity = ssh)

        for (row in listOf(legacy, scoped)) {
            assertNull(row.parentSessionId)
            assertNull(row.relationshipKind)
            assertTrue(SessionListVisibility.isMobileVisible(row))
        }
        assertNull(legacy.workspaceIdentity)
        assertTrue(legacy.belongsTo(local, listOf(local)))
        assertFalse(legacy.belongsTo(ssh, listOf(local, ssh)))
        assertEquals(ssh, scoped.workspaceIdentity)
        assertTrue(scoped.belongsTo(ssh, listOf(local, ssh)))
        assertFalse(scoped.belongsTo(local, listOf(local, ssh)))
    }

    @Test
    fun parentOnlyConstructorKeepsChildrenHiddenWithoutInventingARelationshipKind() {
        val child = RemoteSession("child", "Child", "code", "idle", "", "", 0, "/repo", null,
            workspaceIdentity = null, parentSessionId = "parent")

        assertEquals("parent", child.parentSessionId)
        assertNull(child.relationshipKind)
        assertFalse(SessionListVisibility.isMobileVisible(child))
        assertFalse(SessionListVisibility.isMobileVisible(child.copy(title = "Renamed")))
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
    fun untitledSessionsDelegateNamingToTheHost() {
        assertEquals("", SessionNaming.wireSessionName("code", "   "))
        assertEquals("", SessionNaming.wireSessionName("cowork", ""))
        assertEquals("", SessionNaming.wireSessionName("claw", ""))
        assertEquals("", SessionNaming.wireSessionName("chat", ""))
    }

    @Test
    fun aTypedTitleWinsOverTheDefaultAndIsTrimmed() {
        assertEquals("Parser work", SessionNaming.wireSessionName("code", "  Parser work  "))
    }

    @Test
    fun fallbackTitleIsIndependentOfMode() {
        assertEquals("New Session", SessionNaming.fallbackTitle("code"))
        assertEquals("New Session", SessionNaming.fallbackTitle("cowork"))
        assertEquals("New Session", SessionNaming.fallbackTitle("assistant"))
    }
}
