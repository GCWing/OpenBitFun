package com.openbitfun.mobile.app.ui.shell

import android.graphics.Paint
import android.graphics.DashPathEffect
import androidx.core.graphics.PathParser
import androidx.compose.foundation.Canvas
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlin.coroutines.coroutineContext

private val contourData = listOf(
    "M154.860 59.584 Q167.500 59.584 173.820 70.531 L200.680 117.053 Q207.000 128.000 200.680 138.947 L173.820 185.469 Q167.500 196.416 154.860 196.416 L101.140 196.416 Q88.500 196.416 82.180 185.469 L55.320 138.947 Q49.000 128.000 55.320 117.053 L82.180 70.531 Q88.500 59.584 101.140 59.584 Z",
    "M152.788 57.185 Q165.682 56.702 172.547 67.628 L201.722 114.060 Q208.586 124.985 202.557 136.392 L176.934 184.875 Q170.905 196.282 158.011 196.765 L103.212 198.815 Q90.318 199.298 83.453 188.372 L54.278 141.940 Q47.414 131.015 53.443 119.608 L79.066 71.125 Q85.095 59.718 97.989 59.235 Z",
    "M150.574 54.847 Q163.702 53.863 171.119 64.741 L202.639 110.973 Q210.056 121.851 204.343 133.713 L180.066 184.126 Q174.353 195.988 161.224 196.972 L105.426 201.153 Q92.298 202.137 84.881 191.259 L53.361 145.027 Q45.944 134.149 51.657 122.287 L75.934 71.874 Q81.647 60.012 94.776 59.028 Z",
    "M148.218 52.578 Q161.562 51.074 169.537 61.879 L203.427 107.798 Q211.401 118.603 206.031 130.911 L183.208 183.221 Q177.838 195.529 164.494 197.032 L107.782 203.422 Q94.438 204.926 86.463 194.121 L52.573 148.202 Q44.599 137.397 49.969 125.089 L72.792 72.779 Q78.162 60.471 91.506 58.968 Z",
    "M145.724 50.384 Q159.263 48.344 167.799 59.048 L204.079 104.542 Q212.616 115.246 207.614 127.991 L186.355 182.157 Q181.353 194.902 167.814 196.943 L110.276 205.616 Q96.737 207.656 88.201 196.952 L51.921 151.458 Q43.384 140.754 48.386 128.009 L69.645 73.843 Q74.647 61.098 88.186 59.057 Z",
    "M143.094 48.274 Q156.805 45.680 165.907 56.257 L204.592 101.209 Q213.694 111.786 209.085 124.957 L189.498 180.935 Q184.889 194.106 171.178 196.700 L112.906 207.726 Q99.195 210.320 90.093 199.743 L51.408 154.791 Q42.306 144.214 46.915 131.043 L66.502 75.065 Q71.111 61.894 84.822 59.300 Z",
    "M140.330 46.254 Q154.191 43.091 163.861 53.512 L204.959 97.806 Q214.629 108.227 210.439 121.813 L192.629 179.551 Q188.438 193.137 174.578 196.301 L115.670 209.746 Q101.809 212.909 92.139 202.488 L51.041 158.194 Q41.371 147.773 45.561 134.187 L63.371 76.449 Q67.562 62.863 81.422 59.699 Z",
    "M137.437 44.331 Q151.423 40.584 161.662 50.823 L205.177 94.338 Q215.416 104.577 211.669 118.563 L195.741 178.007 Q191.993 191.993 178.007 195.741 L118.563 211.669 Q104.577 215.416 94.338 205.177 L50.823 161.662 Q40.584 151.423 44.331 137.437 L60.259 77.993 Q64.007 64.007 77.993 60.259 Z",
    "M134.416 42.513 Q148.504 38.167 159.311 48.195 L205.242 90.813 Q216.049 100.840 212.769 115.214 L198.826 176.300 Q195.545 190.673 181.458 195.019 L121.584 213.487 Q107.496 217.833 96.689 207.805 L50.758 165.187 Q39.951 155.160 43.231 140.786 L57.174 79.700 Q60.455 65.327 74.542 60.981 Z",
    "M131.272 40.805 Q145.436 35.849 156.810 45.637 L205.149 87.237 Q216.523 97.025 213.733 111.769 L201.877 174.431 Q199.087 189.175 184.923 194.131 L124.728 215.195 Q110.564 220.151 99.190 210.363 L50.851 168.763 Q39.477 158.975 42.267 144.231 L54.123 81.569 Q56.913 66.825 71.077 61.869 Z",
    "M128.010 39.216 Q142.223 33.637 154.160 43.157 L204.895 83.616 Q216.832 93.136 214.556 108.234 L204.885 172.401 Q202.609 187.499 188.396 193.077 L127.990 216.784 Q113.777 222.363 101.840 212.843 L51.105 172.384 Q39.168 162.864 41.444 147.766 L51.115 83.599 Q53.391 68.501 67.604 62.923 Z",
    "M124.633 37.750 Q138.869 31.539 151.365 40.762 L204.475 79.959 Q216.972 89.182 215.233 104.616 L207.842 170.209 Q206.103 185.643 191.868 191.854 L131.367 218.250 Q117.131 224.461 104.635 215.238 L51.525 176.041 Q39.028 166.818 40.767 151.384 L48.158 85.791 Q49.897 70.357 64.132 64.146 Z",
    "M121.147 36.415 Q135.377 29.562 148.427 38.459 L203.889 76.272 Q216.938 85.169 215.758 100.920 L210.742 167.858 Q209.562 183.608 195.331 190.461 L134.853 219.585 Q120.623 226.438 107.573 217.541 L52.111 179.728 Q39.062 170.831 40.242 155.080 L45.258 88.142 Q46.438 72.392 60.669 65.539 Z",
    "M117.556 35.216 Q131.752 27.713 145.348 36.256 L203.131 72.563 Q216.727 81.106 216.127 97.152 L213.575 165.347 Q212.975 181.393 198.778 188.896 L138.444 220.784 Q124.248 228.287 110.652 219.744 L52.869 183.437 Q39.273 174.894 39.873 158.848 L42.425 90.653 Q43.025 74.607 57.222 67.104 Z",
    "M113.866 34.160 Q128.000 26.000 142.134 34.160 L202.201 68.840 Q216.335 77.000 216.335 93.320 L216.335 162.680 Q216.335 179.000 202.201 187.160 L142.134 221.840 Q128.000 230.000 113.866 221.840 L53.799 187.160 Q39.665 179.000 39.665 162.680 L39.665 93.320 Q39.665 77.000 53.799 68.840 Z"
)
private val contourLengths = listOf(460.633f,470.212f,479.792f,489.371f,498.950f,508.529f,518.108f,527.687f,537.267f,546.846f,556.425f,566.004f,575.583f,585.163f,594.742f)
@Composable
internal fun WelcomeBrandFlow(modifier: Modifier, sweep: Boolean = false) {
    val paths=remember { contourData.map { PathParser.createPathFromPathData(it)!! } }
    val paint=remember { Paint(Paint.ANTI_ALIAS_FLAG).apply { style=Paint.Style.STROKE;strokeWidth=1f } }
    var phase by remember { mutableFloatStateOf(0f) }
    var moving by remember { mutableStateOf(false) }
    val lifecycle=LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            moving=coroutineContext[androidx.compose.ui.MotionDurationScale]?.scaleFactor!=0f
            if(moving) while(isActive) { phase=(System.currentTimeMillis() % (if(sweep) 5000 else 18000)).toFloat() / (if(sweep) 5000f else 18000f);delay(33) }
        }
    }
    val ink=MaterialTheme.colorScheme.onBackground
    Canvas(modifier) {
        drawIntoCanvas { canvas ->
            val c=canvas.nativeCanvas;c.save();c.scale(size.width/256,size.height/256);paint.color=ink.toArgb()
            if(sweep) {
                val shift=(minOf(1f,phase/.75f)*2-1)*256
                val colors=floatArrayOf(.16f,.25f,1f,.25f,.16f).map { alpha ->
                    ink.copy(alpha = if(moving) alpha else .5f).toArgb()
                }.toIntArray()
                paint.pathEffect=null;paint.alpha=255;paint.strokeWidth=1.45f
                paint.shader=android.graphics.LinearGradient(shift,shift,256+shift,256+shift,colors,
                    floatArrayOf(0f,.46f,.55f,.65f,1f),android.graphics.Shader.TileMode.CLAMP)
                paths.forEach { c.drawPath(it,paint) };paint.shader=null
            } else paths.forEachIndexed { index,path ->
                paint.pathEffect=null;paint.alpha=64;c.drawPath(path,paint)
                if(moving) listOf(.34f,.26f,.18f).forEachIndexed { layer,length ->
                    val total=contourLengths[index]
                    paint.pathEffect=DashPathEffect(floatArrayOf(total*length/2,total*(1-length),total*length/2,0f),-total*(phase+index*.03f))
                    paint.alpha=(255*listOf(.12f,.14f,.36f)[layer]).toInt();c.drawPath(path,paint)
                }
            };c.restore()
        }
    }
}
