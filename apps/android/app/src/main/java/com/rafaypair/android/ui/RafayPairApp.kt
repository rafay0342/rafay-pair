package com.rafaypair.android.ui

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Security
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.rafaypair.android.BuildConfig
import com.rafaypair.android.domain.model.CareDeliveryStatus
import com.rafaypair.android.domain.model.CareDirection
import com.rafaypair.android.domain.model.CareItem
import com.rafaypair.android.domain.model.CareKind
import com.rafaypair.android.domain.model.CareResponse
import com.rafaypair.android.domain.model.ConsentCapability
import com.rafaypair.android.domain.model.ConsentGrant
import com.rafaypair.android.domain.model.PairStatus
import com.rafaypair.android.domain.model.RealtimeState
import com.rafaypair.android.domain.model.SessionState
import com.rafaypair.android.domain.model.User
import com.rafaypair.android.ui.theme.Coral500
import com.rafaypair.android.ui.theme.Mint400
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun RafayPairApp(viewModel: MainViewModel) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val snackbarHost = remember { SnackbarHostState() }
    var error by remember { mutableStateOf<UiEvent.Error?>(null) }
    val view = LocalView.current
    val useDarkSystemBarIcons = state.session is SessionState.SignedIn &&
        !androidx.compose.foundation.isSystemInDarkTheme()

    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = useDarkSystemBarIcons
                isAppearanceLightNavigationBars = useDarkSystemBarIcons
            }
        }
    }

    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                is UiEvent.Notice -> snackbarHost.showSnackbar(event.message)
                is UiEvent.Error -> error = event
            }
        }
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Crossfade(targetState = state.session, label = "session") { session ->
            when (session) {
                SessionState.Restoring -> RestoringScreen()
                SessionState.SignedOut -> AuthScreen(state, viewModel, snackbarHost)
                is SessionState.SignedIn -> SignedInScreen(session.user, state, viewModel, snackbarHost)
            }
        }
    }

    error?.let { current ->
        AlertDialog(
            onDismissRequest = { error = null },
            icon = { Icon(Icons.Default.Security, contentDescription = null) },
            title = { Text(current.title) },
            text = { Text(current.message) },
            confirmButton = { TextButton(onClick = { error = null }) { Text("OK") } },
        )
    }
}

