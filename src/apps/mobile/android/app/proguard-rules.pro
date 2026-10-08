# Kotlin serialization serializers are referenced from generated code.
-keepattributes *Annotation*,InnerClasses,EnclosingMethod

# SQLDelight schemas and Ktor engines are referenced through generated/service metadata.
-keep class com.openbitfun.mobile.core.persistence.db.** { *; }
-dontwarn org.slf4j.**

# BouncyCastle is reached through JCA name lookup (Provider.getService), which
# R8 cannot see. Shrinking it strips the X25519 and AES-GCM implementations the
# account login and device RPC depend on; the failure only surfaces at runtime,
# after the browser authorization succeeds, as a malformed-response error.
-keep class org.bouncycastle.** { *; }
-dontwarn org.bouncycastle.**
