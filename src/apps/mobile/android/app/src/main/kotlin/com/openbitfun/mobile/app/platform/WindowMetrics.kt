package com.openbitfun.mobile.app.platform

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import com.openbitfun.mobile.core.feature.layout.ConversationLayoutPolicy
import com.openbitfun.mobile.core.feature.layout.HorizontalWindowCrease
import com.openbitfun.mobile.core.feature.layout.WindowCrease
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map

/**
 * The window as the layout policies measure it.
 *
 * @param widthDp the window's own width, not the display's: a freeform or split
 * window is narrower than the screen it sits on, and the layout follows the
 * window.
 * Fold APIs are projected into semantic facts here so shared code never imports
 * Android WindowManager types.
 */
internal data class WindowMetrics(
    val widthDp: Int,
    val heightDp: Int,
    val wideViewportMatched: Boolean,
    val isFolded: Boolean,
    val isExpandedFoldable: Boolean,
    val isHoverLayout: Boolean,
    val creases: List<WindowCrease>,
    val horizontalCreases: List<HorizontalWindowCrease>,
)

internal enum class FoldState {
    FLAT,
    HALF_OPENED,
    UNKNOWN,
}

internal data class FoldFeatureFacts(
    val state: FoldState,
    val isHorizontal: Boolean,
)

internal data class FoldFacts(
    val hasFoldingFeature: Boolean,
    val halfOpened: Boolean,
    val flatOpened: Boolean,
    val isFolded: Boolean,
    val isExpandedFoldable: Boolean,
    val hoverCandidate: Boolean,
)

internal fun reduceFoldFacts(
    hasHingeSensor: Boolean,
    features: List<FoldFeatureFacts>,
): FoldFacts {
    val hasFoldingFeature = features.isNotEmpty()
    val halfOpened = features.any { it.state == FoldState.HALF_OPENED }
    val flatOpened = hasFoldingFeature && features.all { it.state == FoldState.FLAT }
    return FoldFacts(
        hasFoldingFeature = hasFoldingFeature,
        halfOpened = halfOpened,
        flatOpened = flatOpened,
        isFolded = hasHingeSensor && !hasFoldingFeature,
        isExpandedFoldable = flatOpened,
        hoverCandidate =
            features.all { it.state != FoldState.UNKNOWN } &&
                features.any {
                    it.isHorizontal && it.state == FoldState.HALF_OPENED
                },
    )
}

private data class AndroidFoldInfo(
    val creases: List<WindowCrease>,
    val horizontalCreases: List<HorizontalWindowCrease>,
    val foldFacts: FoldFacts,
)

/**
 * Reads the current window and the hinges crossing it.
 *
 * Vertical creases feed the master/detail policy; horizontal creases feed the
 * hover/operate-region modal policy. Both are reduced to their leading edge and
 * thickness here, so shared code never imports Android WindowManager types or
 * has to know what a pixel is on this device.
 */
@Composable
internal fun rememberWindowMetrics(): WindowMetrics {
    val context = LocalContext.current
    val density = LocalDensity.current
    val containerSize = LocalWindowInfo.current.containerSize
    val widthDp = with(density) { containerSize.width.toDp().value.toInt() }
    val heightDp = with(density) { containerSize.height.toDp().value.toInt() }
    val hasHingeSensor = remember(context) {
        context.packageManager.hasSystemFeature(FEATURE_SENSOR_HINGE_ANGLE)
    }
    //卓易通在鸿蒙上会向 Android 兼容层暴露一个“垂直折痕”，但它不是
    //Android WindowManager 的真实折叠区域。把它当成铰链会把普通宽屏窗口
    //错误拆成左右两套页面。通过鸿蒙系统文件管理器包识别兼容层；普通
    //Android 平板和真实 Android 折叠屏不会安装这个包，因此保持原行为。
    val isHarmonyCompatibilityLayer = remember(context) {
        context.packageManager.hasPackage("com.huawei.hmos.filemanager")
    }

    val activity = remember(context) { context.findActivity() }
    // No activity means no window to track — a @Preview, or a composable hosted
    // somewhere that has no fold to report anyway.
    val foldInfoFlow = remember(activity, density) {
        if (activity == null) {
            flowOf(AndroidFoldInfo(emptyList(), emptyList(), reduceFoldFacts(false, emptyList())))
        } else {
            WindowInfoTracker.getOrCreate(activity)
                .windowLayoutInfo(activity)
                .map { info ->
                    val features = info.displayFeatures.filterIsInstance<FoldingFeature>()
                    val foldFacts = reduceFoldFacts(
                        hasHingeSensor = hasHingeSensor,
                        features = features.map { feature ->
                            FoldFeatureFacts(
                                state = when (feature.state) {
                                    FoldingFeature.State.HALF_OPENED -> FoldState.HALF_OPENED
                                    FoldingFeature.State.FLAT -> FoldState.FLAT
                                    else -> FoldState.UNKNOWN
                                },
                                isHorizontal = feature.orientation == FoldingFeature.Orientation.HORIZONTAL,
                            )
                        },
                    )
                    AndroidFoldInfo(
                        creases = features
                            .filter { it.orientation == FoldingFeature.Orientation.VERTICAL }
                            .map { feature ->
                                with(density) {
                                    WindowCrease(
                                        left = feature.bounds.left.toDp().value.toInt(),
                                        width = feature.bounds.width().toDp().value.toInt(),
                                    )
                                }
                            },
                        horizontalCreases = features
                            .filter { it.orientation == FoldingFeature.Orientation.HORIZONTAL }
                            .map { feature ->
                                with(density) {
                                    HorizontalWindowCrease(
                                        top = feature.bounds.top.toDp().value.toInt(),
                                        height = feature.bounds.height().toDp().value.toInt(),
                                    )
                                }
                            },
                        foldFacts = foldFacts,
                    )
                }
        }
    }
    val reportedFoldInfo by foldInfoFlow.collectAsStateWithLifecycle(
        AndroidFoldInfo(emptyList(), emptyList(), reduceFoldFacts(false, emptyList())),
    )
    val foldInfo = if (isHarmonyCompatibilityLayer) {
        AndroidFoldInfo(emptyList(), emptyList(), reduceFoldFacts(false, emptyList()))
    } else {
        reportedFoldInfo
    }

    return WindowMetrics(
        widthDp = widthDp,
        heightDp = heightDp,
        wideViewportMatched = widthDp >= ConversationLayoutPolicy.MD_MIN_WIDTH,
        isFolded = foldInfo.foldFacts.isFolded,
        isExpandedFoldable = foldInfo.foldFacts.isExpandedFoldable,
        isHoverLayout = ConversationLayoutPolicy.useHoverOperate(
            foldInfo.foldFacts.hoverCandidate,
            widthDp,
            heightDp,
        ),
        creases = foldInfo.creases,
        horizontalCreases = foldInfo.horizontalCreases,
    )
}

private const val FEATURE_SENSOR_HINGE_ANGLE = "android.hardware.sensor.hinge_angle"

private fun android.content.pm.PackageManager.hasPackage(packageName: String): Boolean =
    try {
        getApplicationInfo(packageName, 0)
        true
    } catch (_: android.content.pm.PackageManager.NameNotFoundException) {
        false
    }

private fun Context.findActivity(): Activity? {
    var current: Context? = this
    while (current is ContextWrapper) {
        if (current is Activity) return current
        current = current.baseContext
    }
    return null
}
