package com.openbitfun.mobile.app.ui.shell

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.theme.OpenBitFunEaseOut
import com.openbitfun.mobile.app.ui.theme.MotionDrawerCloseMillis
import com.openbitfun.mobile.app.ui.theme.MotionDrawerHideMillis
import com.openbitfun.mobile.app.ui.theme.MotionDrawerOpenMillis
import com.openbitfun.mobile.app.ui.theme.MotionDrawerRevealMillis
import com.openbitfun.mobile.app.ui.theme.MotionDrawerScrimMillis
import com.openbitfun.mobile.app.ui.theme.openBitFunColors
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

private const val CONTENT_SCALE_X = 0.985f
private const val CONTENT_SCALE_Y = 0.992f
private const val CONTENT_RADIUS_DP = 28
private const val CONTENT_ELEVATION_DP = 18

/**
 * Whether the full-screen content is drawn as a flat card or as the receded
 * drawer companion (rounded corner + shadow). This is a boundary switch, not a
 * per-frame property: the rounded clip and shadow are static modifiers toggled
 * only when the content leaves or returns to its resting position, so per-frame
 * work stays limited to translation/scale/alpha.
 */
internal enum class ContentCardPhase { Flat, Receded }

/**
 * Pure, Compose-observable coordinator for [ContentCardPhase].
 *
 * The timing rules live here, separate from the animation loop, so they can be
 * tested without standing up a Compose tree:
 * - Opening starts flat and only recedes after the content has left its resting
 *   position, which [onContentProgress] enforces by guarding on progress > 0;
 *   [onRevealStarted] records the intent but must not recede the card on the
 *   first, still-full-screen frame.
 * - Closing settles back to flat only after the content animation has finished
 *   ([onContentSettled]); there is no earlier deadline that pops the shadow and
 *   clip while the content is still moving.
 */
internal class ContentCardCoordinator(initialOpen: Boolean) {
    var phase by mutableStateOf(if (initialOpen) ContentCardPhase.Receded else ContentCardPhase.Flat)
        private set

    fun onRevealStarted() {
        // No phase change: the first open frame must stay a full-screen flat
        // card. onContentProgress is what recedes it, once the content has left
        // its resting position.
    }

    fun onContentProgress(progress: Float) {
        // Recede only once the content has actually left its resting position.
        // progress must be strictly positive: zero still means the full-screen
        // card, and attaching the corner/shadow there is the snap this
        // coordinator exists to prevent.
        if (progress > 0f) {
            phase = ContentCardPhase.Receded
        }
    }

    fun onContentSettled() {
        phase = ContentCardPhase.Flat
    }
}

