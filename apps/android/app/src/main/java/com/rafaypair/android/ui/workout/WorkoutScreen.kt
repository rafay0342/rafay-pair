package com.rafaypair.android.ui.workout

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import com.rafaypair.android.pose.PoseCaptureController
import com.rafaypair.android.pose.ReportedPosture
import kotlin.math.roundToInt

/** Local camera workout. Runs entirely on this phone. */
@Composable
fun WorkoutScreen(viewModel: WorkoutViewModel = viewModel()) {
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

    val previewView = remember { PreviewView(context) }
    val controller = remember { PoseCaptureController(context, viewModel::onFrame) }

    DisposableEffect(Unit) {
        onDispose {
            viewModel.endSession()
            controller.release()
        }
    }

    DisposableEffect(state.isRecording, permissionGranted) {
        if (state.isRecording && permissionGranted) {
            controller.start(lifecycleOwner, previewView)
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
        Text("Squat session", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Your camera stays on this phone. Nothing is recorded or uploaded.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Card {
            Column(
                Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .aspectRatio(3f / 4f),
                    contentAlignment = Alignment.Center,
                ) {
                    if (state.isRecording && permissionGranted) {
                        AndroidView(factory = { previewView }, modifier = Modifier.fillMaxWidth())
                    } else {
                        Text(
                            if (permissionGranted) {
                                "Camera is off. Start a session to begin tracking on this device."
                            } else {
                                "Camera access is needed to track your movement on this phone."
                            },
                            textAlign = TextAlign.Center,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }

                Button(
                    onClick = {
                        if (!permissionGranted) {
                            requestPermission.launch(Manifest.permission.CAMERA)
                        } else if (state.isRecording) {
                            viewModel.endSession()
                        } else {
                            viewModel.startSession()
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        when {
                            !permissionGranted -> "Allow camera"
                            state.isRecording -> "End session"
                            else -> "Start session"
                        },
                    )
                }
            }
        }

        Card {
            Column(
                Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "${state.repetitionCount} " +
                            if (state.repetitionCount == 1) "squat" else "squats",
                        style = MaterialTheme.typography.headlineMedium,
                    )
                    Text(
                        postureLabel(state.reportedPosture),
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
                Text(
                    state.guidance,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                state.formHints.forEach { hint ->
                    Text(
                        hint,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        state.summary?.let { summary ->
            Card {
                Column(
                    Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text("Session summary", style = MaterialTheme.typography.titleMedium)
                    Text("${summary.repetitionCount} squats recorded on this device.")
                    if (summary.repetitionCount > 0) {
                        Text(
                            "Best depth ${(summary.bestDepth * 100).roundToInt()}% of a full squat.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Text(
                        "Sharing this with your partner is a separate choice in Sharing.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        Card {
            Column(
                Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("Stays on this phone", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Pose runs locally with ML Kit's on-device detector. Frames are analysed " +
                        "and immediately released — no video is stored or sent anywhere.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

private fun postureLabel(posture: ReportedPosture): String = when (posture) {
    ReportedPosture.UNKNOWN -> "Finding you"
    ReportedPosture.STANDING -> "Standing"
    ReportedPosture.SITTING -> "Sitting"
    ReportedPosture.LYING_DOWN -> "Lying down"
    ReportedPosture.SQUATTING -> "Squatting"
}
