package com.openbitfun.mobile.core.feature.workspace

import com.openbitfun.mobile.core.crypto.ContentHash
import com.openbitfun.mobile.core.crypto.sha256
import com.openbitfun.mobile.core.crypto.newFileTransferIdentity
import kotlin.io.encoding.Base64
import com.openbitfun.mobile.core.protocol.*
import com.openbitfun.mobile.core.transport.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

public enum class RuntimeFileSort { NAME_ASC, NAME_DESC, MODIFIED_DESC, MODIFIED_ASC }

public data class RuntimeFileUiState public constructor(public val path: String, public val name: String, public val directory: Boolean)
public data class RuntimeFilesUiState public constructor(
    public val directory: String, public val entries: List<RuntimeFileUiState>, public val hasMore: Boolean,
    public val file: String?, public val content: String, public val busy: Boolean, public val failed: Boolean,
    public val sort: RuntimeFileSort,
    public val completedOperation: Long,
    /** Unlocalized diagnostic supplied by the controlled host; null uses the surface fallback. */
    public val errorDetail: String?,
) {
    /** Stable host error code; native surfaces own the localized explanation. */
    public val saveConflict: Boolean get() = failed && errorDetail?.startsWith("FILE_CONFLICT:") == true
    public constructor(directory: String, entries: List<RuntimeFileUiState>, hasMore: Boolean, file: String?, content: String, busy: Boolean, failed: Boolean, sort: RuntimeFileSort, completedOperation: Long) : this(directory, entries, hasMore, file, content, busy, failed, sort, completedOperation, null)
    public constructor(directory: String, entries: List<RuntimeFileUiState>, hasMore: Boolean, file: String?, content: String, busy: Boolean, failed: Boolean, sort: RuntimeFileSort) : this(directory, entries, hasMore, file, content, busy, failed, sort, 0)
    public constructor(directory: String, entries: List<RuntimeFileUiState>, hasMore: Boolean, file: String?, content: String, busy: Boolean, failed: Boolean) : this(directory, entries, hasMore, file, content, busy, failed, RuntimeFileSort.NAME_ASC)
}
@Serializable
private data class FilesHostResult(override val resp: String? = null, override val message: String? = null,
    val ok: Boolean = false, val value: JsonElement = JsonNull, val error: String? = null) : CommandStatus

private class FilesHostFailure(val detail: String?) : Exception()

