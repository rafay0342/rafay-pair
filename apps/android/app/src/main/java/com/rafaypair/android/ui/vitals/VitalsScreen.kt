package com.rafaypair.android.ui.vitals

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.rafaypair.android.physiology.BreathingPattern
import com.rafaypair.android.physiology.BreathingPhase
import com.rafaypair.android.physiology.BreathAudioCaptureController
import com.rafaypair.android.physiology.PulseCaptureController
import kotlin.math.roundToInt
import kotlinx.coroutines.delay

/**
 * Pulse measurement, the living heart, and guided breathing.
 *
 * Every physiological number here is labelled as an estimate, and blood pressure
 * is stated as unsupported rather than quietly absent.
 */
@Composable
fun VitalsScreen(viewModel: VitalsViewModel = viewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    var permissionGranted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    val requestPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> permissionGranted = granted }

    var microphoneGranted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    val requestMicrophone = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> microphoneGranted = granted }

    val controller = remember {
        PulseCaptureController(context) { viewModel.onSample(it) }
    }
    val breathAudio = remember {
        BreathAudioCaptureController(
            onHops = { viewModel.onBreathHops(it) },
            onFailure = { viewModel.microphoneFailed(it) },
        )
    }

    // A one-second tick is what lets a reading expire on screen rather than
    // lingering as if it were still current.
    LaunchedEffect(Unit) {
        while (true) {
            viewModel.tick(System.currentTimeMillis())
            delay(1000)
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            controller.release()
            breathAudio.stop()
        }
    }

    DisposableEffect(state.listening) {
        if (state.listening) breathAudio.start() else breathAudio.stop()
        onDispose { }
    }

    DisposableEffect(state.measuring) {
        if (state.measuring) {
            controller.start(lifecycleOwner) { viewModel.cameraFailed(it) }
        } else {
            controller.stop()
        }
        onDispose { }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        HeartCard(state)
        MeasureCard(
            state = state,
            permissionGranted = permissionGranted,
            onRequestPermission = { requestPermission.launch(Manifest.permission.CAMERA) },
            onToggle = {
                if (state.measuring) {
                    viewModel.finishMeasurement(System.currentTimeMillis())
                } else {
                    viewModel.beginMeasurement()
                }
            },
            guidance = viewModel::guidance,
        )
        BreathingCard(
            state = state,
            microphoneGranted = microphoneGranted,
            onRequestMicrophone = {
                requestMicrophone.launch(Manifest.permission.RECORD_AUDIO)
            },
            onToggleListen = viewModel::setListenForBreathing,
            onStart = { viewModel.startBreathing(it, System.currentTimeMillis()) },
            onStop = { viewModel.stopBreathing(System.currentTimeMillis()) },
            audioGuidance = viewModel::audioGuidance,
        )
        BloodPressureCard()
    }
}

