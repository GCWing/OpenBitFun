package com.openbitfun.mobile.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignColors
import com.openbitfun.mobile.app.ui.theme.generated.MobileDesignTypography
import com.openbitfun.mobile.app.ui.theme.generated.MobileTextScale

/**
 * The palette, ported from the HarmonyOS client's `Theme.ets` plus its
 * `resources/base` and `resources/dark` colour elements.
 *
 * Stock `lightColorScheme()` / `darkColorScheme()` is Material's purple baseline,
 * which is not what the other client looks like: OpenBitFun's is a warm paper-and-ink
 * palette. Every screen here already speaks in Material roles rather than
 * literals, so aligning the two clients is a matter of what those roles resolve
 * to — nothing below this file had to change to get the new colours.
 *
 * Additional semantic colors cover app-owned surfaces such as media and toasts.
 */
private val LightTokens = MobileDesignColors.Light
private val DarkTokens = MobileDesignColors.Dark
private val InkLight = LightTokens.Ink
private val InkDark = DarkTokens.Ink
private val ContentOnAction = LightTokens.ContentOnAction

private val LightScheme = lightColorScheme(
    primary = LightTokens.PrimaryAction,
    onPrimary = ContentOnAction,
    primaryContainer = LightTokens.Soft,
    onPrimaryContainer = InkLight,
    secondary = LightTokens.Accent,
    onSecondary = ContentOnAction,
    secondaryContainer = LightTokens.Soft,
    onSecondaryContainer = InkLight,
    // file_link: the one saturated hue in the palette. Material has no link
    // role, so it lands on tertiary — which is also the "busy" connection dot.
    tertiary = LightTokens.FileLink,
    onTertiary = ContentOnAction,
    background = LightTokens.PageBg,
    onBackground = InkLight,
    surface = LightTokens.Card,
    onSurface = InkLight,
    surfaceVariant = LightTokens.Soft,
    onSurfaceVariant = LightTokens.Muted,
    // The whole container family, not only the two a card reads. Material fills
    // any role left unset from its own purple baseline, and the roles nothing in
    // this app names by hand are exactly the ones its components reach for on
    // their own — `ModalBottomSheet` takes surfaceContainerLow, elevation takes
    // surfaceTint, a snackbar takes inverseSurface. Leaving them out painted a
    // lilac sheet under a paper-coloured page.
    surfaceContainerLowest = LightTokens.Card,
    surfaceContainerLow = LightTokens.FloatingPanelBg,
    surfaceContainer = LightTokens.FloatingPanelBg,
    surfaceContainerHigh = LightTokens.Soft,
    surfaceContainerHighest = LightTokens.Line,
    surfaceBright = LightTokens.PageBg,
    surfaceDim = LightTokens.Line,
    // No tint: the source's cards are flat fills, and a tinted overlay would put
    // the ink colour back over every raised surface.
    surfaceTint = LightTokens.Card,
    inverseSurface = DarkTokens.Soft,
    inverseOnSurface = InkDark,
    inversePrimary = LightTokens.Line,
    outline = LightTokens.Subtle,
    outlineVariant = LightTokens.Line,
    error = LightTokens.StatusDanger,
    onError = ContentOnAction,
    // The HarmonyOS palette has no error container; rather than invent a hue,
    // a failure card is the same soft surface with the error colour on it.
    errorContainer = LightTokens.Soft,
    onErrorContainer = LightTokens.StatusDanger,
    scrim = LightTokens.Scrim,
)

private val DarkScheme = darkColorScheme(
    primary = DarkTokens.PrimaryAction,
    onPrimary = ContentOnAction,
    primaryContainer = DarkTokens.Soft,
    onPrimaryContainer = InkDark,
    secondary = DarkTokens.Accent,
    onSecondary = ContentOnAction,
    secondaryContainer = DarkTokens.Soft,
    onSecondaryContainer = InkDark,
    tertiary = DarkTokens.FileLink,
    onTertiary = DarkTokens.PageBg,
    background = DarkTokens.PageBg,
    onBackground = InkDark,
    surface = DarkTokens.Card,
    onSurface = InkDark,
    surfaceVariant = DarkTokens.Soft,
    onSurfaceVariant = DarkTokens.Muted,
    surfaceContainerLowest = DarkTokens.StartWindowBackground,
    surfaceContainerLow = DarkTokens.FloatingPanelBg,
    surfaceContainer = DarkTokens.FloatingPanelBg,
    surfaceContainerHigh = DarkTokens.Soft,
    surfaceContainerHighest = DarkTokens.Line,
    surfaceBright = DarkTokens.Accent,
    surfaceDim = DarkTokens.PageBg,
    surfaceTint = DarkTokens.Card,
    inverseSurface = InkDark,
    inverseOnSurface = DarkTokens.Card,
    inversePrimary = DarkTokens.Line,
    outline = DarkTokens.Subtle,
    outlineVariant = DarkTokens.Line,
    error = DarkTokens.StatusDanger,
    onError = ContentOnAction,
    errorContainer = DarkTokens.Soft,
    onErrorContainer = DarkTokens.StatusDanger,
    scrim = DarkTokens.Scrim,
)

