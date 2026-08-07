import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.net.URI

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

fun quoted(value: String): String = "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

fun externalConfig(name: String): String = providers.gradleProperty(name)
    .orElse(providers.environmentVariable(name))
    .orNull
    .orEmpty()

val firebaseApplicationId = externalConfig("RAFAYPAIR_FIREBASE_APPLICATION_ID")
val firebaseApiKey = externalConfig("RAFAYPAIR_FIREBASE_API_KEY")
val firebaseProjectId = externalConfig("RAFAYPAIR_FIREBASE_PROJECT_ID")
val firebaseSenderId = externalConfig("RAFAYPAIR_FIREBASE_SENDER_ID")
val playIntegrityCloudProjectNumberRaw = externalConfig("RAFAYPAIR_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER")
val playIntegrityCloudProjectNumber = playIntegrityCloudProjectNumberRaw.toLongOrNull() ?: 0L

data class EndpointPair(
    val apiBaseUrl: String,
    val realtimeUrl: String,
)

fun configuredEndpointPair(
    configurationPrefix: String?,
    fallbackApiBaseUrl: String,
    fallbackRealtimeUrl: String,
    allowInsecureTransport: Boolean,
): EndpointPair {
    val apiName = configurationPrefix?.let { "${it}_API_BASE_URL" } ?: "API_BASE_URL"
    val realtimeName = configurationPrefix?.let { "${it}_REALTIME_URL" } ?: "REALTIME_URL"
    val apiBaseUrl = configurationPrefix
        ?.let { externalConfig(apiName) }
        ?.ifBlank { fallbackApiBaseUrl }
        ?: fallbackApiBaseUrl
    val realtimeUrl = configurationPrefix
        ?.let { externalConfig(realtimeName) }
        ?.ifBlank { fallbackRealtimeUrl }
        ?: fallbackRealtimeUrl
    val apiUri = runCatching { URI(apiBaseUrl) }.getOrNull()
    val realtimeUri = runCatching { URI(realtimeUrl) }.getOrNull()
    val apiSchemes = if (allowInsecureTransport) setOf("http", "https") else setOf("https")
    val realtimeSchemes = if (allowInsecureTransport) setOf("ws", "wss") else setOf("wss")

    require(
        apiUri != null &&
            apiUri.scheme in apiSchemes &&
            !apiUri.host.isNullOrBlank() &&
            apiUri.userInfo == null &&
            apiUri.query == null &&
            apiUri.fragment == null &&
            (apiUri.path.isNullOrEmpty() || apiUri.path == "/"),
    ) {
        "$apiName must be an origin-only ${apiSchemes.sorted().joinToString("/")} URL without credentials, query, or fragment"
    }
    require(
        realtimeUri != null &&
            realtimeUri.scheme in realtimeSchemes &&
            !realtimeUri.host.isNullOrBlank() &&
            realtimeUri.userInfo == null &&
            realtimeUri.query == null &&
            realtimeUri.fragment == null &&
            realtimeUri.path == "/v1/realtime",
    ) {
        "$realtimeName must be an absolute ${realtimeSchemes.sorted().joinToString("/")} URL " +
            "with the exact /v1/realtime path and no credentials, query, or fragment"
    }
    val expectedRealtimeScheme = if (apiUri.scheme == "https") "wss" else "ws"
    val apiPort = if (apiUri.port >= 0) apiUri.port else if (apiUri.scheme == "https") 443 else 80
    val realtimePort = if (realtimeUri.port >= 0) {
        realtimeUri.port
    } else if (realtimeUri.scheme == "wss") {
        443
    } else {
        80
    }
    require(
        realtimeUri.scheme == expectedRealtimeScheme &&
            apiUri.host.equals(realtimeUri.host, ignoreCase = true) &&
            apiPort == realtimePort,
    ) {
        "$apiName and $realtimeName must use matching secure transports, host, and port"
    }
    return EndpointPair(apiBaseUrl, realtimeUrl)
}

