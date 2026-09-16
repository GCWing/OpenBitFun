package com.openbitfun.mobile.app.platform

import android.app.Activity
import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.LocaleList
import java.util.Locale

/** App-owned locales, matching HarmonyOS's two explicit language choices. */
internal enum class AppLocale(val languageTag: String) {
    ENGLISH("en-US"),
    SIMPLIFIED_CHINESE("zh-CN"),
}

/**
 * Resolves Android's language token to one of the app-owned locales.
 *
 * Every `zh*` Android locale intentionally uses Simplified Chinese because
 * this app ships only the default and `values-zh` resource catalogs.
 */
internal fun resolveAppLocale(language: String?): AppLocale =
    when (language?.trim()?.lowercase(Locale.ROOT)) {
        "zh" -> AppLocale.SIMPLIFIED_CHINESE
        null, "" -> AppLocale.ENGLISH
        else -> AppLocale.ENGLISH
    }

internal object AppLocaleController {
    private const val PREFERENCES = "openbitfun_app_settings"
    private const val LANGUAGE_KEY = "language"

    fun current(configuration: Configuration): AppLocale {
        val language = configuration.locales
            .takeIf { !it.isEmpty }
            ?.get(0)
            ?.language
        return resolveAppLocale(language)
    }

    fun set(context: Context, locale: AppLocale) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val manager = context.getSystemService(LocaleManager::class.java)
            manager.applicationLocales = LocaleList.forLanguageTags(locale.languageTag)
        } else {
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                .edit()
                .putString(LANGUAGE_KEY, locale.languageTag)
                .apply()
            applyLegacy(context, locale.languageTag)
            (context as? Activity)?.recreate()
        }
    }

    fun applySaved(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val manager = context.getSystemService(LocaleManager::class.java)
            if (manager.applicationLocales.isEmpty) {
                manager.applicationLocales = LocaleList.forLanguageTags(DEFAULT_APP_LANGUAGE_TAG)
            }
            return
        }
        val tag = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .getString(LANGUAGE_KEY, null)
            ?: DEFAULT_APP_LANGUAGE_TAG
        applyLegacy(context, tag)
    }

    private fun applyLegacy(context: Context, languageTag: String) {
        val locale = Locale.forLanguageTag(languageTag)
        Locale.setDefault(locale)
        val configuration = Configuration(context.resources.configuration)
        configuration.setLocales(LocaleList(locale))
        @Suppress("DEPRECATION")
        context.resources.updateConfiguration(configuration, context.resources.displayMetrics)
    }
}
