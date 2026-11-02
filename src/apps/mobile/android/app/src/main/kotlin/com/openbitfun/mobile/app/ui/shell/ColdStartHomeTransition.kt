package com.openbitfun.mobile.app.ui.shell

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.unit.dp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.clearAndSetSemantics
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignMotion
import kotlin.math.*

/** Logged-in cold-start transition. The underlying home is already laid out. */
@Composable
internal fun ColdStartHomeTransition(target: androidx.compose.ui.geometry.Rect?, onFinished: () -> Unit) {
    val progress = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        progress.animateTo(1f, tween(MobileDesignMotion.ColdStartHome, easing = LinearEasing))
        onFinished()
    }
    val density = androidx.compose.ui.platform.LocalDensity.current
    val p = progress.value
    val travel = smooth((p - .16f) / .52f)
    val overlayAlpha = 1f - smooth((p - .68f) / .32f)
    BoxWithConstraints(
        Modifier.fillMaxSize()
            .graphicsLayer { alpha = overlayAlpha }
            .background(androidx.compose.material3.MaterialTheme.colorScheme.background)
            .pointerInput(Unit) { awaitPointerEventScope { while (true) awaitPointerEvent().changes.forEach { it.consume() } } }
            .clearAndSetSemantics { },
        contentAlignment = Alignment.TopCenter,
    ) {
        val targetY = target?.let { with(density) { it.center.y.toDp() } } ?: (maxHeight * .53f)
        val targetX = target?.let { with(density) { it.center.x.toDp() } } ?: (maxWidth / 2)
        val targetSize = target?.let { with(density) { it.width.toDp() } } ?: 56.dp
        val centerY = maxHeight * .53f
        val y = centerY + (targetY - centerY) * travel - (if (target != null) 9.dp else 0.dp) * sin(travel * PI).toFloat()
        val size = 56.dp + (targetSize - 56.dp) * travel
        WelcomeBrandFlow(
            Modifier.size(size)
                .offset(x = (targetX - maxWidth / 2) * travel, y = y - size / 2)
                .graphicsLayer { alpha = (p / .13f).coerceIn(0f, 1f) },
            sweep = true,
        )
    }
}

private fun smooth(value: Float): Float {
    val p = value.coerceIn(0f, 1f)
    return p * p * (3f - 2f * p)
}

internal val LocalColdStartTarget = androidx.compose.runtime.staticCompositionLocalOf<androidx.compose.runtime.MutableState<androidx.compose.ui.geometry.Rect?>?> { null }

@Composable
internal fun ColdStartHomeMark(modifier: Modifier) {
    val target = LocalColdStartTarget.current
    androidx.compose.runtime.DisposableEffect(target) { onDispose { target?.value = null } }
    WelcomeBrandFlow(modifier.onGloballyPositioned { target?.value = it.boundsInRoot() }, sweep = true)
}
