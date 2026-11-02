package com.openbitfun.mobile.app.platform

import android.content.Context
import android.util.Log
import com.openbitfun.mobile.core.feature.CoreLog
import java.io.File

/**
 * Forwards core log lines to Logcat verbatim.
 *
 * Verbatim is safe by construction: room ids and request ids are truncated
 * before they leave the core, and keys, tokens and passwords never reach it.
 * If that ever stops being true, the tests next to `PairingStore` fail first.
 */
internal object LogcatCoreLog : CoreLog {
    private const val TAG = "OpenBitFunCore"
    private const val FILE_NAME = "openbitfun-auth-diagnostics.log"
    private const val MAX_FILE_BYTES = 512 * 1024
    private var diagnosticsFiles: List<File> = emptyList()

    /**
     * Keeps a small, pullable breadcrumb file for Android compatibility hosts
     * where the normal Android log buffer is not exposed through HDC.
     */
    fun initialize(context: Context) {
        diagnosticsFiles = listOfNotNull(
            File(context.filesDir, FILE_NAME),
            context.getExternalFilesDir(null)?.let { File(it, FILE_NAME) },
        ).distinctBy { it.absolutePath }
        info("diagnostics initialized")
    }

    override fun info(message: String) {
        Log.i(TAG, message)
        append("I", message)
    }

    override fun warn(message: String) {
        Log.w(TAG, message)
        append("W", message)
    }

    override fun error(message: String) {
        Log.e(TAG, message)
        append("E", message)
    }

    private fun append(level: String, message: String) {
        synchronized(this) {
            diagnosticsFiles.forEach { file ->
                runCatching {
                    if (file.length() > MAX_FILE_BYTES) {
                        file.writeText("diagnostic log rotated\n")
                    }
                    file.appendText("${System.currentTimeMillis()} $level $message\n")
                }
            }
        }
    }
}