internal class RuntimeFilesStore(private val scope: CoroutineScope, private val transport: RemoteCommandTransport) {
    private val mutable = MutableStateFlow(RuntimeFilesUiState("", emptyList(), false, null, "", false, false))
    val state = mutable.asStateFlow()
    private var job: Job? = null
    private var epoch = 0L
    private var connectionId: String? = null
    private var root: String = ""
    private var originalHash: String? = null
    private suspend fun invoke(command: String, body: JsonObject): JsonElement {
        check(root.isNotEmpty()) { "No runtime workspace is selected" }
        val args = body.toMutableMap()
        if (command == "workspace_file_upload") connectionId?.let { args["remoteConnectionId"] = JsonPrimitive(it) }
        else args["remoteConnectionId"] = JsonPrimitive(connectionId.orEmpty())
        val response = transport.send<FilesHostResult>(RemoteCommand(cmd = "host_invoke", command = command,
            args = buildJsonObject { put("request", JsonObject(args)) }))
        if (!response.ok) throw FilesHostFailure(response.error?.takeIf { it.isNotBlank() })
        return response.value
    }
    private fun run(operation: suspend (Long) -> Unit) {
        if (mutable.value.busy) return
        val ticket = epoch
        mutable.value = mutable.value.copy(busy = true, failed = false, errorDetail = null)
        job = scope.launch {
            try { operation(ticket) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Throwable) { if (ticket == epoch) mutable.value = mutable.value.copy(failed = true, errorDetail = (error as? FilesHostFailure)?.detail) }
            finally { if (ticket == epoch) mutable.value = mutable.value.copy(busy = false, completedOperation = mutable.value.completedOperation + 1) }
        }
    }
    fun browse(path: String, rootPath: String, remoteConnectionId: String?, append: Boolean, sort: RuntimeFileSort = mutable.value.sort) {
        if (root != rootPath || connectionId != remoteConnectionId) {
            stop(); root = rootPath; connectionId = remoteConnectionId
            mutable.value = RuntimeFilesUiState("", emptyList(), false, null, "", false, false)
        }
        run { ticket -> loadDirectory(ticket, path, append, sort) }
    }
    private suspend fun loadDirectory(ticket: Long, path: String, append: Boolean, sort: RuntimeFileSort) {
        val page = invoke("get_directory_children_paginated", buildJsonObject {
            put("path", path); put("offset", if (append) mutable.value.entries.size else 0); put("limit", 100)
            put("sortBy", if (sort == RuntimeFileSort.NAME_ASC || sort == RuntimeFileSort.NAME_DESC) "name" else "modified")
            put("sortOrder", if (sort == RuntimeFileSort.NAME_ASC || sort == RuntimeFileSort.MODIFIED_ASC) "asc" else "desc")
        }).jsonObject
        val entries = page.getValue("children").jsonArray.map { child ->
            val item = child.jsonObject
            RuntimeFileUiState(item.getValue("path").jsonPrimitive.content, item.getValue("name").jsonPrimitive.content,
                item.getValue("isDirectory").jsonPrimitive.boolean)
        }
        if (ticket == epoch) mutable.value = mutable.value.copy(directory = path, sort = sort,
            entries = if (append) mutable.value.entries + entries else entries,
            hasMore = page.getValue("hasMore").jsonPrimitive.boolean, file = null, content = "")
    }
    private suspend fun refreshDirectory(ticket: Long) {
        if (ticket != epoch) return
        val current = mutable.value
        loadDirectory(ticket, current.directory, false, current.sort)
    }
    private fun entryPath(name: String): String {
        require(name.isNotBlank()) { "A file name is required" }
        val directory = mutable.value.directory
        check(directory.isNotEmpty()) { "No directory is open" }
        return if (name.startsWith('/')) name else directory.trimEnd('/') + "/" + name
    }
    fun createEntry(name: String, directory: Boolean) = run { ticket ->
        val path = entryPath(name)
        if (directory) invoke("create_directory", buildJsonObject { put("path", path) })
        else invoke("write_file_content", buildJsonObject {
            put("filePath", path); put("workspacePath", root); put("content", ""); put("expectedHash", "")
        })
        refreshDirectory(ticket)
    }
    fun renameEntry(path: String, name: String) = run { ticket ->
        check(mutable.value.entries.any { it.path == path }) { "File entry is no longer available" }
        val destination = entryPath(name)
        invoke("rename_file", buildJsonObject { put("oldPath", path); put("newPath", destination) })
        refreshDirectory(ticket)
    }
    fun deleteEntry(path: String) = run { ticket ->
        val entry = mutable.value.entries.firstOrNull { it.path == path } ?: error("File entry is no longer available")
        invoke(if (entry.directory) "delete_directory" else "delete_file", buildJsonObject {
            put("path", path)
            if (entry.directory) put("recursive", false)
        })
        refreshDirectory(ticket)
    }
    fun sort(value: RuntimeFileSort) { if (mutable.value.directory.isNotEmpty()) browse(mutable.value.directory, root, connectionId, false, value) }
    fun closeFile() { if (!mutable.value.busy) { originalHash = null; mutable.value = mutable.value.copy(file = null, content = "") } }
    fun read(path: String) = run { ticket ->
        val content = invoke("read_file_content", buildJsonObject { put("filePath", path) }).jsonPrimitive.content
        val digest = ContentHash.sha256(content)
        if (ticket == epoch) { originalHash = digest; mutable.value = mutable.value.copy(file = path, content = content) }
    }
    fun save(content: String) = run { ticket ->
        val file = mutable.value.file ?: error("No file is open")
        invoke("write_file_content", buildJsonObject { put("filePath", file); put("workspacePath", root); put("content", content); put("expectedHash", originalHash ?: error("No file revision is available")) })
        val digest = ContentHash.sha256(content)
        if (ticket == epoch) { originalHash = digest; mutable.value = mutable.value.copy(content = content) }
    }
    fun uploadEntry(name: String, source: RuntimeUploadSource) {
        val path = try { entryPath(name) } catch (_: Throwable) {
            source.close(); mutable.value = mutable.value.copy(failed = true, errorDetail = null); return
        }
        upload(path, source)
    }
    fun upload(path: String, source: RuntimeUploadSource) {
        if (mutable.value.busy) { source.close(); return }
        var closed = false
        fun closeSource() { if (!closed) { closed = true; source.close() } }
        run { ticket ->
            val transferId = newFileTransferIdentity()
            suspend fun read(offset: Long, length: Int): ByteArray = withContext(Dispatchers.Default) { source.read(offset, length) }
            suspend fun call(action: String, data: JsonObject = buildJsonObject {}): JsonObject {
                check(ticket == epoch) { "Upload target changed" }
                val reply = invoke("workspace_file_upload", buildJsonObject {
                    put("action", action); put("path", path); put("workspacePath", root); put("transferId", transferId)
                    data.forEach { (key, value) -> put(key, value) }
                }).jsonObject
                check(ticket == epoch) { "Upload target changed" }
                val next = reply.getValue("nextOffset").jsonPrimitive.long
                check(reply.getValue("transferId").jsonPrimitive.content == transferId &&
                    reply.getValue("totalBytes").jsonPrimitive.long == source.size && next in 0..source.size) { "Invalid runtime upload cursor" }
                return reply
            }
            try {
                val hash = ContentHash.sha256(source.size, ::read)
                var status = try { call("begin", buildJsonObject { put("totalBytes", source.size); put("sha256", hash); put("expectedHash", "") }) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Throwable) { call("status") }
                var offset = status.getValue("nextOffset").jsonPrimitive.long
                while (offset < source.size) {
                    val bytes = read(offset, minOf(3L * 1024 * 1024, source.size - offset).toInt())
                    check(bytes.isNotEmpty()) { "Upload source is truncated" }
                    try { status = call("append", buildJsonObject { put("offset", offset); put("contentBase64", Base64.encode(bytes)) }) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (error: Throwable) { status = call("status"); if (status.getValue("nextOffset").jsonPrimitive.long == offset) throw error }
                    val next = status.getValue("nextOffset").jsonPrimitive.long
                    check(next > offset) { "Runtime upload made no progress" }; offset = next
                }
                if (status["completed"]?.jsonPrimitive?.boolean != true) {
                    try { status = call("finish") }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (error: Throwable) { status = call("status"); if (status["completed"]?.jsonPrimitive?.boolean != true) throw error }
                }
                check(status.getValue("completed").jsonPrimitive.boolean &&
                    status.getValue("nextOffset").jsonPrimitive.long == source.size) { "Runtime upload is incomplete" }
                refreshDirectory(ticket)
            } finally { withContext(NonCancellable + Dispatchers.Default) { closeSource() } }
        }
        job?.invokeOnCompletion { closeSource() }
    }
    fun createFile(path: String) = run { ticket ->
        invoke("write_file_content", buildJsonObject { put("filePath", path); put("workspacePath", root); put("content", ""); put("expectedHash", "") })
        val digest = ContentHash.sha256("")
        if (ticket == epoch) { originalHash = digest; mutable.value = mutable.value.copy(file = path, content = "") }
    }
    fun renameFile(path: String) = run { ticket ->
        val old = mutable.value.file ?: error("No file is open")
        invoke("rename_file", buildJsonObject { put("oldPath", old); put("newPath", path) })
        if (ticket == epoch) mutable.value = mutable.value.copy(file = path, entries = mutable.value.entries.map { if (it.path == old) it.copy(path = path, name = path.substringAfterLast('/')) else it })
    }
    fun deleteFile() = run { ticket ->
        val file = mutable.value.file ?: error("No file is open")
        invoke("delete_file", buildJsonObject { put("path", file) })
        if (ticket == epoch) { originalHash = null; mutable.value = mutable.value.copy(file = null, content = "", entries = mutable.value.entries.filterNot { it.path == file }) }
    }
    fun createDirectory(path: String) = run { _ -> invoke("create_directory", buildJsonObject { put("path", path) }) }
    fun reset() { stop(); root = ""; connectionId = null; originalHash = null; mutable.value = RuntimeFilesUiState("", emptyList(), false, null, "", false, false) }
    fun stop() { epoch++; job?.cancel(); mutable.value = mutable.value.copy(busy = false) }
}
