package com.openbitfun.mobile.core.domain

import com.openbitfun.mobile.core.protocol.RemoteModelCatalog
import com.openbitfun.mobile.core.protocol.RemoteModelConfig

/** Host model selectors remain roles until the host resolves them for execution. */
public object ModelSelectionPolicy {
    public fun isRole(selector: String): Boolean = selector.trim() in listOf("primary", "fast")

    public fun resolve(catalog: RemoteModelCatalog, selector: String): RemoteModelConfig? {
        fun enabled(id: String?): RemoteModelConfig? = catalog.models.firstOrNull {
            it.enabled && it.id == id.orEmpty().trim() && it.id.isNotEmpty()
        }
        return when (val value = selector.trim()) {
            "primary" -> enabled(catalog.defaultModels.primary)
            "fast" -> enabled(catalog.defaultModels.fast) ?: enabled(catalog.defaultModels.primary)
            else -> enabled(value)
        }
    }
}