@Composable
private fun RestoringScreen() {
    Box(
        Modifier
            .fillMaxSize()
            .background(Brush.verticalGradient(listOf(Color(0xFF241426), Color(0xFF4A173B)))),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            HeartMark()
            Spacer(Modifier.height(20.dp))
            Text("RafayPair", color = Color.White, fontSize = 28.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(20.dp))
            CircularProgressIndicator(color = Color(0xFFFF9EB0), strokeWidth = 3.dp)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AuthScreen(state: MainUiState, viewModel: MainViewModel, snackbar: SnackbarHostState) {
    val form = state.authForm
    val isRegister = form.mode == AuthMode.REGISTER
    val busy = "auth" in state.busyActions
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        containerColor = Color.Transparent,
    ) { padding ->
        Box(
            Modifier
                .fillMaxSize()
                .background(
                    Brush.verticalGradient(
                        listOf(Color(0xFF211326), Color(0xFF4D193E), Color(0xFF211326)),
                    ),
                )
                .padding(padding)
                .statusBarsPadding()
                .imePadding(),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = 24.dp, vertical = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                item {
                    HeartMark()
                    Spacer(Modifier.height(16.dp))
                    Text("RafayPair", color = Color.White, fontSize = 34.sp, fontWeight = FontWeight.ExtraBold)
                    Text(
                        "Private care, shared intentionally.",
                        color = Color(0xFFE9C9DD),
                        fontSize = 16.sp,
                    )
                    Spacer(Modifier.height(28.dp))
                }
                item {
                    Card(
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                        shape = RoundedCornerShape(28.dp),
                        elevation = CardDefaults.cardElevation(10.dp),
                    ) {
                        Column(Modifier.padding(22.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                            Text(
                                if (isRegister) "Create your private space" else "Welcome back",
                                style = MaterialTheme.typography.headlineSmall,
                                fontWeight = FontWeight.Bold,
                            )
                            Text(
                                if (isRegister) "Your partner only sees what you explicitly allow."
                                else "Sign in to reconnect with your partner.",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            if (isRegister) {
                                OutlinedTextField(
                                    value = form.displayName,
                                    onValueChange = viewModel::setDisplayName,
                                    modifier = Modifier.fillMaxWidth(),
                                    label = { Text("Name") },
                                    singleLine = true,
                                    enabled = !busy,
                                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                                )
                            }
                            OutlinedTextField(
                                value = form.email,
                                onValueChange = viewModel::setEmail,
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text("Email") },
                                singleLine = true,
                                enabled = !busy,
                                keyboardOptions = KeyboardOptions(
                                    keyboardType = KeyboardType.Email,
                                    imeAction = ImeAction.Next,
                                ),
                            )
                            OutlinedTextField(
                                value = form.password,
                                onValueChange = viewModel::setPassword,
                                modifier = Modifier.fillMaxWidth(),
                                label = { Text("Password") },
                                supportingText = if (isRegister) {
                                    { Text("12+ characters with a letter and number") }
                                } else null,
                                singleLine = true,
                                enabled = !busy,
                                visualTransformation = if (form.showPassword) {
                                    VisualTransformation.None
                                } else {
                                    PasswordVisualTransformation()
                                },
                                trailingIcon = {
                                    IconButton(onClick = viewModel::togglePasswordVisibility) {
                                        Icon(
                                            if (form.showPassword) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                                            contentDescription = if (form.showPassword) "Hide password" else "Show password",
                                        )
                                    }
                                },
                                keyboardOptions = KeyboardOptions(
                                    keyboardType = KeyboardType.Password,
                                    imeAction = ImeAction.Done,
                                ),
                                keyboardActions = KeyboardActions(onDone = { viewModel.submitAuth() }),
                            )
                            Button(
                                onClick = viewModel::submitAuth,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(52.dp),
                                enabled = !busy,
                                shape = RoundedCornerShape(16.dp),
                            ) {
                                if (busy) {
                                    CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                                } else {
                                    Text(if (isRegister) "Create account" else "Sign in", fontWeight = FontWeight.Bold)
                                    Spacer(Modifier.width(8.dp))
                                    Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = null)
                                }
                            }
                            TextButton(
                                onClick = {
                                    viewModel.setAuthMode(if (isRegister) AuthMode.LOGIN else AuthMode.REGISTER)
                                },
                                modifier = Modifier.fillMaxWidth(),
                                enabled = !busy,
                            ) {
                                Text(if (isRegister) "Already have an account? Sign in" else "New here? Create account")
                            }
                        }
                    }
                }
                item {
                    Spacer(Modifier.height(20.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Lock, null, tint = Color(0xFF9EDFCC), modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(8.dp))
                        Text("Tokens are encrypted by Android Keystore", color = Color(0xFFCDB8C9), fontSize = 12.sp)
                    }
                }
            }
        }
    }
}

@Composable
private fun SignedInScreen(
    user: User,
    state: MainUiState,
    viewModel: MainViewModel,
    snackbar: SnackbarHostState,
) {
    var confirmDisconnect by remember { mutableStateOf(false) }
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            AppNavigationBar(state.selectedTab, viewModel::selectTab)
        },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .statusBarsPadding(),
        ) {
            AnimatedVisibility(
                state.pair?.status == PairStatus.ACTIVE && !state.partnerSharingAllowed,
            ) {
                PausedBanner(state.privacy.syncPending)
            }
            Crossfade(state.selectedTab, label = "tab", modifier = Modifier.weight(1f)) { tab ->
                when (tab) {
                    AppTab.HOME -> HomeScreen(user, state, viewModel, { confirmDisconnect = true })
                    AppTab.CARE -> CareScreen(state, viewModel)
                    AppTab.CONSENT -> ConsentScreen(state, viewModel)
                    AppTab.ACCOUNT -> AccountScreen(user, state, viewModel)
                }
            }
        }
    }
    if (confirmDisconnect) {
        AlertDialog(
            onDismissRequest = { confirmDisconnect = false },
            icon = { Icon(Icons.Default.People, contentDescription = null) },
            title = { Text("Disconnect this pair?") },
            text = {
                Text("Partner access and realtime sharing stop immediately. This does not delete either account.")
            },
            dismissButton = { TextButton(onClick = { confirmDisconnect = false }) { Text("Keep pair") } },
            confirmButton = {
                TextButton(onClick = {
                    confirmDisconnect = false
                    viewModel.disconnectPair()
                }) { Text("Disconnect", color = MaterialTheme.colorScheme.error) }
            },
        )
    }
}

