// AGP 9 compiles Kotlin itself; applying org.jetbrains.kotlin.android on top is
// an error rather than a no-op. Only the Compose compiler plugin is added.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

val releaseKeystorePath = providers.environmentVariable("OPENBITFUN_ANDROID_KEYSTORE").orNull
val releaseKeystorePassword = providers.environmentVariable("OPENBITFUN_ANDROID_KEYSTORE_PASSWORD").orNull
val releaseKeyAlias = providers.environmentVariable("OPENBITFUN_ANDROID_KEY_ALIAS").orNull
val releaseKeyPassword = providers.environmentVariable("OPENBITFUN_ANDROID_KEY_PASSWORD").orNull
val hasReleaseSigning = listOf(
    releaseKeystorePath,
    releaseKeystorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { !it.isNullOrBlank() }
val allowUnsignedRelease = providers.gradleProperty("allowUnsignedRelease")
    .map { it.equals("true", ignoreCase = true) }
    .orElse(false)
    .get()
android {
    sourceSets.getByName("main").assets.srcDir(file("../../../../shared/terminal/webview/generated"))
    namespace = "com.openbitfun.mobile.app"
    compileSdk = libs.versions.androidCompileSdk.get().toInt()

    defaultConfig {
        // Same family as com.openbitfun.desktop; see the implementation plan section 3.
        applicationId = "com.openbitfun.mobile"
        minSdk = libs.versions.androidMinSdk.get().toInt()
        targetSdk = libs.versions.androidTargetSdk.get().toInt()
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures {
        compose = true
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseKeystorePath!!)
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            // Suffixed so a debug build can sit next to a release one on the
            // same device while pairing against different desktops.
            applicationIdSuffix = ".debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            isDebuggable = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = when {
                hasReleaseSigning -> signingConfigs.getByName("release")
                allowUnsignedRelease -> null
                else -> signingConfigs.getByName("debug")
            }
        }
    }
}

dependencies {
    // The only shared module an app may name. Everything below it — transport,
    // crypto, persistence — is reached through UiState and Intent or not at all.
    implementation("com.openbitfun.mobile:core-feature")

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.window)

    testImplementation("junit:junit:4.13.2")

    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.runner)
    // Compose BOM 2026.06.01 still selects Espresso 3.5.0, whose reflective
    // InputManager path is removed on Android 17. Pin the fixed AndroidX Test
    // release explicitly until the BOM updates its transitive constraint.
    androidTestImplementation(libs.androidx.test.espresso)
}

// Project product-owned offline tools into Android assets before packaging.
val generateMiniApps by tasks.registering(Exec::class) {
    workingDir(rootProject.file("../miniapps"))
    commandLine("node", "generate.cjs", "android")
}
tasks.named("preBuild").configure { dependsOn(generateMiniApps) }
