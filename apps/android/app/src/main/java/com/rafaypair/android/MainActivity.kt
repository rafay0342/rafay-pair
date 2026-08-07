package com.rafaypair.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.rafaypair.android.ui.MainViewModel
import com.rafaypair.android.ui.RafayPairApp
import com.rafaypair.android.ui.theme.RafayPairTheme

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels {
        (application as RafayPairApplication).container.viewModelFactory
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            RafayPairTheme {
                RafayPairApp(viewModel)
            }
        }
    }
}
