package com.openbitfun.mobile.app.platform

import android.content.ActivityNotFoundException
import android.content.Context
import android.util.Log
import android.widget.Toast
import androidx.annotation.StringRes

/** System media activities are optional, and OEMs may deny access to them. */
internal fun launchComposerActivity(
    context: Context,
    @StringRes failureMessage: Int,
    launch: () -> Unit,
): Boolean = try {
    launch()
    true
} catch (_: ActivityNotFoundException) {
    Log.w("ComposerActivity", "System media activity is unavailable")
    Toast.makeText(context, failureMessage, Toast.LENGTH_LONG).show()
    false
} catch (_: SecurityException) {
    Log.w("ComposerActivity", "System media activity access was denied")
    Toast.makeText(context, failureMessage, Toast.LENGTH_LONG).show()
    false
}