/** Compact app shell motion shared with `AppShell.ets`. */
@Composable
internal fun OpenBitFunCompactDrawer(
    open: Boolean,
    compact: Boolean,
    drawerWidth: Dp,
    onDismiss: () -> Unit,
    drawerContent: @Composable BoxScope.() -> Unit,
    content: @Composable BoxScope.() -> Unit,
) {
    BackHandler(enabled = open, onBack = onDismiss)

    // Translation and scale share one progress value so they stay in lockstep.
    // Only these two properties are driven per frame: they are cheap render-thread
    // layer properties, so the content never recomposes or re-lays-out per frame.
    // The rounded-corner clip and the shadow are deliberately *not* derived from
    // contentProgress — changing shape/clip/shadowElevation every frame forces the
    // full-screen content to re-rasterize its clip and shadow outline each frame
    // (and allocates a new RoundedCornerShape), which is the open-drawer jank.
    val contentProgress = remember { Animatable(if (open) 1f else 0f) }
    val density = LocalDensity.current
    val drawerWidthPx = with(density) { drawerWidth.toPx() }
    val contentShape = remember { RoundedCornerShape(CONTENT_RADIUS_DP.dp) }
    val interactionSource = remember { MutableInteractionSource() }
    val dismissSidebarLabel = stringResource(R.string.common_close)

    // The drawer and scrim run on `Animatable` so their reveal/hide values are
    // read only inside `graphicsLayer` blocks (layer-only updates, no relayout or
    // recomposition). Composition is gated by plain booleans that flip only at
    // open/close boundaries, so the screen is not recomposed every frame.
    //
    // The drawer's content (sessions, devices, workspaces) is the expensive half
    // of the open animation, not the geometry. Re-composing it on every open is
    // the connected-state jank, so once it has been shown it stays composed and is
    // hidden off-screen with its semantics cleared instead of being disposed. That
    // is only safe while this compact drawer owns the sidebar; a wide layout has a
    // permanent sidebar, so the resident copy is dropped when `compact` turns off.
    val drawerProgress = remember { Animatable(0f) }
    val scrimProgress = remember { Animatable(0f) }
    var drawerComposed by remember { mutableStateOf(open) }
    var drawerRevealed by remember { mutableStateOf(open) }
    var scrimComposed by remember { mutableStateOf(open) }
    // The content's card treatment (rounded clip + shadow) is a static modifier
    // toggled at open/close boundaries, not a per-frame graphicsLayer property.
    // The coordinator encodes exactly when those boundaries fire: not on the
    // first full-screen frame when opening, and not before the content has
    // settled when closing.
    val contentCard = remember { ContentCardCoordinator(open) }

    LaunchedEffect(open, compact) {
        if (!compact) {
            // Wide layout: the permanent sidebar owns this role. Drop any resident
            // copy so the window does not end up with a second, hidden Sidebar.
            contentProgress.snapTo(0f)
            drawerProgress.snapTo(0f)
            scrimProgress.snapTo(0f)
            drawerComposed = false
            drawerRevealed = false
            scrimComposed = false
            contentCard.onContentSettled()
        } else if (open) {
            drawerComposed = true
            drawerRevealed = true
            scrimComposed = true
            // Record the reveal without receding the card yet: the first frame
            // after opening is still the full-screen content at rest, and a 28dp
            // corner must not snap onto it before the content has moved.
            contentCard.onRevealStarted()
            coroutineScope {
                launch {
                    drawerProgress.animateTo(
                        targetValue = 1f,
                        animationSpec = tween(MotionDrawerRevealMillis, easing = OpenBitFunEaseOut),
                    )
                }
                launch {
                    scrimProgress.animateTo(
                        targetValue = 0.62f,
                        animationSpec = tween(MotionDrawerScrimMillis, easing = OpenBitFunEaseOut),
                    )
                }
                launch {
                    contentProgress.animateTo(
                        targetValue = 1f,
                        animationSpec = tween(MotionDrawerOpenMillis, easing = OpenBitFunEaseOut),
                    )
                }
                // Value guard, not a frame count: recede only once the content
                // animation has actually advanced past rest (progress > 0).
                // snapshotFlow observes the Animatable value and first{} yields
                // the first positive frame, so the corner never snaps onto a
                // still-full-screen frame. No fixed threshold or delay.
                contentCard.onContentProgress(
                    snapshotFlow { contentProgress.value }.first { it > 0f },
                )
            }
        } else if (drawerComposed) {
            coroutineScope {
                launch {
                    drawerProgress.animateTo(
                        targetValue = 0f,
                        animationSpec = tween(MotionDrawerHideMillis, easing = OpenBitFunEaseOut),
                    )
                    drawerRevealed = false
                }
                launch {
                    scrimProgress.animateTo(
                        targetValue = 0f,
                        animationSpec = tween(MotionDrawerScrimMillis, easing = OpenBitFunEaseOut),
                    )
                    scrimComposed = false
                }
                launch {
                    // The shadow and clip stay until the content itself has
                    // settled back to full screen — no earlier deadline pops
                    // them while the content is still moving.
                    contentProgress.animateTo(
                        targetValue = 0f,
                        animationSpec = tween(MotionDrawerCloseMillis, easing = OpenBitFunEaseOut),
                    )
                    contentCard.onContentSettled()
                }
            }
        }
    }

    Box(Modifier.fillMaxSize()) {
        // The open drawer's fill is a floor under the whole shell, not a panel
        // the width of the sidebar. The content card's rounded corners have to
        // curve onto something: a fill that stopped at the card's left edge
        // left them curving onto the page white, so a square-cornered grey
        // block sat against a rounded card with a white wedge between them.
        // Driven by contentProgress rather than drawerProgress so the floor is
        // never thinner than the card has already moved, in either direction.
        if (compact && drawerComposed) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(openBitFunColors.sidebar.background)
                    .graphicsLayer { alpha = contentProgress.value },
            )

            Box(
                modifier = Modifier
                    .width(drawerWidth)
                    .fillMaxHeight()
                    .graphicsLayer {
                        alpha = drawerProgress.value
                        translationX = if (drawerRevealed) {
                            drawerWidthPx * -0.1f * (1f - drawerProgress.value)
                        } else {
                            -(drawerWidthPx + 1f)
                        }
                    }
                    .then(
                        if (drawerRevealed) {
                            Modifier
                        } else {
                            Modifier.clearAndSetSemantics {}
                        },
                    ),
                content = drawerContent,
            )
        }

        Box(
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer {
                    translationX = drawerWidthPx * contentProgress.value
                    scaleX = 1f - (1f - CONTENT_SCALE_X) * contentProgress.value
                    scaleY = 1f - (1f - CONTENT_SCALE_Y) * contentProgress.value
                    transformOrigin = TransformOrigin(0f, com.openbitfun.mobile.app.ui.theme.generated.MobileDesignGeometry.ConversationHeaderHeight.toPx() / 2f / size.height.coerceAtLeast(1f))
                }
                .then(
                    if (contentCard.phase == ContentCardPhase.Receded) {
                        Modifier.shadow(
                            elevation = CONTENT_ELEVATION_DP.dp,
                            shape = contentShape,
                            clip = true,
                        )
                    } else {
                        Modifier
                    },
                ),
        ) {
            content()
            if (scrimComposed) {
                Box(
                    Modifier
                        .fillMaxSize()
                        // Use the semantic scrim token. Using the page
                        // background here makes a light-theme drawer paint a
                        // white sheet over the entire detail page, so opening
                        // the sidebar looks like the page disappeared.
                        .background(androidx.compose.material3.MaterialTheme.colorScheme.scrim)
                        .graphicsLayer { alpha = scrimProgress.value }
                        .clickable(
                            enabled = open,
                            interactionSource = interactionSource,
                            indication = null,
                            onClickLabel = dismissSidebarLabel,
                            onClick = onDismiss,
                        ),
                )
            }
        }
    }
}
