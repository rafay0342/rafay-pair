package com.rafaypair.android.ui.vitals

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.rafaypair.android.data.network.BloodPressureReadingDto

/**
 * Blood pressure the user brings.
 *
 * Master specification §5: a phone is not a blood-pressure instrument, so
 * nothing here estimates one. What it does is hold a reading taken with a real
 * cuff, with its origin attached to every row shown.
 */
@Composable
fun BloodPressureCard(viewModel: BloodPressureViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Card {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Blood pressure", style = MaterialTheme.typography.titleMedium)
            Text(
                "RafayPair does not estimate blood pressure. A phone camera cannot " +
                    "measure it, and no amount of processing changes that.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                "What you can keep here is a reading from a real cuff.",
                fontWeight = FontWeight.SemiBold,
            )

            state.message?.let { message ->
                Text(message, color = MaterialTheme.colorScheme.error)
            }

            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                NumberField("Systolic", state.systolic, viewModel::setSystolic, Modifier.weight(1f))
                NumberField(
                    "Diastolic",
                    state.diastolic,
                    viewModel::setDiastolic,
                    Modifier.weight(1f),
                )
            }
            NumberField(
                "Pulse on the cuff (optional)",
                state.pulse,
                viewModel::setPulse,
                Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = state.note,
                onValueChange = viewModel::setNote,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Note (optional)") },
                singleLine = true,
            )
            Button(
                onClick = viewModel::save,
                enabled = !state.busy && state.entryIsComplete,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Save reading") }

            Text(
                "Yours alone. There is no consent switch for blood pressure because " +
                    "there is no partner surface for it.",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            state.readings.forEach { reading ->
                ReadingRow(reading, state.busy) { viewModel.delete(reading.id) }
            }
        }
    }
}

@Composable
private fun NumberField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        modifier = modifier,
        label = { Text(label) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
    )
}

@Composable
private fun ReadingRow(
    reading: BloodPressureReadingDto,
    busy: Boolean,
    onDelete: () -> Unit,
) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Column {
            Text("${reading.systolic}/${reading.diastolic}", fontWeight = FontWeight.Bold)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                reading.pulseBpm?.let { Text("$it bpm", fontSize = 12.sp) }
                // The origin travels with the reading, always. A cuff's pulse is
                // never merged with the camera estimate either.
                Text(
                    if (reading.source == "manual_entry") {
                        "entered by you"
                    } else {
                        "from ${reading.externalOrigin ?: "a health record"}"
                    },
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        TextButton(onClick = onDelete, enabled = !busy) { Text("Delete") }
    }
}
