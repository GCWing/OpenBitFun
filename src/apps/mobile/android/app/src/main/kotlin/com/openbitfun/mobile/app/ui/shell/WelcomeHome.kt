package com.openbitfun.mobile.app.ui.shell

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.openbitfun.mobile.app.R
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignColors
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignGeometry as G
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlin.math.*

/** A welcome layout, C text motion. Only presentation state is kept here. */
@Composable
internal fun WelcomeHome(onLogin: () -> Unit, onScan: () -> Unit, signedIn: Boolean = false, modifier: Modifier = Modifier) {
    val phrases = listOf("OpenBitFun", stringResource(R.string.welcome_work), stringResource(R.string.welcome_play), stringResource(R.string.welcome_yours))
    val elapsed = remember { Animatable(0f) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle, phrases) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            val reduced = currentCoroutineContext()[androidx.compose.ui.MotionDurationScale]?.scaleFactor == 0f
            if (reduced) { elapsed.snapTo(2700f); return@repeatOnLifecycle }
            while (currentCoroutineContext().isActive) {
                elapsed.snapTo(0f)
                elapsed.animateTo(phrases.sumOf { welcomeDuration(it) }.toFloat(), tween(phrases.sumOf { welcomeDuration(it) }, easing = LinearEasing))
            }
        }
    }
    var time = elapsed.value
    var phrase = phrases.first()
    for (item in phrases) { phrase = item; if (time < welcomeDuration(item)) break; time -= welcomeDuration(item) }
    val ink = MaterialTheme.colorScheme.onBackground
    BoxWithConstraints(modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.TopCenter) {
        val pageHeight = maxHeight.coerceAtLeast(540.dp)
        Column(Modifier.widthIn(max = G.WelcomeMaxWidth).fillMaxWidth().verticalScroll(rememberScrollState()).heightIn(min = pageHeight)) {
            Row(Modifier.fillMaxWidth().height(G.WelcomeHeaderHeight).padding(horizontal = G.WelcomeGutter), verticalAlignment = Alignment.CenterVertically) {
                Row { "OpenBitFun".forEach { c -> WelcomeGlyph(c, G.WelcomeHeaderWordSize.value, Modifier) } }
            }
            Box(Modifier.fillMaxWidth().height((pageHeight - G.WelcomeHeaderHeight - 228.dp).coerceAtLeast(270.dp)), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.offset(y = (-28).dp)) {
                    WelcomeBrandFlow(Modifier.size(G.WelcomeMarkSize))
                    Spacer(Modifier.height(29.dp))
                    Row(Modifier.height(48.dp).clearAndSetSemantics { contentDescription = "OpenBitFun" }, verticalAlignment = Alignment.CenterVertically) {
                        phrase.forEachIndexed { index, c ->
                            val p = ((time - 180 - index * 55) / 800).coerceIn(0f, 1f)
                            val ease = 1 - (1-p).pow(3)
                            val bump = sin(p * PI).toFloat() * (1-p)
                            val out = ((time-welcomeDuration(phrase)+650)/650).coerceIn(0f,1f)
                            WelcomeGlyph(c, if(phrase.length>12) 27f else G.WelcomeWordSize.value, Modifier.graphicsLayer {
                                    alpha = (p*3).coerceIn(0f,1f)*(1-out)
                                    translationX = ((1-ease)*38-bump*5-out*out*30).dp.toPx()
                                    scaleX = 1+bump*.045f; scaleY = scaleX
                                })
                        }
                    }
                }
            }
            Column(Modifier.fillMaxWidth().background(MobileDesignColors.Light.WelcomeDock, RoundedCornerShape(topStart = G.WelcomeDockRadius, topEnd = G.WelcomeDockRadius))
                .padding(start = G.WelcomeGutter, end = G.WelcomeGutter, top = G.WelcomeGutter, bottom = G.WelcomeDockBottom), verticalArrangement = Arrangement.spacedBy(G.WelcomeButtonGap)) {
                WelcomeAction(stringResource(if (signedIn) R.string.sidebar_connect_desktop else R.string.welcome_login), onLogin)
                WelcomeAction(stringResource(R.string.welcome_scan), onScan, scan = true)
                // Reserve the optional MiniApp row; this host does not ship a MiniApp runtime yet.
                Spacer(Modifier.height(44.dp))
            }
        }
    }
}

@Composable
private fun WelcomeAction(label: String, onClick: () -> Unit, scan: Boolean = false) {
    Button(onClick, Modifier.fillMaxWidth().height(G.WelcomeButtonHeight), shape = RoundedCornerShape(28.dp),
        colors = ButtonDefaults.buttonColors(containerColor = MobileDesignColors.Light.WelcomeButton, contentColor = MobileDesignColors.Light.WelcomeButtonLabel)) {
        if(scan) { Icon(painterResource(R.drawable.ic_symbol_qrcode_viewfinder), null, Modifier.size(20.dp)); Spacer(Modifier.width(10.dp)) }
        Text(label, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
    }
}
private fun welcomeDuration(word: String) = 250+word.length*185+(if(word=="OpenBitFun")600 else 0)+1800+650

@Composable
private fun WelcomeGlyph(letter: Char, fontSize: Float, modifier: Modifier) {
    Text(if(letter=='i') "ı" else letter.toString(), fontSize = fontSize.sp,
        fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onBackground,
        modifier = modifier.drawWithContent {
            drawContent()
            if(letter=='i') drawCircle(MobileDesignColors.Light.BrandDot, radius = fontSize.sp.toPx()*.07f,
                center = Offset(size.width/2, fontSize.sp.toPx()*.25f))
        })
}
