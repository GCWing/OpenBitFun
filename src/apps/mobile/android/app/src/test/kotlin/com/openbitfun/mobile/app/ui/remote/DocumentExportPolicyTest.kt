package com.openbitfun.mobile.app.ui.remote

import org.junit.Assert.assertEquals
import org.junit.Test

class DocumentExportPolicyTest {
    @Test fun sourceAndExtensionlessFilesDoNotAcquirePlatformExtensions() {
        // Android maps .ts to video; unknown source extensions and extensionless
        // files have no MIME mapping. text/plain would append .txt in each case.
        assertEquals("application/octet-stream", documentExportMimeType("text/plain", "video/mp2t"))
        assertEquals("application/octet-stream", documentExportMimeType("text/plain", null))
        assertEquals("image/png", documentExportMimeType("image/png", "image/png"))
        assertEquals("application/pdf", documentExportMimeType("application/pdf", "application/pdf"))
    }
}