@Composable
private fun HeartCard(state: VitalsUiState) {
    Card {
        Column(
            Modifier.fillMaxWidth().padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            LivingHeart(state.animatedBpm)
            val pulse = state.latestPulse
            when {
                pulse != null && state.pulseIsFresh -> {
                    Text(
                        "${pulse.bpm.roundToInt()} BPM",
                        style = MaterialTheme.typography.displaySmall,
                    )
                    Text(
                        "Estimated from your phone camera · " +
                            "${pulse.confidenceBand.wireName} confidence",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                }

                pulse != null -> {
                    // Master specification §4: never keep animating an old rate
                    // as if it remains current.
                    Text(
                        "Last pulse: ${pulse.bpm.roundToInt()} BPM",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        ageDescription(state.pulseAgeSeconds),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                else -> {
                    Text("No pulse measured yet", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "The heart follows your latest camera measurement. Until then it rests.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                }
            }
            Text(
                "Sensor-driven visualization — not a medical scan.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** Animates at the supplied rate, and rests when there is no current reading —
 * never at a remembered one. */
@Composable
private fun LivingHeart(bpm: Double?) {
    val transition = rememberInfiniteTransition(label = "heart")
    val beatMs = if (bpm != null && bpm > 0) (60_000 / bpm).toInt() else 1000
    val scale by transition.animateFloat(
        initialValue = 1f,
        targetValue = if (bpm == null) 1f else 1.12f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = beatMs / 2, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "beat",
    )
    Surface(
        shape = CircleShape,
        color = MaterialTheme.colorScheme.primaryContainer,
        modifier = Modifier.size(120.dp).scale(scale),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text("♥", style = MaterialTheme.typography.displayMedium)
        }
    }
}

private fun ageDescription(seconds: Int): String =
    if (seconds < 120) "Measured $seconds seconds ago" else "Measured ${seconds / 60} minutes ago"

@Composable
private fun MeasureCard(
    state: VitalsUiState,
    permissionGranted: Boolean,
    onRequestPermission: () -> Unit,
    onToggle: () -> Unit,
    guidance: (com.rafaypair.android.physiology.PulseRejectionReason) -> String,
) {
    Card {
        Column(
            Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Measure your pulse", style = MaterialTheme.typography.titleMedium)
            Text(
                "Cover the rear camera and torch with your fingertip. Rest your hand and " +
                    "stay still for about twenty seconds.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            if (state.measuring) {
                LinearProgressIndicator(
                    progress = { state.progress.toFloat() },
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    if (state.fingerDetected) {
                        "Finger detected — keep still."
                    } else {
                        "Cover the camera and torch completely."
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            state.lastRejection?.let {
                Text(
                    guidance(it),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            state.cameraError?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            Button(
                onClick = { if (permissionGranted) onToggle() else onRequestPermission() },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    when {
                        !permissionGranted -> "Allow camera"
                        state.measuring -> "Stop"
                        else -> "Measure"
                    },
                )
            }

            Text(
                "This is an estimate from your phone's camera, not a medical measurement.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun BreathingCard(
    state: VitalsUiState,
    microphoneGranted: Boolean,
    onRequestMicrophone: () -> Unit,
    onToggleListen: (Boolean) -> Unit,
    onStart: (BreathingPattern) -> Unit,
    onStop: () -> Unit,
    audioGuidance: (com.rafaypair.android.physiology.AudioBreathingRejectionReason) -> String,
) {
    Card {
        Column(
            Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Guided breathing", style = MaterialTheme.typography.titleMedium)
            val phase = state.breathingPhase
            if (phase != null) {
                Text(
                    when (phase.phase) {
                        BreathingPhase.INHALE -> "Breathe in"
                        BreathingPhase.HOLD -> "Hold"
                        BreathingPhase.EXHALE -> "Breathe out"
                        BreathingPhase.HOLD_AFTER -> "Rest"
                        BreathingPhase.COMPLETE -> "Done"
                    },
                    style = MaterialTheme.typography.headlineSmall,
                )
                LinearProgressIndicator(
                    progress = { phase.progress.toFloat() },
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    "Cycle ${phase.cycleIndex + 1} of ${state.breathingPattern.cycles}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (state.listening) {
                    Text(
                        if (state.breathAudible) {
                            "Listening — breathe normally."
                        } else {
                            "Listening. Hold the phone a little closer."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                TextButton(onClick = onStop) { Text("Stop") }
            } else {
                Text(
                    "A paced breath with a longer exhale. Nothing is measured — this is " +
                        "only a rhythm to follow.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "Also estimate my breathing rate from sound",
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.weight(1f),
                    )
                    Switch(
                        checked = state.listenForBreathing,
                        onCheckedChange = { wanted ->
                            if (wanted && !microphoneGranted) {
                                onRequestMicrophone()
                            } else {
                                onToggleListen(wanted)
                            }
                        },
                    )
                }
                Text(
                    "Audio becomes a few numbers as it arrives and is never recorded, " +
                        "stored, or sent anywhere.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { onStart(BreathingPattern.calm(6)) }) { Text("Calm") }
                    TextButton(onClick = { onStart(BreathingPattern.box(5)) }) { Text("Box") }
                    TextButton(onClick = { onStart(BreathingPattern.relax(4)) }) { Text("Relax") }
                }

                state.breathingEstimate?.let { estimate ->
                    Text(
                        "Estimated ${estimate.breathsPerMinute} breaths per minute",
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Text(
                        "From sound on this phone · ${estimate.confidenceBand.wireName} confidence",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                state.breathingRejection?.let {
                    Text(
                        audioGuidance(it),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                state.microphoneError?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
    }
}

@Composable
private fun BloodPressureCard() {
    Card {
        Column(
            Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("Blood pressure", style = MaterialTheme.typography.titleMedium)
            Text(
                "RafayPair does not estimate blood pressure. A phone camera cannot measure " +
                    "it, and no amount of processing changes that.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                "If you track it, enter a reading from a real cuff or import it from Health " +
                    "Connect — those are the only sources this app accepts.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