@Composable
private fun AppNavigationBar(selected: AppTab, onSelect: (AppTab) -> Unit) {
    NavigationBar(modifier = Modifier.navigationBarsPadding()) {
        NavigationItem(AppTab.HOME, "Home", Icons.Default.Home, selected, onSelect)
        NavigationItem(AppTab.CARE, "Care", Icons.Default.Favorite, selected, onSelect)
        NavigationItem(AppTab.CONSENT, "Consent", Icons.Default.Security, selected, onSelect)
        NavigationItem(AppTab.ACCOUNT, "Account", Icons.Default.AccountCircle, selected, onSelect)
    }
}

@Composable
private fun RowScope.NavigationItem(
    tab: AppTab,
    label: String,
    icon: ImageVector,
    selected: AppTab,
    onSelect: (AppTab) -> Unit,
) {
    NavigationBarItem(
        selected = selected == tab,
        onClick = { onSelect(tab) },
        icon = { Icon(icon, contentDescription = label) },
        label = { Text(label) },
    )
}

@Composable
private fun HomeScreen(
    user: User,
    state: MainUiState,
    viewModel: MainViewModel,
    requestDisconnect: () -> Unit,
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Hello, ${user.displayName}", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text("Your shared space is private by default.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                IconButton(onClick = viewModel::refresh, enabled = "refresh" !in state.busyActions) {
                    if ("refresh" in state.busyActions) {
                        CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                }
            }
        }
        item { PrivacyControlCard(state, viewModel) }
        item { NotificationPermissionCard(state, viewModel) }
        item {
            when {
                state.pair == null -> PairSetupCard(state, viewModel)
                state.pair.status == PairStatus.WAITING_FOR_PARTNER -> InviteCard(state, viewModel, requestDisconnect)
                else -> ConnectedPairCard(state, requestDisconnect)
            }
        }
        item {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)) {
                Row(Modifier.padding(18.dp), verticalAlignment = Alignment.Top) {
                    Icon(Icons.Default.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.onTertiaryContainer)
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text("Nothing is measured in the background", fontWeight = FontWeight.Bold)
                        Text(
                            "RafayPair only shares actions and categories you approve. Camera, microphone, and health sensors are not used in this milestone.",
                            color = MaterialTheme.colorScheme.onTertiaryContainer,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun PrivacyControlCard(state: MainUiState, viewModel: MainViewModel) {
    val activePair = state.pair?.status == PairStatus.ACTIVE
    val paused = activePair && !state.partnerSharingAllowed
    val busy = "privacy" in state.busyActions
    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (paused) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.primaryContainer,
        ),
        shape = RoundedCornerShape(22.dp),
    ) {
        Row(Modifier.padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(
                if (paused) Icons.Default.Lock else Icons.Default.LockOpen,
                contentDescription = null,
                modifier = Modifier.size(28.dp),
            )
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    when {
                        !activePair -> "Privacy controls ready after pairing"
                        paused -> "Privacy pause active"
                        else -> "Partner sharing ready"
                    },
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    when {
                        !activePair -> "Connect with a partner before any sharing can start."
                        !state.privacy.boundaryReady -> "Sharing stays blocked until the server confirms this pair."
                        state.privacy.syncPending -> "Local protection is active; server sync is pending."
                        paused -> "Realtime connection is stopped."
                        else -> "Only your active consent grants can be shared."
                    },
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            Switch(
                checked = paused,
                onCheckedChange = { viewModel.setPrivacyPaused(it) },
                enabled = activePair && state.privacy.boundaryReady && !state.privacy.syncPending && !busy,
                modifier = Modifier.semantics { contentDescription = "Privacy pause" },
            )
        }
        if (busy || state.privacy.syncPending) LinearProgressIndicator(Modifier.fillMaxWidth())
    }
}

@Composable
private fun PairSetupCard(state: MainUiState, viewModel: MainViewModel) {
    val busy = "pair" in state.busyActions || state.pairLoading
    Card(shape = RoundedCornerShape(22.dp)) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.People, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(10.dp))
                Text("Pair securely", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            }
            Text(
                "Create a one-time invite or enter the code your partner shared directly with you.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(
                onClick = viewModel::createPair,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Default.Add, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Create invite")
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                HorizontalDivider(Modifier.weight(1f))
                Text("  or join  ", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 12.sp)
                HorizontalDivider(Modifier.weight(1f))
            }
            OutlinedTextField(
                value = state.joinCode,
                onValueChange = viewModel::setJoinCode,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("8-character invite code") },
                placeholder = { Text("ABCD2345") },
                singleLine = true,
                enabled = !busy,
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Ascii,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { viewModel.joinPair() }),
            )
            OutlinedButton(
                onClick = viewModel::joinPair,
                enabled = !busy && state.joinCode.length == 8,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Join partner") }
        }
    }
}

