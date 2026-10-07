# OpenBitFun Android

Android application entrypoint over the Kotlin Multiplatform shared core.

Provisional source layout:

- `app/src/main/kotlin/`: Kotlin application code.
- `app/src/main/res/`: Android resources.

Build a debug artifact with:

```bash
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ./gradlew :app:assembleDebug
```

Release builds use the standard Android debug keystore by default when formal
release signing credentials are not configured. This keeps locally packaged
APKs installable and upgrade-compatible with other APKs signed by the same
local debug keystore.

For a deliberately unsigned artifact used only for local inspection, request
it explicitly:

```bash
JAVA_HOME='/Applications/Android Studio.app/Contents/jbr/Contents/Home' ./gradlew -PallowUnsignedRelease=true :app:assembleRelease
```

For a release signed with a formal keystore, set `OPENBITFUN_ANDROID_KEYSTORE`,
`OPENBITFUN_ANDROID_KEYSTORE_PASSWORD`, `OPENBITFUN_ANDROID_KEY_ALIAS`, and
`OPENBITFUN_ANDROID_KEY_PASSWORD`. Release builds enable R8 and resource shrinking.
