package com.rafaypair.android.ui.together

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/**
 * The voice conversation surface.
 *
 * The disclosure is the first thing on the card and stays there for the whole
 * session rather than appearing once and scrolling away, and the microphone
 * indicator reflects the recorder's actual state rather than the app's belief
 * about it.
 */
@Composable
fun VoiceSessionCard(viewModel: VoiceSessionViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
    val requestPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { allowed -> viewModel.start(allowed) }

    Card(
        shape = RoundedCornerShape(22.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Talk to Rafay AI", fontWeight = FontWeight.Bold, fontSize = 18.sp)
            Text(state.disclosure, fontWeight = FontWeight.SemiBold)

            when (state.phase) {
                VoicePhase.IDLE -> {
                    Text(
                        "It hears you only while a session is running, and stops the " +
                            "moment you end it.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Button(
                        onClick = {
                            if (granted) {
                                viewModel.start(true)
                            } else {
                                requestPermission.launch(Manifest.permission.RECORD_AUDIO)
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Start a voice session") }
                }

                VoicePhase.STARTING -> CircularProgressIndicator()

                VoicePhase.LISTENING -> {
                    Text(
                        if (state.microphoneOn) "Listening" else "Microphone off",
                        fontWeight = FontWeight.SemiBold,
                        color = if (state.microphoneOn) {
                            MaterialTheme.colorScheme.error
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                    )
                    OutlinedButton(
                        onClick = viewModel::stop,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("End session") }
                }

                VoicePhase.ENDING -> CircularProgressIndicator()

                VoicePhase.UNAVAILABLE -> {
                    Text(
                        state.message ?: "The voice session stopped.",
                        color = MaterialTheme.colorScheme.error,
                    )
                    OutlinedButton(
                        onClick = { viewModel.start(granted) },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Try again") }
                }
            }

            // Asked here, in the interface, rather than answered by speech: a
            // spoken "shall I?" answered aloud would make the model both the
            // asker and the recorder of the answer.
            state.pendingConfirmation?.let { pending ->
                HorizontalDivider()
                Text("Rafay AI is asking to: ${pending.title}", fontWeight = FontWeight.SemiBold)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(onClick = viewModel::confirm) { Text("Allow once") }
                    OutlinedButton(onClick = viewModel::decline) { Text("No") }
                }
            }

            if (state.transcript.isNotEmpty()) {
                HorizontalDivider()
                state.transcript.forEach { line ->
                    Text(
                        line,
                        fontSize = 13.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}