@Composable
private fun InviteCard(state: MainUiState, viewModel: MainViewModel, requestDisconnect: () -> Unit) {
    val clipboard = LocalContext.current.getSystemService(ClipboardManager::class.java)
    val code = state.pair?.joinCode.orEmpty()
    Card(shape = RoundedCornerShape(22.dp)) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Waiting for your partner", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Text("Share this code through a channel you trust. It expires according to server policy.")
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(16.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .clickable(enabled = code.isNotEmpty()) {
                        clipboard.setPrimaryClip(ClipData.newPlainText("RafayPair invite code", code))
                    }
                    .padding(16.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(code, fontSize = 25.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 3.sp)
                Spacer(Modifier.width(10.dp))
                Icon(Icons.Default.ContentCopy, contentDescription = "Copy invite code", modifier = Modifier.size(20.dp))
            }
            TextButton(onClick = viewModel::refresh, modifier = Modifier.align(Alignment.End)) { Text("Check connection") }
            TextButton(onClick = requestDisconnect, modifier = Modifier.align(Alignment.End)) {
                Text("Cancel invite", color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

@Composable
private fun ConnectedPairCard(state: MainUiState, requestDisconnect: () -> Unit) {
    val connected = state.realtime == RealtimeState.CONNECTED
    Card(shape = RoundedCornerShape(22.dp)) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(48.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primaryContainer),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Icons.Default.Favorite, contentDescription = null, tint = Coral500)
                }
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(state.pair?.partner?.displayName ?: "Your partner", fontWeight = FontWeight.Bold, fontSize = 19.sp)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier
                                .size(8.dp)
                                .clip(CircleShape)
                                .background(if (connected) Mint400 else MaterialTheme.colorScheme.outline),
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(realtimeLabel(state.realtime), style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            HorizontalDivider()
            Text(
                "Realtime carries derived care events only. It never streams camera or microphone data.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall,
            )
            TextButton(onClick = requestDisconnect, modifier = Modifier.align(Alignment.End)) {
                Text("Disconnect pair", color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

@Composable
private fun CareScreen(state: MainUiState, viewModel: MainViewModel) {
    if (state.pair?.status != PairStatus.ACTIVE) {
        EmptyFeatureScreen(Icons.Default.Favorite, "Care starts with a pair", "Connect securely on Home before sending care.")
        return
    }
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 18.dp)) {
            Text("Care", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text("A gentle signal, never an emergency service.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item { CareComposerCard(state, viewModel) }
            if (state.care.isEmpty()) {
                item {
                    EmptyTimelineCard()
                }
            } else {
                item {
                    Text("Recent", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                }
                items(state.care, key = { it.id }) { item ->
                    CareItemCard(item, state, viewModel)
                }
            }
        }
    }
}

@Composable
private fun CareComposerCard(state: MainUiState, viewModel: MainViewModel) {
    val busy = "care" in state.busyActions
    Card(
        shape = RoundedCornerShape(22.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(vertical = 18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Send a care signal", Modifier.padding(horizontal = 18.dp), fontWeight = FontWeight.Bold, fontSize = 18.sp)
            LazyRow(
                contentPadding = PaddingValues(horizontal = 18.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(CareKind.entries) { kind ->
                    FilterChip(
                        selected = state.composer.kind == kind,
                        onClick = { viewModel.selectCareKind(kind) },
                        label = { Text(kind.title) },
                        leadingIcon = if (state.composer.kind == kind) {
                            { Icon(Icons.Default.Check, contentDescription = null, Modifier.size(18.dp)) }
                        } else null,
                    )
                }
            }
            OutlinedTextField(
                value = state.composer.message,
                onValueChange = viewModel::setCareMessage,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 18.dp),
                label = { Text("Optional note") },
                placeholder = { Text(state.composer.kind.prompt) },
                supportingText = { Text("${state.composer.message.length}/500") },
                minLines = 2,
                maxLines = 4,
                enabled = !busy,
            )
            Button(
                onClick = viewModel::sendCare,
                enabled = !busy && state.partnerSharingAllowed,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 18.dp),
            ) {
                if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else {
                    Icon(Icons.Default.Favorite, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text(if (state.partnerSharingAllowed) "Send care" else "Paused")
                }
            }
        }
    }
}

@Composable
private fun CareItemCard(item: CareItem, state: MainUiState, viewModel: MainViewModel) {
    val received = item.direction == CareDirection.RECEIVED
    val local = item.id.startsWith("local:")
    Card(
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (received) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface,
        ),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(if (received) Icons.Default.Inbox else Icons.Default.Favorite, null, Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text(item.kind.title, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                StatusPill(item.status)
            }
            item.message?.let { Text(it) }
            val otherParty = when {
                item.status == CareDeliveryStatus.BLOCKED -> "a previous partner connection"
                else -> item.otherDisplayName ?: "your partner"
            }
            Text(
                "${if (received) "From" else "To"} $otherParty · ${formatTime(item)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (received && item.status == CareDeliveryStatus.SENT) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { viewModel.respondCare(item.id, CareResponse.ACCEPTED) },
                        enabled = state.partnerSharingAllowed && "respond:${item.id}" !in state.busyActions,
                        modifier = Modifier.weight(1f),
                    ) { Text("Accept") }
                    OutlinedButton(
                        onClick = { viewModel.respondCare(item.id, CareResponse.DECLINED) },
                        enabled = state.partnerSharingAllowed && "respond:${item.id}" !in state.busyActions,
                        modifier = Modifier.weight(1f),
                    ) { Text("Decline") }
                }
            }
            if (local && item.clientRequestId != null) {
                Row(Modifier.align(Alignment.End)) {
                    if (item.status == CareDeliveryStatus.FAILED) {
                        TextButton(onClick = { viewModel.retryCare(item.clientRequestId) }) { Text("Retry") }
                    }
                    IconButton(onClick = { viewModel.deleteDraft(item.clientRequestId) }) {
                        Icon(Icons.Default.DeleteOutline, contentDescription = "Delete queued care request")
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusPill(status: CareDeliveryStatus) {
    val label = when (status) {
        CareDeliveryStatus.DRAFT -> "Draft"
        CareDeliveryStatus.QUEUED -> "Queued"
        CareDeliveryStatus.SENT -> "Pending"
        CareDeliveryStatus.ACCEPTED -> "Accepted"
        CareDeliveryStatus.DECLINED -> "Declined"
        CareDeliveryStatus.FAILED -> "Needs attention"
        CareDeliveryStatus.BLOCKED -> "Not sent"
    }
    Text(
        label,
        modifier = Modifier
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 9.dp, vertical = 4.dp),
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
    )
}

@Composable
private fun ConsentScreen(state: MainUiState, viewModel: MainViewModel) {
    if (state.pair?.status != PairStatus.ACTIVE) {
        EmptyFeatureScreen(Icons.Default.Security, "Consent center", "Connect with a partner before granting any access.")
        return
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item {
            Text("Consent center", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(
                "Every category is off until you enable it. Changes are confirmed by the server before access changes.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        items(state.grants, key = { it.capability.name }) { grant ->
            ConsentRow(grant, state.pendingConsent, !state.partnerSharingAllowed, viewModel::updateConsent)
        }
        item {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)) {
                Column(Modifier.padding(16.dp)) {
                    Text("Your controls stay independent", fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "AI context cannot bypass another category. Your partner cannot activate this phone’s sensors, and privacy pause overrides every grant locally.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
}

@Composable
private fun ConsentRow(
    grant: ConsentGrant,
    pending: ConsentCapability?,
    paused: Boolean,
    onUpdate: (ConsentCapability, Boolean) -> Unit,
) {
    val isPending = pending == grant.capability
    Card(shape = RoundedCornerShape(18.dp)) {
        Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(grant.capability.title, fontWeight = FontWeight.Bold)
                Text(
                    grant.capability.description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (paused && grant.granted) {
                    Text("Temporarily overridden by privacy pause", color = MaterialTheme.colorScheme.error, fontSize = 11.sp)
                }
            }
            Spacer(Modifier.width(12.dp))
            if (isPending) CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
            else Switch(
                checked = grant.granted,
                onCheckedChange = { onUpdate(grant.capability, it) },
                enabled = pending == null,
            )
        }
    }
}

@Composable
private fun AccountScreen(user: User, state: MainUiState, viewModel: MainViewModel) {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Text("Account", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        }
        item {
            Card(shape = RoundedCornerShape(22.dp)) {
                Row(Modifier.padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier
                            .size(54.dp)
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.primaryContainer),
                        contentAlignment = Alignment.Center,
                    ) { Text(user.displayName.take(1).uppercase(), fontWeight = FontWeight.Bold, fontSize = 22.sp) }
                    Spacer(Modifier.width(14.dp))
                    Column {
                        Text(user.displayName, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                        Text(user.email, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        item { PrivacyControlCard(state, viewModel) }
        item {
            Card(shape = RoundedCornerShape(18.dp)) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Security", fontWeight = FontWeight.Bold)
                    Text("Session tokens are AES-GCM encrypted with a rotating Android Keystore key.")
                    Text("Care notes cached for offline use are encrypted before Room persistence.")
                    Text("Channel: ${BuildConfig.RELEASE_CHANNEL} · v${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        item {
            OutlinedButton(
                onClick = viewModel::logout,
                enabled = "logout" !in state.busyActions,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = null)
                Spacer(Modifier.width(8.dp))
                Text("Sign out")
            }
        }
    }
}

@Composable
private fun NotificationPermissionCard(state: MainUiState, viewModel: MainViewModel) {
    val context = LocalContext.current
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) viewModel.enableNotifications()
    }
    val busy = "notifications" in state.busyActions

    Card(shape = RoundedCornerShape(18.dp)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Notifications, contentDescription = null)
                Spacer(Modifier.width(10.dp))
                Text("Care notifications", fontWeight = FontWeight.Bold)
            }
            Text(
                "Push messages contain only a wake signal. RafayPair signs in and refetches before showing a generic update.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedButton(
                onClick = {
                    val notificationsEnabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
                    val runtimeGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                        PackageManager.PERMISSION_GRANTED
                    when {
                        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !runtimeGranted -> {
                            permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                        }
                        !notificationsEnabled -> {
                            context.startActivity(
                                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                                    data = "package:${context.packageName}".toUri()
                                    putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                                },
                            )
                        }
                        else -> viewModel.enableNotifications()
                    }
                },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else Text("Enable care notifications")
            }
        }
    }
}

@Composable
private fun PausedBanner(syncPending: Boolean) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.errorContainer)
            .padding(horizontal = 18.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Default.Lock, contentDescription = null, Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(
            if (syncPending) "Privacy paused locally · server sync pending" else "Privacy paused · partner sharing stopped",
            fontWeight = FontWeight.SemiBold,
            fontSize = 13.sp,
        )
    }
}

@Composable
private fun EmptyFeatureScreen(icon: ImageVector, title: String, text: String) {
    Box(Modifier.fillMaxSize().padding(28.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(icon, contentDescription = null, Modifier.size(52.dp), tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(14.dp))
            Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
            Spacer(Modifier.height(6.dp))
            Text(text, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun EmptyTimelineCard() {
    Box(
        Modifier
            .fillMaxWidth()
            .border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.35f), RoundedCornerShape(18.dp))
            .padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text("No care requests yet", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun HeartMark() {
    Box(
        Modifier
            .size(76.dp)
            .clip(RoundedCornerShape(24.dp))
            .background(Brush.linearGradient(listOf(Color(0xFFFF7D82), Color(0xFFE63679)))),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Default.Favorite, contentDescription = null, tint = Color.White, modifier = Modifier.size(42.dp))
    }
}

private fun realtimeLabel(state: RealtimeState): String = when (state) {
    RealtimeState.STOPPED -> "Realtime stopped"
    RealtimeState.CONNECTING -> "Connecting securely"
    RealtimeState.CONNECTED -> "Realtime connected"
    RealtimeState.RECOVERING -> "Reconnecting"
}

private fun formatTime(item: CareItem): String = DateTimeFormatter
    .ofPattern("MMM d, h:mm a")
    .withZone(ZoneId.systemDefault())
    .format(item.createdAt)