val debugEndpoints = configuredEndpointPair(
    configurationPrefix = "RAFAYPAIR_ANDROID_DEBUG",
    fallbackApiBaseUrl = "http://10.0.2.2:3000",
    fallbackRealtimeUrl = "ws://10.0.2.2:3000/v1/realtime",
    allowInsecureTransport = true,
)
val developmentEndpoints = configuredEndpointPair(
    configurationPrefix = "RAFAYPAIR_ANDROID_DEVELOPMENT",
    fallbackApiBaseUrl = "https://dev-api.rafaypair.com",
    fallbackRealtimeUrl = "wss://dev-api.rafaypair.com/v1/realtime",
    allowInsecureTransport = false,
)
val stagingEndpoints = configuredEndpointPair(
    configurationPrefix = "RAFAYPAIR_ANDROID_STAGING",
    fallbackApiBaseUrl = "https://staging-api.rafaypair.com",
    fallbackRealtimeUrl = "wss://staging-api.rafaypair.com/v1/realtime",
    allowInsecureTransport = false,
)
val productionEndpoints = configuredEndpointPair(
    configurationPrefix = null,
    fallbackApiBaseUrl = "https://api.rafaypair.com",
    fallbackRealtimeUrl = "wss://api.rafaypair.com/v1/realtime",
    allowInsecureTransport = false,
)

