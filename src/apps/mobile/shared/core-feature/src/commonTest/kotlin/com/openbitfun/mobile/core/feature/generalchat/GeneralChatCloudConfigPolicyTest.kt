package com.openbitfun.mobile.core.feature.generalchat

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The desktop's settings document, as this client has to survive it.
 *
 * Written as whole payloads rather than as builders because the thing under test
 * is a contract with another product's file format — a helper that assembles a
 * "valid" model would encode this side's belief about the shape and then test it
 * against itself.
 */
class GeneralChatCloudConfigPolicyTest {
    @Test
    fun keepsTheModelsThisPhoneCouldActuallyUse() {
        val models = GeneralChatCloudConfigPolicy.models(
            payload(
                model("m1", "openai", "gpt", "https://api.openai.com", "sk-1"),
                model("m2", "openai", "gpt", "https://api.openai.com", "sk-2", enabled = false),
                model("m3", "openai", "gpt", "https://api.openai.com", ""),
                model("m4", "openai", "gpt", "", "sk-4"),
                model("m5", "openai", "", "https://api.openai.com", "sk-5"),
                model("m6", "openai", "gpt", "https://api.openai.com", "sk-6", auth = "subscription"),
            ),
        )

        assertEquals(listOf("cloud:m1"), models.map { it.modelId })
    }

    @Test
    fun putsTheAccountsOwnDefaultFirstThenGeneralChat() {
        val models = GeneralChatCloudConfigPolicy.models(
            payload(
                model("plain", "openai", "gpt", "https://api.openai.com", "sk"),
                model("chat", "openai", "gpt", "https://api.openai.com", "sk", category = "general_chat"),
                model("primary", "openai", "gpt", "https://api.openai.com", "sk"),
                primary = "primary",
            ),
        )

        assertEquals(listOf("cloud:primary", "cloud:chat", "cloud:plain"), models.map { it.modelId })
    }

    @Test
    fun listsEachModelOnce() {
        // The primary is also a general-chat model, so two of the three passes
        // reach it; a phone that showed it twice would let the user "switch" to
        // the model they are already on.
        val models = GeneralChatCloudConfigPolicy.models(
            payload(
                model("both", "openai", "gpt", "https://api.openai.com", "sk", category = "general_chat"),
                primary = "both",
            ),
        )

        assertEquals(listOf("cloud:both"), models.map { it.modelId })
    }

    @Test
    fun appendsAnthropicsMessagesPathButLeavesTheRelayAlone() {
        val models = GeneralChatCloudConfigPolicy.models(
            payload(
                model("a", "anthropic", "sonnet", "https://api.anthropic.com/", "sk"),
                model("b", "anthropic", "sonnet", "https://api.anthropic.com/v1/messages", "sk"),
                model("c", "anthropic", "sonnet", "https://remote.openbitfun.com/relay?v=1.0.9", "sk"),
                model("d", "openai", "gpt", "https://api.openai.com/", "sk"),
            ),
        )

        assertEquals(
            listOf(
                "https://api.anthropic.com/v1/messages",
                "https://api.anthropic.com/v1/messages",
                // The version travels as a GET parameter, so no path may ever be
                // appended after it: the relay answers its own route.
                "https://remote.openbitfun.com/relay?v=1.0.9",
                "https://api.openai.com",
            ),
            models.map { it.apiUrl },
        )
    }

    @Test
    fun namesAModelAfterWhateverItHas() {
        val models = GeneralChatCloudConfigPolicy.models(
            payload(
                model("", "openai", "gpt-4o", "https://api.openai.com", "sk"),
                model("named", "", "gpt-4o", "https://api.openai.com", "sk", name = "Work"),
            ),
        )

        assertEquals(listOf("cloud:openai:gpt-4o", "cloud:named"), models.map { it.modelId })
        assertEquals(listOf("gpt-4o", "Work"), models.map { it.name })
        assertEquals(listOf("openai", "account"), models.map { it.provider })
    }

    @Test
    fun readsTheOlderTopLevelAiKey() {
        val models = GeneralChatCloudConfigPolicy.models(
            """{"ai":{"models":[${model("m", "openai", "gpt", "https://api.openai.com", "sk")}]}}""",
        )

        assertEquals(listOf("cloud:m"), models.map { it.modelId })
    }

    @Test
    fun survivesADocumentItCannotRead() {
        listOf(
            "",
            "not json",
            "[]",
            "{}",
            """{"config":{}}""",
            """{"config":{"ai":{"models":"nope"}}}""",
            """{"config":{"ai":{"models":[{"enabled":"yes"}]}}}""",
        ).forEach { payload ->
            assertTrue(GeneralChatCloudConfigPolicy.models(payload).isEmpty(), payload)
        }
    }

    @Test
    fun keepsTheApiKeyOutOfItsOwnDescription() {
        val model = GeneralChatCloudConfigPolicy.models(
            payload(model("m", "openai", "gpt", "https://api.openai.com", "sk-secret")),
        ).single()

        assertEquals("sk-secret", model.apiKey)
        assertTrue("sk-secret" !in model.toString(), model.toString())
    }

    private fun payload(vararg models: String, primary: String = ""): String {
        val defaults = if (primary.isEmpty()) "" else ""","default_models":{"primary":"$primary"}"""
        return """{"config":{"ai":{"models":[${models.joinToString(",")}]$defaults}}}"""
    }

    private fun model(
        id: String,
        provider: String,
        modelName: String,
        baseUrl: String,
        apiKey: String,
        enabled: Boolean = true,
        name: String = "",
        category: String = "",
        auth: String = "",
    ): String = buildString {
        append("""{"id":"$id","provider":"$provider","model_name":"$modelName"""")
        append(""","base_url":"$baseUrl","api_key":"$apiKey","enabled":$enabled""")
        if (name.isNotEmpty()) append(""","name":"$name"""")
        if (category.isNotEmpty()) append(""","category":"$category"""")
        if (auth.isNotEmpty()) append(""","auth":{"type":"$auth"}""")
        append("}")
    }
}
