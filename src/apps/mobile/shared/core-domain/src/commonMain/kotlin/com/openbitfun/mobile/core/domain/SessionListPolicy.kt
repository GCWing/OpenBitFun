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

/**
 * Names a session when the user did not type one.
 *
 * These are wire values, not UI copy: [wireSessionName] is what goes out as
 * `session_name`, and the desktop's `SessionCreated` carries no title back, so
 * [fallbackTitle] is what the list shows until the agent renames the session
 * itself. Both spellings are taken verbatim from `RemoteCommandFactory.createSession`
 * and `RemoteSessionManager.createSession` so the two clients produce sessions
 * that are indistinguishable on the desktop.
 */
public object SessionNaming {
    public fun wireSessionName(agentType: String, title: String): String {
        val trimmed = title.trim()
        if (trimmed.isNotEmpty()) return trimmed
        return when (bucket(agentType)) {
            AgentBucket.ASSISTANT -> "Remote Assistant Session"
            AgentBucket.COWORK -> "Remote Cowork Session"
            AgentBucket.CODE -> "Remote Code Session"
        }
    }

    public fun fallbackTitle(agentType: String): String = when (bucket(agentType)) {
        AgentBucket.ASSISTANT -> "Assistant Session"
        AgentBucket.COWORK -> "Cowork Session"
        AgentBucket.CODE -> "Code Session"
    }

    private enum class AgentBucket { ASSISTANT, COWORK, CODE }

    private fun bucket(agentType: String): AgentBucket = when (agentType.lowercase()) {
        "claw", "assistant", "chat" -> AgentBucket.ASSISTANT
        "cowork" -> AgentBucket.COWORK
        else -> AgentBucket.CODE
    }
}
