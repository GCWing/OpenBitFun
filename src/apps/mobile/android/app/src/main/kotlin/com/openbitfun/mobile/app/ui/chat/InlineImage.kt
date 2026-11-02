package com.openbitfun.mobile.app.ui.chat

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64

/**
 * Decodes one of the relay's inline `data:` URLs.
 *
 * Both the transcript and the composer show the same attachments, and neither
 * may fetch anything: an image that is not carried inline is not ours to load,
 * so a URL of any other shape decodes to null and the caller shows a caption.
 */
internal fun decodeInlineImage(dataUrl: String): Bitmap? {
    if (!dataUrl.startsWith("data:", ignoreCase = true)) return null
    val metadata = dataUrl.substringBefore(',')
    if (!metadata.split(';').any { it.equals("base64", ignoreCase = true) }) return null
    val payload = dataUrl.substringAfter(',', "")
    if (payload.isEmpty()) return null
    return runCatching {
        val bytes = Base64.decode(payload, Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }.getOrNull()
}

/** Pure projection work belongs off the Compose/UI thread. Key changes cancel
 * the old delivery, so a reused row cannot receive another message's bitmap. */
@androidx.compose.runtime.Composable
internal fun rememberInlineImage(dataUrl: String): Bitmap? {
    val state = androidx.compose.runtime.produceState<Bitmap?>(null, dataUrl) {
        value = null
        value = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Default) {
            decodeInlineImage(dataUrl)
        }
    }
    return state.value
}
