package com.rafaypair.android.ui.theme

import android.app.Activity
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView

val Plum900 = Color(0xFF211526)
val Plum800 = Color(0xFF322039)
val Plum700 = Color(0xFF4B2B4D)
val Coral500 = Color(0xFFFF5E78)
val Coral300 = Color(0xFFFFA0AF)
val Cream50 = Color(0xFFFFF8F6)
val Mint400 = Color(0xFF69D8BB)
val Ink900 = Color(0xFF211D24)
val Ink600 = Color(0xFF665D68)

private val LightColors = lightColorScheme(
    primary = Color(0xFFB4234E),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFFD9E0),
    onPrimaryContainer = Color(0xFF3F0015),
    secondary = Color(0xFF77565D),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFFFD9E0),
    onSecondaryContainer = Color(0xFF2C151A),
    tertiary = Color(0xFF276B5B),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFB1F1DC),
    onTertiaryContainer = Color(0xFF002019),
    background = Cream50,
    onBackground = Ink900,
    surface = Color(0xFFFFFBFF),
    onSurface = Ink900,
    surfaceVariant = Color(0xFFF4E6EA),
    onSurfaceVariant = Ink600,
    outline = Color(0xFF837377),
    error = Color(0xFFBA1A1A),
)

private val DarkColors = darkColorScheme(
    primary = Coral300,
    onPrimary = Color(0xFF65002A),
    primaryContainer = Color(0xFF8F153A),
    onPrimaryContainer = Color(0xFFFFD9E0),
    secondary = Color(0xFFE7BDC5),
    onSecondary = Color(0xFF44292F),
    secondaryContainer = Color(0xFF5D3F45),
    onSecondaryContainer = Color(0xFFFFD9E0),
    tertiary = Color(0xFF95D5C1),
    onTertiary = Color(0xFF00382D),
    tertiaryContainer = Color(0xFF095143),
    onTertiaryContainer = Color(0xFFB1F1DC),
    background = Plum900,
    onBackground = Color(0xFFF2E7F1),
    surface = Plum800,
    onSurface = Color(0xFFF2E7F1),
    surfaceVariant = Plum700,
    onSurfaceVariant = Color(0xFFD9C3D5),
    outline = Color(0xFFA88FA3),
    error = Color(0xFFFFB4AB),
)

@Composable
fun RafayPairTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) DarkColors else LightColors
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            @Suppress("DEPRECATION")
            run {
                window.statusBarColor = Color.Transparent.toArgb()
                window.navigationBarColor = colors.surface.toArgb()
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.isNavigationBarContrastEnforced = false
            }
        }
    }
    MaterialTheme(colorScheme = colors, content = content)
}