fun firebaseConfigErrors(): List<String> = buildList {
    val applicationIdMatch = Regex("^1:([0-9]{6,20}):android:[0-9a-fA-F]+$").matchEntire(firebaseApplicationId)
    if (applicationIdMatch == null) {
        add("RAFAYPAIR_FIREBASE_APPLICATION_ID")
    }
    if (!firebaseApiKey.matches(Regex("^AIza[0-9A-Za-z_-]{35}$"))) {
        add("RAFAYPAIR_FIREBASE_API_KEY")
    }
    if (!firebaseProjectId.matches(Regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$"))) {
        add("RAFAYPAIR_FIREBASE_PROJECT_ID")
    }
    val senderIdIsValid = firebaseSenderId.matches(Regex("^[0-9]{6,20}$"))
    if (!senderIdIsValid) {
        add("RAFAYPAIR_FIREBASE_SENDER_ID")
    }
    if (applicationIdMatch != null && senderIdIsValid && applicationIdMatch.groupValues[1] != firebaseSenderId) {
        add("RAFAYPAIR_FIREBASE_APPLICATION_ID")
        add("RAFAYPAIR_FIREBASE_SENDER_ID")
    }
}

fun playIntegrityConfigErrors(): List<String> = buildList {
    if (
        !playIntegrityCloudProjectNumberRaw.matches(Regex("^[1-9][0-9]{5,18}$")) ||
        playIntegrityCloudProjectNumber <= 0L
    ) {
        add("RAFAYPAIR_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER")
    }
}

val releaseVersionCode = providers.environmentVariable("RAFAYPAIR_ANDROID_VERSION_CODE").orNull?.let { raw ->
    require(raw.matches(Regex("[1-9][0-9]*"))) {
        "RAFAYPAIR_ANDROID_VERSION_CODE must be a positive base-10 integer"
    }
    val parsed = raw.toLongOrNull()
    require(parsed != null && parsed <= Int.MAX_VALUE) {
        "RAFAYPAIR_ANDROID_VERSION_CODE must be between 1 and ${Int.MAX_VALUE}"
    }
    parsed.toInt()
} ?: 1

android {
    namespace = "com.rafaypair.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.rafaypair.android"
        minSdk = 28
        targetSdk = 36
        versionCode = releaseVersionCode
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        testInstrumentationRunnerArguments["clearPackageData"] = "true"
        buildConfigField("String", "API_BASE_URL", quoted(productionEndpoints.apiBaseUrl))
        buildConfigField("String", "REALTIME_URL", quoted(productionEndpoints.realtimeUrl))
        buildConfigField("String", "RELEASE_CHANNEL", quoted("production"))
        buildConfigField("String", "FIREBASE_APPLICATION_ID", quoted(firebaseApplicationId))
        buildConfigField("String", "FIREBASE_API_KEY", quoted(firebaseApiKey))
        buildConfigField("String", "FIREBASE_PROJECT_ID", quoted(firebaseProjectId))
        buildConfigField("String", "FIREBASE_SENDER_ID", quoted(firebaseSenderId))
        buildConfigField("boolean", "REQUIRE_FIREBASE_CONFIGURATION", "true")
        buildConfigField("long", "PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER", "${playIntegrityCloudProjectNumber}L")
        buildConfigField("boolean", "REQUIRE_PLAY_INTEGRITY_CONFIGURATION", "true")
    }

    val releaseStoreFile = providers.environmentVariable("RAFAYPAIR_ANDROID_STORE_FILE").orNull
    val releaseStorePassword = providers.environmentVariable("RAFAYPAIR_ANDROID_STORE_PASSWORD").orNull
    val releaseKeyAlias = providers.environmentVariable("RAFAYPAIR_ANDROID_KEY_ALIAS").orNull
    val releaseKeyPassword = providers.environmentVariable("RAFAYPAIR_ANDROID_KEY_PASSWORD").orNull
    if (listOf(releaseStoreFile, releaseStorePassword, releaseKeyAlias, releaseKeyPassword).all { it != null }) {
        signingConfigs.create("release") {
            storeFile = file(requireNotNull(releaseStoreFile))
            storePassword = requireNotNull(releaseStorePassword)
            keyAlias = requireNotNull(releaseKeyAlias)
            keyPassword = requireNotNull(releaseKeyPassword)
            enableV1Signing = true
            enableV2Signing = true
            enableV3Signing = true
            enableV4Signing = true
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            buildConfigField("String", "API_BASE_URL", quoted(debugEndpoints.apiBaseUrl))
            buildConfigField("String", "REALTIME_URL", quoted(debugEndpoints.realtimeUrl))
            buildConfigField("String", "RELEASE_CHANNEL", quoted("dev-local"))
            buildConfigField("boolean", "REQUIRE_FIREBASE_CONFIGURATION", "false")
            buildConfigField("long", "PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER", "0L")
            buildConfigField("boolean", "REQUIRE_PLAY_INTEGRITY_CONFIGURATION", "false")
        }
        create("development") {
            initWith(getByName("debug"))
            matchingFallbacks += listOf("debug")
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            buildConfigField("String", "API_BASE_URL", quoted(developmentEndpoints.apiBaseUrl))
            buildConfigField("String", "REALTIME_URL", quoted(developmentEndpoints.realtimeUrl))
            buildConfigField("String", "RELEASE_CHANNEL", quoted("development"))
            buildConfigField("boolean", "REQUIRE_FIREBASE_CONFIGURATION", "false")
        }
        create("staging") {
            initWith(getByName("release"))
            matchingFallbacks += listOf("release")
            isDebuggable = false
            // Protected CI injects the stable internal keystore. Without it,
            // local staging builds are deliberately unsigned/non-distributable.
            signingConfig = signingConfigs.findByName("release")
            applicationIdSuffix = ".staging"
            versionNameSuffix = "-staging"
            buildConfigField("String", "API_BASE_URL", quoted(stagingEndpoints.apiBaseUrl))
            buildConfigField("String", "REALTIME_URL", quoted(stagingEndpoints.realtimeUrl))
            buildConfigField("String", "RELEASE_CHANNEL", quoted("staging"))
        }
        release {
            isDebuggable = false
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
        isCoreLibraryDesugaringEnabled = false
    }

    sourceSets {
        // The cross-platform engine parity vectors. Pointing at the repository
        // directory keeps a single source of truth rather than a copy that can
        // drift from the TypeScript and Swift suites.
        getByName("test") {
            resources.directories.add(rootProject.file("../../tests/golden").path)
        }
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        execution = "ANDROIDX_TEST_ORCHESTRATOR"
    }

    lint {
        lintConfig = file("lint.xml")
        abortOnError = true
        warningsAsErrors = true
        checkReleaseBuilds = true
    }

    packaging {
        resources.excludes += setOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            "META-INF/DEPENDENCIES",
            "META-INF/LICENSE*",
            "META-INF/NOTICE*",
        )
    }
}

