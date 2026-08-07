package com.rafaypair.android.ui.together

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.rafaypair.android.domain.model.AiMemory
import com.rafaypair.android.domain.model.AiMemoryCategory
import com.rafaypair.android.domain.model.RepositoryFailure
import com.rafaypair.android.domain.model.TogetherActivity
import com.rafaypair.android.domain.model.TogetherSession
import com.rafaypair.android.domain.repository.AssistantRepository
import com.rafaypair.android.domain.repository.TogetherRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class TogetherUiState(
    val loading: Boolean = true,
    val busy: Boolean = false,
    val session: TogetherSession? = null,
    val memories: List<AiMemory> = emptyList(),
    val memoryLimit: Int = 0,
    val draftCategory: AiMemoryCategory = AiMemoryCategory.PREFERENCE,
    val draftContent: String = "",
    val error: String? = null,
)

/**
 * Together mode and the assistant's memory.
 *
 * The session surface is polled rather than driven from the realtime socket:
 * it has to be correct on first paint, before any socket has connected.
 */
class TogetherViewModel(
    private val together: TogetherRepository,
    private val assistant: AssistantRepository,
) : ViewModel() {
    private val _state = MutableStateFlow(TogetherUiState())
    val state: StateFlow<TogetherUiState> = _state.asStateFlow()

    fun refresh() {
        viewModelScope.launch {
            val session = runCatching { together.current() }.getOrNull()
            _state.update { it.copy(session = session, loading = false) }
            loadMemories()
        }
    }

    fun invite(activity: TogetherActivity) = act { _state.update { it.copy(session = together.invite(activity)) } }

    fun respond(accepted: Boolean) = act {
        val current = _state.value.session ?: return@act
        _state.update { it.copy(session = together.respond(current.id, accepted)) }
    }

    fun end() = act {
        val current = _state.value.session ?: return@act
        _state.update { it.copy(session = together.end(current.id)) }
    }

    fun setDraftCategory(category: AiMemoryCategory) {
        _state.update { it.copy(draftCategory = category) }
    }

    fun setDraftContent(content: String) {
        _state.update { it.copy(draftContent = content) }
    }

    fun addMemory() = act {
        val draft = _state.value
        val content = draft.draftContent.trim()
        if (content.isEmpty()) return@act
        assistant.addMemory(draft.draftCategory, content)
        _state.update { it.copy(draftContent = "") }
        loadMemories()
    }

    fun deleteMemory(id: String) = act {
        assistant.deleteMemory(id)
        loadMemories()
    }

    fun forgetAll() = act {
        assistant.forgetAll()
        loadMemories()
    }

    private suspend fun loadMemories() {
        runCatching { assistant.memories() }
            .onSuccess { page ->
                _state.update { it.copy(memories = page.memories, memoryLimit = page.limit) }
            }
            .onFailure { failure ->
                if (failure is RepositoryFailure) {
                    _state.update { it.copy(error = failure.message) }
                }
            }
    }

    private fun act(block: suspend () -> Unit) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null) }
            try {
                block()
            } catch (failure: RepositoryFailure) {
                _state.update { it.copy(error = failure.message) }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    class Factory(
        private val together: TogetherRepository,
        private val assistant: AssistantRepository,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T =
            TogetherViewModel(together, assistant) as T
    }
}
