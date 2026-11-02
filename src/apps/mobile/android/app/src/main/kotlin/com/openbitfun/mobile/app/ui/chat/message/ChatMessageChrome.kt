package com.openbitfun.mobile.app.ui.chat.message

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.chat.rememberInlineImage
import com.openbitfun.mobile.app.ui.chat.tool.PillButton
import com.openbitfun.mobile.core.feature.session.ConversationImage

internal const val TYPING_DOTS_TEST_TAG: String = "chat-typing-dots"

/** One dot lit at a time, at the pace of `ChatTypingDots` in `ChatMessageChrome.ets`. */
private const val DOT_COUNT = 3
private const val FADE_MS = 180
private const val HOLD_MS = 360
private const val CYCLE_MS = HOLD_MS * DOT_COUNT
private const val DOT_DIM = 0.34f
private const val DOT_BRIGHT = 1f

/**
 * The agent has the turn but has not said anything yet, ported from
 * `ChatTypingDots` in `pages/components/ChatMessageChrome.ets`.
 *
 * Dots rather than the word "Replying…": the wait is usually a second or two,
 * and a caption that appears and disappears in that time is read as an event.
 * Once any token arrives this goes away — the arriving text says the same thing.
 */
@Composable
internal fun ChatTypingDots(modifier: Modifier) {
    val transition = rememberInfiniteTransition(label = "typing")
    Row(
        modifier = modifier.height(24.dp).testTag(TYPING_DOTS_TEST_TAG),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        repeat(DOT_COUNT) { index ->
            val alpha by transition.animateFloat(
                initialValue = DOT_DIM,
                targetValue = DOT_DIM,
                animationSpec = infiniteRepeatable(
                    animation = keyframes {
                        durationMillis = CYCLE_MS
                        DOT_DIM at 0 using LinearEasing
                        DOT_BRIGHT at FADE_MS using LinearEasing
                        DOT_BRIGHT at HOLD_MS using LinearEasing
                        DOT_DIM at HOLD_MS + FADE_MS using LinearEasing
                    },
                    repeatMode = RepeatMode.Restart,
                    // Each dot runs the same pulse a beat later than the one
                    // before it, which is what makes the row read as travelling.
                    initialStartOffset = StartOffset(index * HOLD_MS),
                ),
                label = "typing-dot-$index",
            )
            Box(
                modifier = Modifier
                    .size(6.dp)
                    .alpha(alpha)
                    .background(MaterialTheme.colorScheme.onSurfaceVariant, CircleShape),
            )
        }
    }
}

/**
 * The user's own words, ported from `ChatUserMessageBubble`.
 *
 * Images go inside the bubble rather than above it: they were part of the same
 * message, and floating them outside reads as a second, separate send.
 */
@Composable
internal fun ChatUserMessageBubble(
    text: String,
    images: List<ConversationImage>,
    modifier: Modifier,
) {
    val visibleText = text.trim().takeUnless {
        it == "(empty message)" || it == "(空消息)"
    }.orEmpty()
    // Capped rather than full width so a short question does not read as a
    // paragraph, and so the two sides of the exchange are distinguishable at a
    // glance before either is read.
    BoxWithConstraints(modifier.fillMaxWidth()) {
        Surface(
            color = MaterialTheme.colorScheme.surfaceVariant,
            shape = RoundedCornerShape(18.dp),
            modifier = Modifier.widthIn(max = maxWidth * 0.7f).align(Alignment.CenterEnd),
        ) {
            Column(
                modifier = Modifier.padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                MessageImageGallery(images = images, userStyle = true)
                if (visibleText.isNotEmpty()) {
                    Text(
                        visibleText,
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        }
    }
}

/**
 * What went wrong and the one thing to do about it, ported from
 * `ChatMessageRetryAction`.
 *
 * The wording differs by side because the failures differ: the user's message
 * never left the device, while the agent's reply started and stopped partway.
 * Saying "not delivered" under half an answer would be describing the wrong
 * event.
 */
@Composable
internal fun ChatMessageRetryAction(
    fromUser: Boolean,
    enabled: Boolean,
    onRetry: () -> Unit,
    modifier: Modifier,
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ChatCaption(
            stringResource(
                if (fromUser) R.string.chat_send_failed else R.string.chat_reply_interrupted,
            ),
            error = true,
        )
        PillButton(
            label = stringResource(R.string.chat_retry),
            primary = true,
            enabled = enabled,
            compact = true,
            onClick = onRetry,
            modifier = Modifier,
        )
    }
}

@Composable
internal fun MessageImageGallery(
    images: List<ConversationImage>,
    userStyle: Boolean,
) {
    if (images.isEmpty()) return
    val perRow = if (userStyle) 2 else 3
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        images.chunked(perRow).forEach { imageRow ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                imageRow.forEach { image -> ChatAttachedImage(image, userStyle) }
            }
        }
    }
}

@Composable
internal fun ChatAttachedImage(image: ConversationImage, userStyle: Boolean = false) {
    // Anything the relay did not carry inline shows as a name rather than a
    // broken frame; see [decodeInlineImage].
    val bitmap = rememberInlineImage(image.dataUrl)
    val imageSize = if (userStyle) 112.dp else 92.dp
    val shape = RoundedCornerShape(if (userStyle) 12.dp else 14.dp)
    if (bitmap != null) {
        Image(
            bitmap = bitmap.asImageBitmap(),
            contentDescription = image.name,
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .size(imageSize)
                .clip(shape)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape),
        )
    } else {
        Surface(
            shape = shape,
            color = MaterialTheme.colorScheme.surfaceVariant,
            border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            modifier = Modifier.size(imageSize),
        ) {
            Box(Modifier.padding(8.dp), contentAlignment = Alignment.Center) {
                ChatCaption(image.name.ifBlank { stringResource(R.string.chat_image) }, error = false)
            }
        }
    }
}

@Composable
internal fun ChatCaption(text: String, error: Boolean) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = if (error) {
            MaterialTheme.colorScheme.error
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        },
    )
}
