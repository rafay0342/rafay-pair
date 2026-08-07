package com.rafaypair.android.ui.together

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.rafaypair.android.domain.model.AiMemory
import com.rafaypair.android.domain.model.AiMemoryCategory
import com.rafaypair.android.domain.model.TogetherActivity
import com.rafaypair.android.domain.model.TogetherSession
import com.rafaypair.android.domain.model.TogetherStatus
import kotlinx.coroutines.delay

/**
 * Together mode and the assistant's memory.
 *
 * Master specification §10: both phones detect their own user and exchange only
 * derived state. Nothing on this screen sends a frame, a landmark, or audio.
 */
@Composable
fun TogetherScreen(
    currentUserId: String,
    hasPartner: Boolean,
    sharingAllowed: Boolean,
    viewModel: TogetherViewModel,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) {
        while (true) {
            viewModel.refresh()
            delay(POLL_INTERVAL_MS)
        }
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Column {
                Text(
                    "Work out at the same time.",
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    "Each phone watches only its own person. What crosses between you " +
                        "is the count and the phase — never the camera.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        state.error?.let { message ->
            item {
                Card(
                    shape = RoundedCornerShape(18.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                    ),
                ) {
                    Text(
                        message,
                        Modifier.padding(16.dp),
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
            }
        }

        item {
            SessionCard(
                state = state,
                currentUserId = currentUserId,
                hasPartner = hasPartner,
                sharingAllowed = sharingAllowed,
                viewModel = viewModel,
            )
        }
        item { AssistantCard() }
        item { MemoryComposerCard(state, viewModel) }

        items(state.memories, key = { it.id }) { memory ->
            MemoryRow(memory, state.busy, viewModel)
        }

        if (state.memories.isNotEmpty()) {
            item {
                TextButton(onClick = viewModel::forgetAll, enabled = !state.busy) {
                    Text("Forget everything", color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}

private const val POLL_INTERVAL_MS = 5_000L

@Composable
private fun SessionCard(
    state: TogetherUiState,
    currentUserId: String,
    hasPartner: Boolean,
    sharingAllowed: Boolean,
    viewModel: TogetherViewModel,
) {
    SurfaceCard("Shared session") {
        val session = state.session
        when {
            !hasPartner -> Text(
                "Together mode needs an active pair.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            !sharingAllowed -> Text(
                "Resume sharing before starting a session together.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            session == null -> {
                Text(
                    "They will be asked before anything is shared, and either of " +
                        "you can end it at any moment.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TogetherActivity.entries.forEach { activity ->
                    OutlinedButton(
                        onClick = { viewModel.invite(activity) },
                        enabled = !state.busy,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(activity.label) }
                }
            }

            else -> SessionDetail(session, currentUserId, state.busy, viewModel)
        }

        Text(
            "Repetition count, phase, set, elapsed time, estimated calories, and " +
                "breathing phase. That is the whole list.",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun SessionDetail(
    session: TogetherSession,
    currentUserId: String,
    busy: Boolean,
    viewModel: TogetherViewModel,
) {
    Text(session.activity.label, fontWeight = FontWeight.Bold)
    Text(statusLabel(session, currentUserId), color = MaterialTheme.colorScheme.onSurfaceVariant)

    session.participants.forEach { participant ->
        val who = if (participant.userId == currentUserId) "You" else "Partner"
        Text(
            "$who · ${participant.repetitions} reps · set ${participant.setIndex + 1} · " +
                participant.exercisePhase,
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }

    if (session.status == TogetherStatus.INVITED && session.invitedUserId == currentUserId) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(onClick = { viewModel.respond(true) }, enabled = !busy) { Text("Join") }
            OutlinedButton(onClick = { viewModel.respond(false) }, enabled = !busy) {
                Text("Not now")
            }
        }
    }

    OutlinedButton(onClick = viewModel::end, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
        Text("End session")
    }
}

@Composable
private fun AssistantCard() {
    SurfaceCard("Rafay AI") {
        Text("A generated voice, not a person, and not a clinician.", fontWeight = FontWeight.SemiBold)
        Text(
            "It says so at the start of every session, and it speaks about camera " +
                "estimates as estimates rather than measured readings.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            "Anything it does on your behalf asks you first. It cannot confirm on its own.",
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun MemoryComposerCard(state: TogetherUiState, viewModel: TogetherViewModel) {
    SurfaceCard("What Rafay remembers") {
        Text(
            "${state.memories.size} of ${state.memoryLimit} entries. Yours alone — your " +
                "partner cannot see these, and they do not travel with the pair.",
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AiMemoryCategory.entries.forEach { category ->
                FilterChip(
                    selected = state.draftCategory == category,
                    onClick = { viewModel.setDraftCategory(category) },
                    label = { Text(category.label) },
                )
            }
        }
        OutlinedTextField(
            value = state.draftContent,
            onValueChange = viewModel::setDraftContent,
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Remember that…") },
            placeholder = { Text("I prefer to train in the evening") },
            supportingText = { Text("${state.draftContent.length}/500") },
            enabled = !state.busy,
        )
        Button(
            onClick = viewModel::addMemory,
            enabled = !state.busy && state.draftContent.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Add") }
    }
}

@Composable
private fun MemoryRow(memory: AiMemory, busy: Boolean, viewModel: TogetherViewModel) {
    Card(
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(memory.content)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        memory.category.label,
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    // An entry the model proposed is marked, so it is always clear
                    // which of these you said and which were inferred.
                    if (memory.author == "assistant") {
                        Text(
                            "suggested by Rafay",
                            fontSize = 12.sp,
                            fontStyle = FontStyle.Italic,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            TextButton(onClick = { viewModel.deleteMemory(memory.id) }, enabled = !busy) {
                Text("Delete")
            }
        }
    }
}

@Composable
private fun SurfaceCard(title: String, content: @Composable () -> Unit) {
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
            Text(title, fontWeight = FontWeight.Bold, fontSize = 18.sp)
            content()
        }
    }
}

private fun statusLabel(session: TogetherSession, currentUserId: String): String =
    when (session.status) {
        TogetherStatus.INVITED ->
            if (session.invitedUserId == currentUserId) {
                "Your partner is asking to train together."
            } else {
                "Waiting for an answer."
            }

        TogetherStatus.ACTIVE -> "In progress."
        TogetherStatus.DECLINED -> "Declined."
        TogetherStatus.ENDED -> "Ended."
        TogetherStatus.EXPIRED -> "The invitation expired."
    }
