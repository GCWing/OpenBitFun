package com.openbitfun.mobile.core.domain

/**
 * What the desktop's `agent_type` strings mean.
 *
 * `agentic` is the legacy spelling of `code` and must keep matching, otherwise
 * older sessions vanish from the Code tab. Ported from `normalizedSessionFilter`
 * and `agentMatchesFilter` in `services/RemoteSessionManager.ets`.
 */
public object SessionAgentTypes {
    public fun isCode(agentType: String): Boolean {
        val normalized = agentType.lowercase()
        return normalized in setOf("code", "agentic", "minimal", "ultra")
    }

    public fun isCowork(agentType: String): Boolean = agentType.lowercase() == "cowork"

    /**
     * The three spellings the desktop has used for a plain chat session.
     *
     * Kept beside the other two because a session that is none of these is a
     * code session by default, and that default only reads correctly if every
     * exception to it lives in one place. Same list as
     * `RemoteSessionList.ets#isAssistantSession`.
     */
    public fun isAssistant(agentType: String): Boolean =
        agentType.lowercase() in setOf("claw", "assistant", "chat")

    /**
     * ACP sessions are owned by Desktop integrations and cannot be controlled
     * by any native mobile surface. Keep this beside the other agent-type
     * semantics so Android and iOS cannot drift on the same relay page.
     */
    public fun isMobileVisible(agentType: String): Boolean =
        !agentType.trim().lowercase().startsWith("acp:")
}

/**
 * Which sessions belong in a flat mobile session list.
 *
 * Desktop renders child sessions (its 侧问 / review / mini app / subagent) nested
 * under the conversation they were asked from. Mobile has no nesting yet, so a
 * child would otherwise read as an unrelated standalone conversation.
 */
public object SessionListVisibility {
    public fun isMobileVisible(session: RemoteSession): Boolean =
        SessionAgentTypes.isMobileVisible(session.agentType) && !isChild(session)

    public fun isChild(session: RemoteSession): Boolean =
        !session.parentSessionId.isNullOrBlank()
}

/**
 * Workspace paths as identity, from `ConversationSessionFilterPolicy`.
 *
 * The desktop sends the same workspace with and without its trailing separator
 * depending on which command answered, so comparing the raw strings loses
 * sessions from their own project group.
 */
public object SessionWorkspacePaths {
    public fun equal(left: String, right: String): Boolean = normalize(left) == normalize(right)

    public fun normalize(path: String): String {
        var value = path.trim()
        while (value.length > 1 && (value.endsWith('/') || value.endsWith('\\'))) {
            value = value.dropLast(1)
        }
        return value
    }

    /** The last segment, for naming a workspace the desktop sent no name for. */
    public fun basename(path: String): String = normalize(path).substringAfterLast('/')
}

/** Blank wire names delegate the default to the owning host; custom names stay literal. */
public object SessionNaming {
    @Suppress("UNUSED_PARAMETER")
    public fun wireSessionName(agentType: String, title: String): String = title.trim()

    /** Compatibility placeholder until a host title is received. */
    @Suppress("UNUSED_PARAMETER")
    public fun fallbackTitle(agentType: String): String = "New Session"
}
