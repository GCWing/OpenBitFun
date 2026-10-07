package com.openbitfun.mobile.app

import android.content.Intent
import android.os.Bundle
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.openbitfun.mobile.app.ui.shell.StartupBrandReveal
import com.openbitfun.mobile.app.ui.shell.ColdStartHomeTransition
import com.openbitfun.mobile.app.ui.shell.LocalColdStartTarget
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.openbitfun.mobile.app.platform.LogcatCoreLog
import com.openbitfun.mobile.app.ui.shell.MobileScreen
import com.openbitfun.mobile.app.platform.StartupRevealPreference
import com.openbitfun.mobile.app.platform.AppLocaleController
import com.openbitfun.mobile.app.ui.preview.MobileDesignGallery
import com.openbitfun.mobile.app.ui.preview.mobileDesignScenario
import com.openbitfun.mobile.app.ui.theme.OpenBitFunTheme
import com.openbitfun.mobile.app.viewmodel.AppSettingsViewModel
import com.openbitfun.mobile.app.viewmodel.AppThemeMode

class MainActivity : ComponentActivity() {
    private var showStartupBrand by mutableStateOf(true)
    private var showColdStart by mutableStateOf(false)
    private var allowColdStart by mutableStateOf(false)
    private var showWelcomeNavigationProtection by mutableStateOf(true)
    private var authorizationCallbackPending = false
    override fun onCreate(savedInstanceState: Bundle?) {
        AppLocaleController.applySaved(this)
        super.onCreate(savedInstanceState)
        LogcatCoreLog.initialize(applicationContext)
        LogcatCoreLog.info("activity onCreate callback=${isAuthorizationCallbackIntent(intent)}")
        authorizationCallbackPending = isAuthorizationCallbackIntent(intent)
        val coldStartCandidate = !processLaunchClaimed
            && !intent.getBooleanExtra(DESIGN_PREVIEW_EXTRA, false)
        processLaunchClaimed = true
        showStartupBrand = coldStartCandidate && StartupRevealPreference.claim(this)
        allowColdStart = coldStartCandidate && !showStartupBrand
        enableEdgeToEdge()
        @Suppress("DEPRECATION")
        if (android.os.Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
        setContent {
            if (intent.getBooleanExtra(DESIGN_PREVIEW_EXTRA, false)) {
                val scenario = mobileDesignScenario(intent.getStringExtra(DESIGN_SCENARIO_EXTRA))
                MobileDesignGallery(scenario = scenario, dark = scenario.appearance == "dark")
                return@setContent
            }
            val settings: AppSettingsViewModel = viewModel(factory = AppSettingsViewModel.Factory)
            val theme by settings.theme.collectAsStateWithLifecycle()
            val dark = when (theme) {
                AppThemeMode.SYSTEM -> isSystemInDarkTheme()
                AppThemeMode.LIGHT -> false
                AppThemeMode.DARK -> true
            }
            OpenBitFunTheme(dark = dark) {
                LaunchedEffect(dark, showWelcomeNavigationProtection, showStartupBrand, showColdStart, allowColdStart) {
                    val welcomeIsVisible = showWelcomeNavigationProtection &&
                        !showStartupBrand && !showColdStart && !allowColdStart
                    WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightNavigationBars =
                        !dark && !welcomeIsVisible
                }
                val target = remember { mutableStateOf<androidx.compose.ui.geometry.Rect?>(null) }
                var origin by remember { mutableStateOf(Offset.Zero) }
                Box(Modifier.onGloballyPositioned { origin = it.positionInRoot() }) {
                    CompositionLocalProvider(LocalColdStartTarget provides target) {
                        Box(Modifier.semantics {
                            if (showStartupBrand || showColdStart) hideFromAccessibility()
                        }) {
                        MobileScreen(onAccountRestored = { signedIn ->
                            showWelcomeNavigationProtection = !signedIn
                            if (allowColdStart) {
                                allowColdStart = false
                                showColdStart = signedIn
                            }
                        })
                        }
                    }
                    if (showStartupBrand) StartupBrandReveal { showStartupBrand = false }
                    val bounds = target.value
                    if (showColdStart) {
                        ColdStartHomeTransition(bounds?.translate(-origin)) { showColdStart = false }
                    }
                    // Android 15+ makes the gesture/navigation area part of an
                    // edge-to-edge window. Keep the signed-out welcome dock's
                    // dark surface behind that area at the Activity root; a
                    // screen or Scaffold inset cannot paint over the system
                    // region reliably on all API levels.
                    if (showWelcomeNavigationProtection && !showStartupBrand && !showColdStart && !allowColdStart) {
                        Box(
                            Modifier
                                .align(Alignment.BottomCenter)
                                .fillMaxWidth()
                                // Include the platform's divider inset above
                                // the gesture area as well as the nav bar.
                                .height(40.dp)
                                .background(Color(23, 25, 23)),
                        )
                    }
                }
                if (!showStartupBrand && !showColdStart && !allowColdStart) {
                    com.openbitfun.mobile.app.ui.shell.NotificationOnboarding()
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        LogcatCoreLog.info("activity onStart callbackPending=$authorizationCallbackPending")
        if (!intent.getBooleanExtra(DESIGN_PREVIEW_EXTRA, false)) {
            accountModel().setBackground(false)
            if (authorizationCallbackPending) {
                authorizationCallbackPending = false
                accountModel().notifyAuthorizationCallback()
            }
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        LogcatCoreLog.info("activity onNewIntent action=${intent.action} callback=${isAuthorizationCallbackIntent(intent)}")
        if (isAuthorizationCallbackIntent(intent)) accountModel().notifyAuthorizationCallback()
    }

    override fun onStop() {
        LogcatCoreLog.info("activity onStop")
        showStartupBrand = false
        showColdStart = false
        allowColdStart = false
        if (!intent.getBooleanExtra(DESIGN_PREVIEW_EXTRA, false)) accountModel().setBackground(true)
        super.onStop()
    }

    private fun accountModel() = androidx.lifecycle.ViewModelProvider(this,
        com.openbitfun.mobile.app.viewmodel.AccountViewModel.Factory)[com.openbitfun.mobile.app.viewmodel.AccountViewModel::class.java]

    private fun isAuthorizationCallbackIntent(intent: Intent): Boolean {
        val uri = intent.data ?: return false
        return intent.action == Intent.ACTION_VIEW &&
            uri.scheme == "openbitfun" &&
            uri.authority == "auth" &&
            uri.path == "/callback" &&
            uri.query == null &&
            uri.fragment == null
    }

    private companion object {
        var processLaunchClaimed = false
        const val DESIGN_PREVIEW_EXTRA = "openbitfun.design_preview"
        const val DESIGN_SCENARIO_EXTRA = "openbitfun.design_scenario"
    }
}
