package com.openbitfun.mobile.app.ui.remote

/** Preserve the host filename when Android associates its extension with another MIME type. */
internal fun documentExportMimeType(declared: String, extensionMimeType: String?): String =
    if (declared.isNotBlank() && declared.equals(extensionMimeType, ignoreCase = true)) declared
    else "application/octet-stream"
