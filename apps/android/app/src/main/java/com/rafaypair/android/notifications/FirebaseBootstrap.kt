package com.rafaypair.android.notifications

import android.app.Application
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.rafaypair.android.BuildConfig

object FirebaseBootstrap {
    fun initialize(application: Application): Boolean {
        val valid = listOf(
            BuildConfig.FIREBASE_APPLICATION_ID.matches(
                Regex("^1:[0-9]+:android:[0-9a-fA-F]+$"),
            ),
            BuildConfig.FIREBASE_API_KEY.matches(Regex("^AIza[0-9A-Za-z_-]{35}$")),
            BuildConfig.FIREBASE_PROJECT_ID.matches(Regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$")),
            BuildConfig.FIREBASE_SENDER_ID.matches(Regex("^[0-9]{6,20}$")),
        )
        if (valid.any { configured -> !configured }) {
            check(!BuildConfig.REQUIRE_FIREBASE_CONFIGURATION) {
                "This distributable build has missing or malformed Firebase project identifiers"
            }
            return false
        }

        if (FirebaseApp.getApps(application).isEmpty()) {
            val options = FirebaseOptions.Builder()
                .setApplicationId(BuildConfig.FIREBASE_APPLICATION_ID)
                .setApiKey(BuildConfig.FIREBASE_API_KEY)
                .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
                .build()
            checkNotNull(FirebaseApp.initializeApp(application, options)) {
                "Firebase initialization failed"
            }
        }
        return true
    }
}
