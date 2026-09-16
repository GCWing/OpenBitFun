plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.android.kmp.library)
}

kotlin {
    jvmToolchain(17)

    jvm()

    android {
        namespace = "com.openbitfun.mobile.core.transport"
        compileSdk = libs.versions.androidCompileSdk.get().toInt()
        minSdk = libs.versions.androidMinSdk.get().toInt()
        withHostTest {}
        // Carries the envelope round trip onto ART alongside core-crypto's vectors:
        // a provider that disagreed only on a real device would corrupt every
        // command body, not just the handshake.
        withDeviceTest {
            instrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        }
    }

    iosArm64()
    iosSimulatorArm64()

    sourceSets {
        commonMain.dependencies {
            api(project(":core-protocol"))
            api(project(":core-crypto"))
            implementation(libs.kotlinx.coroutines.core)
            implementation(libs.kotlinx.serialization.json)
            // Bodies are encoded with RelayJson by hand rather than through
            // ContentNegotiation, so the wire format cannot drift with whatever
            // converters the surrounding app installs on its own client.
            implementation(libs.ktor.client.core)
            implementation(libs.ktor.client.websockets)
            implementation(libs.socketio.codec)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation(project(":core-testing"))
            implementation(libs.kotlinx.coroutines.test)
            implementation(libs.ktor.client.mock)
        }
        // The device suite *is* the common suite, recompiled for ART. Sharing the
        // directory rather than copying a smoke subset keeps the two from drifting.
        getByName("androidDeviceTest") {
            kotlin.srcDir("src/commonTest/kotlin")
            dependencies {
                implementation(kotlin("test"))
                implementation(project(":core-testing"))
                implementation(libs.kotlinx.coroutines.test)
                implementation(libs.ktor.client.mock)
                implementation(libs.androidx.test.runner)
            }
        }
        androidMain.dependencies {
            implementation(libs.ktor.client.okhttp)
        }
        // The JVM engine backs the host-side integration test against
        // harmonyos/tools/fake-relay.mjs.
        jvmMain.dependencies {
            implementation(libs.ktor.client.java)
        }
        jvmTest.dependencies {
            implementation(libs.ktor.client.okhttp)
        }
        iosMain.dependencies {
            implementation(libs.ktor.client.darwin)
        }
    }
}

// FakeRelayIntegrationTest only runs when a live harmonyos/tools/fake-relay.mjs
// pairing URL is supplied; without it the test reports a skip and passes, so CI
// needs no node process.
tasks.withType<Test>().configureEach {
    systemProperty(
        "openbitfun.pairingUrl",
        providers.gradleProperty("openbitfun.pairingUrl").getOrElse(""),
    )
}
