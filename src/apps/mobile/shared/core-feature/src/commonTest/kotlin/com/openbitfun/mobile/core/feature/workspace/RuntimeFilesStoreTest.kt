package com.openbitfun.mobile.core.feature.workspace

import com.openbitfun.mobile.core.crypto.ContentHash
import com.openbitfun.mobile.core.protocol.*
import com.openbitfun.mobile.core.transport.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.*
import kotlin.test.*

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class RuntimeFilesStoreTest {
    @Test fun lateReadCannotReplaceFilesFromAnotherSshWorkspace() = runTest {
        val host = FileHost(); val store = RuntimeFilesStore(this, host)
        store.browse("/repo", "/repo", "ssh-a", false); advanceUntilIdle()
        var pending: kotlin.coroutines.Continuation<Unit>? = null
        host.beforeReply = { command ->
            if (command.command == "read_file_content") kotlin.coroutines.suspendCoroutine<Unit> { pending = it }
        }
        store.read("/repo/file"); advanceUntilIdle()
        store.browse("/repo", "/repo", "ssh-b", false); advanceUntilIdle()
        val replacement = store.state.value
        pending!!.resumeWith(Result.success(Unit)); advanceUntilIdle()
        assertEquals(replacement, store.state.value)
        assertNull(store.state.value.file)
        val request = host.commands.last().args!!.jsonObject.getValue("request").jsonObject
        assertEquals("ssh-b", request.getValue("remoteConnectionId").jsonPrimitive.content)
    }

    @Test fun cancelledUploadBeforeDispatchClosesItsSourceWithoutSending() = runTest {
        val host = FileHost(); val store = RuntimeFilesStore(this, host)
        store.browse("/repo", "/repo", "saved", false); advanceUntilIdle()
        var closes = 0
        store.upload("/repo/new", object : RuntimeUploadSource {
            override val size = 0L
            override fun read(offset: Long, length: Int): ByteArray = error("Cancelled source must not be read")
            override fun close() { closes++ }
        })
        store.reset(); advanceUntilIdle()
        assertEquals(1, closes)
        assertTrue(host.commands.none { it.command == "workspace_file_upload" })
        assertFalse(store.state.value.busy)
    }

    @Test fun binaryUploadUsesBoundedReadsAndRecoversLostAcknowledgement() = runTest {
        val bytes = ByteArray(7 * 1024 * 1024 + 13) { 37 }
        var begins = 0; var finishes = 0; var maxRead = 0; var closed = 0; var offset = 0L; var lost = false; var completed = false
        val copied = mutableListOf<Byte>()
        val host = object : RemoteCommandTransport {
            override suspend fun <T : CommandStatus> send(deserializer: DeserializationStrategy<T>, command: RemoteCommand, timeoutMs: Long): T {
                val request = command.args!!.jsonObject.getValue("request").jsonObject
                val value = if (command.command == "get_directory_children_paginated") """{"children":[],"hasMore":false}""" else {
                    assertEquals("saved", request.getValue("remoteConnectionId").jsonPrimitive.content)
                    when (request.getValue("action").jsonPrimitive.content) {
                        "begin" -> { begins++; error("Begin ACK lost") }
                        "append" -> {
                            assertEquals(offset, request.getValue("offset").jsonPrimitive.long)
                            val chunk = kotlin.io.encoding.Base64.decode(request.getValue("contentBase64").jsonPrimitive.content)
                            copied.addAll(chunk.toList()); offset += chunk.size
                            if (!lost) { lost = true; error("ACK lost") }
                        }
                        "finish" -> { finishes++; completed = true; error("Finish ACK lost") }
                    }
                    """{"transferId":${request.getValue("transferId")},"totalBytes":${bytes.size},"nextOffset":$offset,"completed":$completed}"""
                }
                return RelayJson.decodeFromString(deserializer, """{"resp":"host_invoke_result","ok":true,"value":$value}""")
            }
        }
        val store = RuntimeFilesStore(this, host)
        store.browse("/repo", "/repo", "saved", false); advanceUntilIdle()
        store.upload("/repo/new", object : RuntimeUploadSource {
            override val size = bytes.size.toLong()
            override fun read(offset: Long, length: Int): ByteArray { maxRead = maxOf(maxRead, length); return bytes.copyOfRange(offset.toInt(), offset.toInt() + length) }
            override fun close() { closed++ }
        })
        // File adapter reads run on Dispatchers.Default, outside the virtual clock.
        while (store.state.value.busy) { kotlinx.coroutines.delay(1); testScheduler.runCurrent() }
        assertEquals(1, begins); assertEquals(1, finishes); assertFalse(store.state.value.failed); assertTrue(completed); assertEquals(1, closed)
        assertTrue(maxRead <= 3 * 1024 * 1024); assertContentEquals(bytes, copied.toByteArray())
    }

    @Test fun completedUploadWithShortFinalCursorIsNotSuccess() = runTest {
        var closed = 0
        var listings = 0
        val host = object : RemoteCommandTransport {
            override suspend fun <T : CommandStatus> send(deserializer: DeserializationStrategy<T>, command: RemoteCommand, timeoutMs: Long): T {
                val request = command.args!!.jsonObject.getValue("request").jsonObject
                val value = if (command.command == "get_directory_children_paginated") {
                    listings++
                    """{"children":[],"hasMore":false}"""
                } else {
                    val action = request.getValue("action").jsonPrimitive.content
                    val offset = if (action == "append") 1 else 0
                    """{"transferId":${request.getValue("transferId")},"totalBytes":1,"nextOffset":$offset,"completed":${action == "finish"}}"""
                }
                return RelayJson.decodeFromString(deserializer, """{"resp":"host_invoke_result","ok":true,"value":$value}""")
            }
        }
        val store = RuntimeFilesStore(this, host)
        store.browse("/repo", "/repo", null, false); advanceUntilIdle()
        store.upload("/repo/new", object : RuntimeUploadSource {
            override val size = 1L
            override fun read(offset: Long, length: Int) = byteArrayOf(42)
            override fun close() { closed++ }
        })
        while (store.state.value.busy) { kotlinx.coroutines.delay(1); testScheduler.runCurrent() }
        assertTrue(store.state.value.failed)
        assertEquals(1, listings)
        assertEquals(1, closed)
    }

    @Test fun fileWritesUseRuntimeScopeAndOriginalHashAndFailuresPreserveContent() = runTest {
        val host = FileHost(); val store = RuntimeFilesStore(this, host)
        store.browse("/repo", "/repo", "saved-ssh", false); advanceUntilIdle()
        store.read("/repo/file"); advanceUntilIdle()
        store.save("changed"); advanceUntilIdle()
        val write = host.commands.last().args!!.jsonObject.getValue("request").jsonObject
        assertEquals("saved-ssh", write.getValue("remoteConnectionId").jsonPrimitive.content)
        assertEquals(ContentHash.sha256("original"), write.getValue("expectedHash").jsonPrimitive.content)
        host.accepted = false
        store.save("conflict"); advanceUntilIdle()
        assertTrue(store.state.value.failed); assertEquals("changed", store.state.value.content)
        host.accepted = true
        store.renameFile("/repo/renamed"); advanceUntilIdle(); assertEquals("/repo/renamed", store.state.value.file)
        store.deleteFile(); advanceUntilIdle(); assertNull(store.state.value.file)
        store.createFile("/repo/new"); advanceUntilIdle()
        assertEquals("", host.commands.last().args!!.jsonObject.getValue("request").jsonObject.getValue("expectedHash").jsonPrimitive.content)
        store.reset(); store.save("stale"); advanceUntilIdle(); assertTrue(store.state.value.failed)
    }
    @Test fun hostFailureDetailSurvivesWithoutChangingRevisionAndLegacyFailureUsesFallback() = runTest {
        val host = FileHost(); val store = RuntimeFilesStore(this, host)
        store.browse("/repo", "/repo", "saved-ssh", false); advanceUntilIdle()
        store.read("/repo/file"); advanceUntilIdle()
        host.accepted = false
        host.errorDetail = "FILE_CONFLICT: File changed after it was read; refresh before saving"
        store.save("unsaved draft"); advanceUntilIdle()
        assertEquals(host.errorDetail, store.state.value.errorDetail)
        assertTrue(store.state.value.saveConflict)
        assertTrue(store.state.value.failed)
        assertEquals("/repo/file", store.state.value.file)
        assertEquals("original", store.state.value.content)
        host.errorDetail = null // Old hosts may omit the optional error field entirely.
        store.save("retry draft")
        assertNull(store.state.value.errorDetail)
        assertFalse(store.state.value.saveConflict)
        advanceUntilIdle()
        assertTrue(store.state.value.failed)
        assertNull(store.state.value.errorDetail)
        val write = host.commands.last().args!!.jsonObject.getValue("request").jsonObject
        assertEquals(ContentHash.sha256("original"), write.getValue("expectedHash").jsonPrimitive.content)
        host.accepted = true
        store.save("saved"); advanceUntilIdle()
        assertFalse(store.state.value.failed)
        assertNull(store.state.value.errorDetail)
        assertEquals("saved", store.state.value.content)
    }

    @Test fun sortingResetsServerPageAndClosingEditorPreservesDirectory() = runTest {
        val host = FileHost(); val store = RuntimeFilesStore(this, host)
        store.browse("/repo/sub", "/repo", "saved-ssh", false); advanceUntilIdle()
        for ((sort, by, order) in listOf(Triple(RuntimeFileSort.NAME_ASC, "name", "asc"), Triple(RuntimeFileSort.NAME_DESC, "name", "desc"), Triple(RuntimeFileSort.MODIFIED_DESC, "modified", "desc"), Triple(RuntimeFileSort.MODIFIED_ASC, "modified", "asc"))) {
            store.sort(sort); advanceUntilIdle()
            val request = host.commands.last().args!!.jsonObject.getValue("request").jsonObject
            assertEquals(by, request.getValue("sortBy").jsonPrimitive.content)
            assertEquals(order, request.getValue("sortOrder").jsonPrimitive.content)
            assertEquals(0, request.getValue("offset").jsonPrimitive.int)
            assertEquals("saved-ssh", request.getValue("remoteConnectionId").jsonPrimitive.content)
            assertEquals(sort, store.state.value.sort)
        }
        store.read("/repo/sub/file"); advanceUntilIdle(); store.closeFile()
        assertNull(store.state.value.file); assertEquals("/repo/sub", store.state.value.directory)
        assertEquals(RuntimeFileSort.MODIFIED_ASC, store.state.value.sort)
    }
    @Test fun listActionsUseSelectedSshAndRefreshSortedDirectoryWithoutOpeningEditor() = runTest {
        val host = FileHost(); val store = RuntimeFilesStore(this, host)
        host.children = """[{"path":"/repo/folder","name":"folder","isDirectory":true}]"""
        store.browse("/repo", "/repo", "saved-ssh", false, RuntimeFileSort.MODIFIED_DESC); advanceUntilIdle()
        store.renameEntry("/repo/folder", "renamed"); advanceUntilIdle()
        val rename = host.commands.first { it.command == "rename_file" }.args!!.jsonObject.getValue("request").jsonObject
        assertEquals("/repo/folder", rename.getValue("oldPath").jsonPrimitive.content)
        assertEquals("/repo/renamed", rename.getValue("newPath").jsonPrimitive.content)
        store.deleteEntry("/repo/folder"); advanceUntilIdle()
        val delete = host.commands.first { it.command == "delete_directory" }.args!!.jsonObject.getValue("request").jsonObject
        assertFalse(delete.getValue("recursive").jsonPrimitive.boolean)
        store.createEntry("new.txt", false); advanceUntilIdle()
        val create = host.commands.first { it.command == "write_file_content" }.args!!.jsonObject.getValue("request").jsonObject
        assertEquals("/repo/new.txt", create.getValue("filePath").jsonPrimitive.content)
        assertEquals("", create.getValue("expectedHash").jsonPrimitive.content)
        assertNull(store.state.value.file)
        assertEquals(RuntimeFileSort.MODIFIED_DESC, store.state.value.sort)
        assertEquals(4, host.commands.count { it.command == "get_directory_children_paginated" })
        for (command in host.commands) assertEquals("saved-ssh", command.args!!.jsonObject.getValue("request").jsonObject.getValue("remoteConnectionId").jsonPrimitive.content)
    }

    @Test fun failedListMutationPreservesEntriesAndStaleRowsDoNotSendDeletes() = runTest {
        val host = FileHost(); val store = RuntimeFilesStore(this, host)
        host.children = """[{"path":"/repo/file","name":"file","isDirectory":false}]"""
        store.browse("/repo", "/repo", null, false); advanceUntilIdle()
        val entries = store.state.value.entries
        host.accepted = false
        store.deleteEntry("/repo/file"); advanceUntilIdle()
        assertTrue(store.state.value.failed)
        assertEquals(entries, store.state.value.entries)
        val count = host.commands.size
        store.deleteEntry("/repo/missing"); advanceUntilIdle()
        assertEquals(count, host.commands.size)
        assertTrue(store.state.value.failed)
    }

    @Test fun lateMutationDoesNotRefreshReplacementProvider() = runTest {
        val host = FileHost(); val store = RuntimeFilesStore(this, host)
        store.browse("/repo", "/repo", "ssh-a", false); advanceUntilIdle()
        var pending: kotlin.coroutines.Continuation<Unit>? = null
        host.beforeReply = { command ->
            if (command.command == "create_directory") kotlin.coroutines.suspendCoroutine<Unit> { pending = it }
        }
        store.createEntry("folder", true); advanceUntilIdle()
        store.browse("/repo", "/repo", "ssh-b", false); advanceUntilIdle()
        val replacement = store.state.value
        val count = host.commands.size
        pending!!.resumeWith(Result.success(Unit)); advanceUntilIdle()
        assertEquals(count, host.commands.size)
        assertEquals(replacement, store.state.value)
    }

    private class FileHost : RemoteCommandTransport {
        var accepted = true
        var errorDetail: String? = null
        var children = "[]"
        var beforeReply: (suspend (RemoteCommand) -> Unit)? = null
        val commands = mutableListOf<RemoteCommand>()
        override suspend fun <T : CommandStatus> send(deserializer: DeserializationStrategy<T>, command: RemoteCommand, timeoutMs: Long): T {
            commands += command
            beforeReply?.invoke(command)
            val value = when(command.command) {
                "get_directory_children_paginated" -> """{"children":$children,"hasMore":false}"""
                "read_file_content" -> "\"original\""
                else -> "null"
            }
            val response = buildJsonObject {
                put("resp", "host_invoke_result"); put("ok", accepted)
                put("value", RelayJson.parseToJsonElement(value))
                errorDetail?.let { put("error", it) }
            }
            return RelayJson.decodeFromJsonElement(deserializer, response)
        }
    }
}
