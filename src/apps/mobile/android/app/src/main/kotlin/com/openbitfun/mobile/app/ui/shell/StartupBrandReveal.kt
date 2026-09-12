package com.openbitfun.mobile.app.ui.shell

import android.graphics.Paint
import android.graphics.Typeface
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignColors
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignTypography
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignMotion
import kotlin.math.*

/** Presentation-only cold-start timeline; Compose honors the system animator scale. */
@Composable
internal fun StartupBrandReveal(onFinished: () -> Unit) {
    val progress = remember { Animatable(0f) }
    val finish by rememberUpdatedState(onFinished)
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) finish()
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(Unit) {
        progress.animateTo(1f, tween(MobileDesignMotion.StartupBrand, easing = LinearEasing))
        finish()
    }
    val p = progress.value
    val t = min(p / .65f * .9f, .9f)
    val settle = smooth((p - .66f) / .19f)
    val ink = MaterialTheme.colorScheme.onBackground
    val dotColor = MobileDesignColors.Light.BrandDot
    val paint = remember { Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        textAlign = Paint.Align.CENTER
        textSize = MobileDesignTypography.BrandWordmark.fontSize.value
    } }
    val widths = remember { listOf(30f,25f,24f,25f,28f,10f,16f,24f,25f,25f) }
    val positions = remember { widths.runningFold(24f) { x, w -> x + w } }
    BoxWithConstraints(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)
        .graphicsLayer { alpha = 1 - smooth((p - .97f) / .03f) }
        .clearAndSetSemantics { }
        .pointerInput(Unit) { awaitPointerEventScope { while (true) awaitPointerEvent().changes.forEach { it.consume() } } },
        contentAlignment = Alignment.Center) {
        val stageScale = min(1f, ((maxWidth.value - 32f) / 280f).coerceAtLeast(.1f))
        Box(Modifier.size(280.dp, 240.dp).graphicsLayer { scaleX = stageScale; scaleY = stageScale }) {
            val markProgress = ((p - .66f) / .19f).coerceIn(0f, 1f)
            val q = markProgress - 1
            val markScale = .65f + .35f * (1 + 2.2f*q*q*q + 1.2f*q*q)
            WelcomeBrandFlow(
                Modifier.offset(94.dp, 14.dp).size(92.dp).graphicsLayer {
                    alpha = ease(markProgress); scaleX = markScale; scaleY = markScale
                })
            Canvas(Modifier.fillMaxSize()) {
                drawIntoCanvas { canvas ->
                    val native = canvas.nativeCanvas
                    native.save(); native.scale(size.width / 280f, size.height / 240f)
                    "OpenBıtFun".forEachIndexed { i, ch ->
                        val reveal = ease((t - (.19f + i * .048f)) / .05f)
                        val phase = ((t - (.19f + i * .048f)) / .085f).coerceIn(0f,1f)
                        val bounce = sin(phase * PI).toFloat() * (1-phase).pow(.65f)
                        val x = positions[i] + widths[i]/2
                        val y = 110 + 42*settle + 7*(1-reveal)-8*bounce
                        paint.color = ink.toArgb(); paint.alpha = (255*reveal).toInt()
                        native.save(); native.rotate((if(i%2==0) -1 else 1)*bounce*6, x, y)
                        native.drawText(ch.toString(), x, y-(paint.fontMetrics.ascent+paint.fontMetrics.descent)/2, paint)
                        native.restore()
                    }
                    var x = 9f; var y = 110f; var sx=1f; var sy=1f
                    for (i in 0..9) {
                        val end=.19f+i*.048f; val begin=if(i==0) end-.065f else end-.048f
                        val from=if(i==0) 9f else positions[i]+10; val to=positions[i+1]+10
                        if(t>=end){x=to;continue}
                        if(t>=begin){
                            val step=((t-begin)/(end-begin)).coerceIn(0f,1f)
                            val hop=((step-.16f)/.84f).coerceIn(0f,1f)
                            val squash=sin((step/.16f).coerceIn(0f,1f)*PI).toFloat()
                            x=from+(to-from)*smooth(hop); y-=4*hop*(1-hop)*(if(i==0)20 else 15)
                            sx=1+.2f*squash;sy=1-.18f*squash
                        }; break
                    }
                    if(t>=.70f){
                        val flight=((t-.70f)/.16f).coerceIn(0f,1f);val travel=smooth(flight)
                        x+=(positions[5]+5-x)*travel;y=110-15*travel-sin(PI*flight).toFloat()*44
                        sx=1+(7.35f/9-1)*travel;sy=sx
                        if(t>.86f&&t<.9f)y-=sin((t-.86f)/.04f*PI).toFloat()*2
                    }
                    y+=42*settle;paint.color=dotColor.toArgb()
                    val halo=sin(((t-.86f)/.04f).coerceIn(0f,1f)*PI).toFloat()
                    paint.alpha=(255*.16f*halo).toInt().coerceIn(0,255);native.drawCircle(x,y,11f,paint)
                    paint.alpha=(255*ease(t/.12f)).toInt();native.save();native.scale(sx,sy,x,y)
                    native.drawCircle(x,y,4.5f,paint);native.restore();native.restore()
                }
            }
        }
    }
}
private fun smooth(x: Float): Float { val p=x.coerceIn(0f,1f);return p*p*(3-2*p) }
private fun ease(x: Float): Float = 1-(1-x.coerceIn(0f,1f)).pow(3)
