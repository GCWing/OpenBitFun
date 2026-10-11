# Kotlin serialization serializers are referenced from generated code.
-keepattributes *Annotation*,InnerClasses,EnclosingMethod

# SQLDelight schemas and Ktor engines are referenced through generated/service metadata.
-keep class com.openbitfun.mobile.core.persistence.db.** { *; }
-dontwarn org.slf4j.**

# BouncyCastle registers these services by class name. R8 cannot see those
# reflective edges; keep the mappings and implementations used by relay crypto.
-keep class org.bouncycastle.jcajce.provider.asymmetric.EdEC$Mappings { *; }
-keepnames class org.bouncycastle.jcajce.provider.asymmetric.EdEC
-keep class org.bouncycastle.jcajce.provider.asymmetric.edec.** { *; }
-keepnames class org.bouncycastle.jcajce.provider.symmetric.AES
-keep class org.bouncycastle.jcajce.provider.symmetric.AES$* { *; }
-keepnames class org.bouncycastle.jcajce.provider.digest.SHA256
-keep class org.bouncycastle.jcajce.provider.digest.SHA256$* { *; }