/**
 * Palette entries Material has no role for.
 *
 * [success] is the connection dot's "connected" green — it is not `primary`,
 * because primary here is near-black ink and a black dot reads as "off".
 */
internal data class OpenBitFunColors(
    val transparent: Color,
    val statusSuccess: Color,
    val shellScrim: Color,
    val mediaBackground: Color,
    val mediaScrim: Color,
    val mediaControlBackground: Color,
    val toastBackground: Color,
    val shadowSubtle: Color,
    val shadowMedium: Color,
    val shadowStrong: Color,
    val floatingBorder: Color,
    val heroBackground: Color,
    val heroSurface: Color,
    val heroAccent: Color,
    val heroSecondary: Color,
    val sidebar: SidebarColors,
    val code: CodeSyntaxColors,
)

/**
 * The navigation chrome, held apart from the page palette above.
 *
 * The desktop client paints its sidebar from a separate family — `surface.chrome`
 * one step off the scene, hairlines and selection fills carried as alpha over it
 * — so the rail reads as structure rather than as another sheet of paper. These
 * are those roles, one for one, and they belong to the sidebar only: a page that
 * borrows them stops looking like the desktop, not more like it.
 *
 * [selection], [line] and [hover] are translucent on purpose. They are meant to
 * composite over [background]; flattening them loses the rail's depth.
 */
internal data class SidebarColors(
    val background: Color,
    val raised: Color,
    val line: Color,
    val hover: Color,
    val selection: Color,
    val ink: Color,
    val muted: Color,
    val subtle: Color,
)

/**
 * What `CodeSyntaxTokenKind` looks like, one entry per kind that is not plain
 * text. Straight from the `code_*` colour elements of the HarmonyOS client.
 *
 * [targetBackground] is not a token colour: it paints behind whichever lines the
 * agent's reference named, so a `file.kt:80-92` preview shows *where* rather than
 * only *what*.
 */
internal data class CodeSyntaxColors(
    val lineNumber: Color,
    val keyword: Color,
    val string: Color,
    val number: Color,
    val comment: Color,
    val function: Color,
    val type: Color,
    val constant: Color,
    val property: Color,
    val targetBackground: Color,
)

private val LightExtras = OpenBitFunColors(
    transparent = LightTokens.Transparent,
    statusSuccess = LightTokens.StatusSuccess,
    shellScrim = LightTokens.ShellScrim,
    mediaBackground = LightTokens.MediaBackground,
    mediaScrim = LightTokens.MediaScrim,
    mediaControlBackground = LightTokens.MediaControlBackground,
    toastBackground = LightTokens.ToastBackground,
    shadowSubtle = LightTokens.ShadowSubtle,
    shadowMedium = LightTokens.ShadowMedium,
    shadowStrong = LightTokens.ShadowStrong,
    floatingBorder = LightTokens.FloatingBorder,
    heroBackground = LightTokens.ConnectHeroBg,
    heroSurface = LightTokens.ConnectHeroSurface,
    heroAccent = LightTokens.ConnectHeroAccent,
    heroSecondary = LightTokens.ConnectHeroSecondary,
    sidebar = SidebarColors(
        background = LightTokens.SidebarBg,
        raised = LightTokens.SidebarRaised,
        line = LightTokens.SidebarLine,
        hover = LightTokens.SidebarHover,
        selection = LightTokens.SidebarSelection,
        ink = LightTokens.SidebarInk,
        muted = LightTokens.SidebarMuted,
        subtle = LightTokens.SidebarSubtle,
    ),
    code = CodeSyntaxColors(
        lineNumber = LightTokens.CodeLineNumber,
        keyword = LightTokens.CodeKeyword,
        string = LightTokens.CodeString,
        number = LightTokens.CodeNumber,
        comment = LightTokens.CodeComment,
        function = LightTokens.CodeFunction,
        type = LightTokens.CodeType,
        constant = LightTokens.CodeConstant,
        property = LightTokens.CodeProperty,
        targetBackground = LightTokens.CodeTargetBg,
    ),
)