val verifyEnvironmentEndpoints = tasks.register("verifyEnvironmentEndpoints") {
    group = "verification"
    description = "Validates every API/WebSocket pair embedded in Android BuildConfig variants."
    val endpoints = mapOf(
        "debug" to debugEndpoints,
        "development" to developmentEndpoints,
        "staging" to stagingEndpoints,
        "production" to productionEndpoints,
    )
    endpoints.forEach { (environment, endpoint) ->
        inputs.property("$environment.apiBaseUrl", endpoint.apiBaseUrl)
        inputs.property("$environment.realtimeUrl", endpoint.realtimeUrl)
    }
    mapOf(
        "development" to "dev-api.rafaypair.com",
        "staging" to "staging-api.rafaypair.com",
        "production" to "api.rafaypair.com",
    ).forEach { (environment, expectedHost) ->
        val overridePrefix = environment.takeIf { it != "production" }?.uppercase()
        val hasExplicitOverride = overridePrefix != null &&
            listOf(
                "RAFAYPAIR_ANDROID_${overridePrefix}_API_BASE_URL",
                "RAFAYPAIR_ANDROID_${overridePrefix}_REALTIME_URL",
            ).any { externalConfig(it).isNotBlank() }
        inputs.property("$environment.expectedDefaultHost", expectedHost.takeUnless { hasExplicitOverride }.orEmpty())
    }
    doLast {
        listOf("development", "staging", "production").forEach { environment ->
            val expectedHost = inputs.properties.getValue("$environment.expectedDefaultHost").toString()
            if (expectedHost.isNotEmpty()) {
                val apiBaseUrl = inputs.properties.getValue("$environment.apiBaseUrl").toString()
                val realtimeUrl = inputs.properties.getValue("$environment.realtimeUrl").toString()
                check(URI(apiBaseUrl).host == expectedHost) {
                    "$environment BuildConfig must embed API host $expectedHost"
                }
                check(URI(realtimeUrl).host == expectedHost) {
                    "$environment BuildConfig must embed realtime host $expectedHost"
                }
            }
        }
    }
}

val verifyProductionPushConfig = tasks.register("verifyProductionPushConfig") {
    group = "verification"
    description = "Fails distributable builds unless the public Firebase Android identifiers are supplied."
    inputs.property("invalidFirebaseConfigFields", firebaseConfigErrors().sorted().joinToString())
    doLast {
        val invalid = inputs.properties.getValue("invalidFirebaseConfigFields").toString()
        check(invalid.isBlank()) {
            "Production FCM configuration is missing or malformed: $invalid. " +
                "Supply project identifiers through protected CI variables; never add a service-account key."
        }
    }
}

val verifyProductionPlayIntegrityConfig = tasks.register("verifyProductionPlayIntegrityConfig") {
    group = "verification"
    description = "Fails distributable builds unless the public Play Integrity Cloud project number is supplied."
    inputs.property("invalidPlayIntegrityConfigFields", playIntegrityConfigErrors().sorted().joinToString())
    doLast {
        val invalid = inputs.properties.getValue("invalidPlayIntegrityConfigFields").toString()
        check(invalid.isBlank()) {
            "Production Play Integrity configuration is missing or malformed: $invalid. " +
                "Supply the public Cloud project number through a protected CI variable; credentials remain backend-only."
        }
    }
}

tasks.configureEach {
    if (name.matches(Regex("generate(Debug|Development|Staging|Release)BuildConfig"))) {
        dependsOn(verifyEnvironmentEndpoints)
    }
    if (
        name in setOf(
            "assembleRelease",
            "bundleRelease",
            "packageRelease",
            "assembleStaging",
            "bundleStaging",
            "packageStaging",
        )
    ) {
        dependsOn(verifyProductionPushConfig)
        dependsOn(verifyProductionPlayIntegrityConfig)
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
        allWarningsAsErrors.set(true)
        freeCompilerArgs.addAll("-Xjsr305=strict", "-Xconsistent-data-class-copy-visibility")
    }
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
    arg("room.generateKotlin", "true")
    arg("room.incremental", "true")
}

dependencies {
    // On-device camera and pose inference. ML Kit runs the model locally; no
    // frame or landmark is transmitted anywhere.
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.pose.detection)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.icons)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)
    implementation(libs.androidx.datastore)
    implementation(libs.androidx.work)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    implementation(libs.play.integrity)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.androidx.test.core)

    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.test.espresso)
    androidTestUtil(libs.androidx.test.orchestrator)
}
