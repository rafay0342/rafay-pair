package com.rafaypair.android

import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.Rule
import org.junit.Test

class MainActivitySmokeTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun signedOutLaunchShowsNativeAuthenticationSurface() {
        composeRule.onNodeWithText("RafayPair").assertExists()
        composeRule.onNodeWithText("Sign in").assertExists()
        composeRule.onNodeWithText("New here? Create account").assertExists()
    }
}
