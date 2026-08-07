package com.rafaypair.android.ui.vitals

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.rafaypair.android.physiology.BreathingPhase
import com.rafaypair.android.physiology.MuscleGroup
import com.rafaypair.android.physiology.PulseProvenance
import com.rafaypair.android.physiology.VeinsAlive
import com.rafaypair.android.physiology.VeinsInput
import com.rafaypair.android.physiology.VeinsMode
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Veins Alive.
 *
 * Master specification §8. A vascular network, a contracting heart, a
 * breathing-synchronized chest glow, and the muscles the current exercise
 * works — all driven by values the product already holds.
 *
 * The one rule the drawing obeys is the one [VeinsAlive] encodes: with no fresh
 * pulse estimate the network rests. It does not fall back to a comfortable
 * rhythm and does not keep beating at whatever it saw last, because a moving
 * picture is the most persuasive way there is to state a number.
 */
@Composable
fun VeinsAliveCard(
    pulseBpm: Double?,
    breathingPhase: BreathingPhase?,
    breathingProgress: Double,
    repetitionsPerMinute: Double?,
    activeMuscles: List<MuscleGroup>,
) {
    var mode by remember { mutableStateOf(VeinsMode.CALM) }
    val drivers = VeinsAlive.drivers(
        VeinsInput(
            mode = mode,
            pulseBpm = pulseBpm,
            breathingPhase = breathingPhase,
            breathingProgress = breathingProgress,
            repetitionsPerMinute = repetitionsPerMinute,
            activeMuscles = activeMuscles,
        ),
    )

    // The animation clock runs at the contraction period, or not at all. A
    // fixed clock with a hidden "is it beating" check would still be a clock.
    val period = drivers.contractionPeriodMs?.roundToInt() ?: 0
    val transition = rememberInfiniteTransition(label = "veins")
    val phase by if (period > 0) {
        transition.animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(period, easing = LinearEasing),
                repeatMode = RepeatMode.Restart,
            ),
            label = "phase",
        )
    } else {
        remember { mutableStateOf(0f) }
    }

    val colour = MaterialTheme.colorScheme.primary

    Card {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Veins Alive", style = MaterialTheme.typography.titleMedium)

            // The disclosure sits above the picture, not under it. It is the
            // first thing read, because the picture is the persuasive part.
            Text(drivers.disclosure, fontWeight = FontWeight.SemiBold)

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                VeinsMode.entries.forEach { candidate ->
                    FilterChip(
                        selected = mode == candidate,
                        onClick = { mode = candidate },
                        label = { Text(candidate.title) },
                    )
                }
            }

            Canvas(
                Modifier
                    .fillMaxWidth()
                    .height(240.dp),
            ) {
                val centreX = size.width / 2
                val centreY = size.height / 2
                val torsoWidth = size.width * 0.42f
                val torsoHeight = size.height * 0.78f
                val beating = drivers.contractionPeriodMs != null

                if (drivers.chestGlow > 0) {
                    val radius = torsoWidth * (0.45f + 0.25f * drivers.chestGlow.toFloat())
                    drawCircle(
                        brush = Brush.radialGradient(
                            colors = listOf(
                                colour.copy(alpha = 0.35f * drivers.chestGlow.toFloat()),
                                colour.copy(alpha = 0f),
                            ),
                            center = Offset(centreX, centreY - radius * 0.1f),
                            radius = radius,
                        ),
                        radius = radius,
                        center = Offset(centreX, centreY - radius * 0.1f),
                    )
                }

                val branches = 7
                for (index in 0 until branches) {
                    val fraction = index.toFloat() / (branches - 1)
                    val x = centreX + (fraction - 0.5f) * torsoWidth * 1.6f
                    val path = Path().apply {
                        moveTo(centreX, centreY - torsoHeight * 0.18f)
                        cubicTo(
                            centreX, centreY + torsoHeight * 0.05f,
                            x, centreY + torsoHeight * 0.15f,
                            x, centreY + torsoHeight * 0.42f,
                        )
                    }
                    // A travelling brightness along each branch: pulse
                    // propagation, and at rest a flat dim line.
                    val travel = if (!beating) {
                        0f
                    } else {
                        maxOf(0f, 1f - abs(((phase + fraction * 0.35f) % 1f) - 0.5f) * 3f)
                    }
                    drawPath(
                        path = path,
                        color = colour.copy(
                            alpha = 0.18f + 0.55f * travel * drivers.intensity.toFloat(),
                        ),
                        style = Stroke(width = 1.5f + 2.5f * travel),
                    )
                }

                // The heart contracts on the beat, and simply sits there when
                // there is nothing current to beat to.
                val contraction = if (beating) maxOf(0f, 1f - abs(phase - 0.15f) * 6f) else 0f
                drawCircle(
                    color = colour.copy(alpha = 0.35f + 0.4f * contraction),
                    radius = torsoWidth * (0.16f + 0.05f * contraction),
                    center = Offset(centreX, centreY - torsoHeight * 0.18f),
                )

                // Muscle activation: a mark per group the exercise names. The
                // list comes from the exercise definition; nothing is inferred
                // from the body here.
                drivers.activeMuscles.forEachIndexed { index, _ ->
                    drawRoundRect(
                        color = colour.copy(alpha = 0.2f + 0.5f * drivers.intensity.toFloat()),
                        topLeft = Offset(
                            centreX - torsoWidth * 0.5f,
                            centreY + torsoHeight * (0.05f + 0.12f * index),
                        ),
                        size = androidx.compose.ui.geometry.Size(torsoWidth, 6f),
                    )
                }
            }

            if (drivers.pulseProvenance == PulseProvenance.ESTIMATED && pulseBpm != null) {
                Text(
                    "Beating at your latest estimate, ${pulseBpm.roundToInt()} bpm.",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                // Said in words as well as shown: stillness alone could be read
                // as the app being broken.
                Text(
                    "Resting. There is no current pulse estimate to animate.",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (drivers.activeMuscles.isNotEmpty()) {
                Text(
                    "Highlighted: " +
                        drivers.activeMuscles.joinToString { it.wireName } +
                        " — the muscles this exercise works, from its definition.",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
