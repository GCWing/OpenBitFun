# OpenBitFun Android

Android application entrypoint over the Kotlin Multiplatform shared core.

Provisional source layout:

- `app/src/main/kotlin/`: Kotlin application code.
- `app/src/main/res/`: Android resources.

Build a debug artifact with:

```bash
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ./gradlew :app:assembleDebug
```

An unsigned release is available only for local inspection and must be
requested explicitly:

```bash
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ./gradlew -PallowUnsignedRelease=true :app:assembleRelease
```

For a signed release, set `OPENBITFUN_ANDROID_KEYSTORE`,
`OPENBITFUN_ANDROID_KEYSTORE_PASSWORD`, `OPENBITFUN_ANDROID_KEY_ALIAS`, and
`OPENBITFUN_ANDROID_KEY_PASSWORD`. Release builds enable R8 and resource shrinking.