private val DarkExtras = OpenBitFunColors(
    transparent = DarkTokens.Transparent,
    statusSuccess = DarkTokens.StatusSuccess,
    shellScrim = DarkTokens.ShellScrim,
    mediaBackground = DarkTokens.MediaBackground,
    mediaScrim = DarkTokens.MediaScrim,
    mediaControlBackground = DarkTokens.MediaControlBackground,
    toastBackground = DarkTokens.ToastBackground,
    shadowSubtle = DarkTokens.ShadowSubtle,
    shadowMedium = DarkTokens.ShadowMedium,
    shadowStrong = DarkTokens.ShadowStrong,
    floatingBorder = DarkTokens.FloatingBorder,
    heroBackground = DarkTokens.ConnectHeroBg,
    heroSurface = DarkTokens.ConnectHeroSurface,
    heroAccent = DarkTokens.ConnectHeroAccent,
    heroSecondary = DarkTokens.ConnectHeroSecondary,
    sidebar = SidebarColors(
        background = DarkTokens.SidebarBg,
        raised = DarkTokens.SidebarRaised,
        line = DarkTokens.SidebarLine,
        hover = DarkTokens.SidebarHover,
        selection = DarkTokens.SidebarSelection,
        ink = DarkTokens.SidebarInk,
        muted = DarkTokens.SidebarMuted,
        subtle = DarkTokens.SidebarSubtle,
    ),
    code = CodeSyntaxColors(
        lineNumber = DarkTokens.CodeLineNumber,
        keyword = DarkTokens.CodeKeyword,
        string = DarkTokens.CodeString,
        number = DarkTokens.CodeNumber,
        comment = DarkTokens.CodeComment,
        function = DarkTokens.CodeFunction,
        type = DarkTokens.CodeType,
        constant = DarkTokens.CodeConstant,
        property = DarkTokens.CodeProperty,
        targetBackground = DarkTokens.CodeTargetBg,
    ),
)

private val LocalOpenBitFunColors = staticCompositionLocalOf { LightExtras }

/**
 * Harmony's mobile surfaces use a small, explicit type scale rather than the
 * platform Material defaults. Keeping the roles here makes every remaining
 * Material control start from the same geometry as the ArkUI counterpart.
 */
private val OpenBitFunTypography = androidx.compose.material3.Typography(
    displayLarge = MobileDesignTypography.DisplayLarge,
    displayMedium = MobileDesignTypography.DisplayMedium,
    displaySmall = MobileDesignTypography.DisplaySmall,
    headlineLarge = MobileDesignTypography.HeadlineLarge,
    headlineMedium = MobileDesignTypography.HeadlineMedium,
    headlineSmall = MobileDesignTypography.HeadlineSmall,
    titleLarge = MobileDesignTypography.TitleLarge,
    titleMedium = MobileDesignTypography.TitleMedium,
    titleSmall = MobileDesignTypography.TitleSmall,
    bodyLarge = MobileDesignTypography.BodyLarge,
    bodyMedium = MobileDesignTypography.BodyMedium,
    bodySmall = MobileDesignTypography.BodySmall,
    labelLarge = MobileDesignTypography.LabelLarge,
    labelMedium = MobileDesignTypography.LabelMedium,
    labelSmall = MobileDesignTypography.LabelSmall,
)

/** The extra palette for the theme in scope. Reads like `MaterialTheme.colorScheme`. */
internal val openBitFunColors: OpenBitFunColors
    @Composable @ReadOnlyComposable get() = LocalOpenBitFunColors.current

@Composable
internal fun OpenBitFunTheme(dark: Boolean, content: @Composable () -> Unit) {
    CompositionLocalProvider(
        LocalOpenBitFunColors provides if (dark) DarkExtras else LightExtras,
        LocalDensity provides textScaledDensity(),
    ) {
        MaterialTheme(
            colorScheme = if (dark) DarkScheme else LightScheme,
            typography = OpenBitFunTypography,
            content = content,
        )
    }
}

/**
 * The same ramp reads physically larger on a screen whose dp is bigger than the
 * reference the sizes were tuned on, so every `sp` under the theme is folded by
 * the display's own pitch. It rides on top of the user's font-size preference
 * rather than replacing it, and dp geometry is untouched.
 */
@Composable
@ReadOnlyComposable
private fun textScaledDensity(): Density {
    val base = LocalDensity.current
    val metrics = LocalContext.current.resources.displayMetrics
    val factor = MobileTextScale.resolve(xdpi = metrics.xdpi, density = metrics.density)
    return if (factor == 1f) base else Density(base.density, base.fontScale * factor)
}
