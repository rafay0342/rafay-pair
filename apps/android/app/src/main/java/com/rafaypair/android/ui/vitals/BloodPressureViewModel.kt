package com.rafaypair.android.ui.vitals

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.rafaypair.android.data.network.ApiClient
import com.rafaypair.android.data.network.BloodPressureReadingDto
import com.rafaypair.android.data.network.RecordBloodPressureRequestDto
import java.time.Instant
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class BloodPressureUiState(
    val readings: List<BloodPressureReadingDto> = emptyList(),
    val systolic: String = "",
    val diastolic: String = "",
    val pulse: String = "",
    val note: String = "",
    val busy: Boolean = false,
    val message: String? = null,
) {
    val entryIsComplete: Boolean
        get() = systolic.toIntOrNull() != null && diastolic.toIntOrNull() != null
}

/**
 * Holds readings the user typed from a cuff.
 *
 * Nothing here computes a value. The server range-checks as well, and its
 * refusal is surfaced as something a person can act on rather than as a code.
 */
class BloodPressureViewModel(private val api: ApiClient) : ViewModel() {
    private val _state = MutableStateFlow(BloodPressureUiState())
    val state: StateFlow<BloodPressureUiState> = _state.asStateFlow()

    init {
        refresh()
    }

    fun setSystolic(value: String) = _state.update { it.copy(systolic = value.filter(Char::isDigit)) }

    fun setDiastolic(value: String) =
        _state.update { it.copy(diastolic = value.filter(Char::isDigit)) }

    fun setPulse(value: String) = _state.update { it.copy(pulse = value.filter(Char::isDigit)) }

    fun setNote(value: String) = _state.update { it.copy(note = value.take(280)) }

    fun refresh() {
        viewModelScope.launch {
            runCatching { api.bloodPressureReadings() }
                .onSuccess { page -> _state.update { it.copy(readings = page.readings) } }
        }
    }

    fun save() {
        val current = _state.value
        val systolic = current.systolic.toIntOrNull() ?: return
        val diastolic = current.diastolic.toIntOrNull() ?: return
        _state.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            runCatching {
                api.recordBloodPressure(
                    RecordBloodPressureRequestDto(
                        systolic = systolic,
                        diastolic = diastolic,
                        pulseBpm = current.pulse.toIntOrNull(),
                        measuredAt = Instant.now().toString(),
                        note = current.note.trim().ifEmpty { null },
                    ),
                )
            }.onSuccess {
                _state.update {
                    it.copy(systolic = "", diastolic = "", pulse = "", note = "", busy = false)
                }
                refresh()
            }.onFailure {
                _state.update {
                    it.copy(
                        busy = false,
                        message = "That reading was not accepted. Check the numbers.",
                    )
                }
            }
        }
    }

    fun delete(id: String) {
        _state.update { it.copy(busy = true) }
        viewModelScope.launch {
            runCatching { api.deleteBloodPressure(id) }
            _state.update { it.copy(busy = false) }
            refresh()
        }
    }

    class Factory(private val api: ApiClient) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T =
            BloodPressureViewModel(api) as T
    }
}
