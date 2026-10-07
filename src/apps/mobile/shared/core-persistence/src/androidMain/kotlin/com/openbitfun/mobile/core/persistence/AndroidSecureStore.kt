package com.openbitfun.mobile.core.persistence

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private class AndroidSecureStore(
    context: Context,
    namespace: String,
) : SecureStore {
    private val preferences = context.getSharedPreferences("openbitfun_secure_" + namespace, Context.MODE_PRIVATE)
    private val alias = "openbitfun.mobile." + namespace

    override fun read(key: String): ByteArray? {
        val packed = preferences.getString(key, null) ?: return null
        val parts = packed.split('.')
        if (parts.size != 2) return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
            cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP))
        } catch (_: Throwable) {
            null
        }
    }

    override fun write(key: String, value: ByteArray) {
        try {
            writeWithKey(key, value)
        } catch (cause: Throwable) {
            // Android may retain a Keystore alias while uninstalling the app
            // clears SharedPreferences. Replacing the alias is safe only when
            // this namespace has no encrypted records to preserve.
            if (preferences.all.isNotEmpty()) throw cause
            Log.w(TAG, "Secure store key failed on a fresh install; recreating it", cause)
            deleteKeyAlias()
            writeWithKey(key, value)
        }
    }

    override fun delete(key: String) {
        check(preferences.edit().remove(key).commit()) { "Secure value could not be removed." }
    }

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEY_STORE).also { it.load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEY_STORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun writeWithKey(key: String, value: ByteArray) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val packed = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + "." +
            Base64.encodeToString(cipher.doFinal(value), Base64.NO_WRAP)
        check(preferences.edit().putString(key, packed).commit()) { "Secure value could not be persisted." }
    }

    private fun deleteKeyAlias() {
        val keyStore = KeyStore.getInstance(KEY_STORE).also { it.load(null) }
        if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias)
    }

    companion object {
        private const val KEY_STORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG = "OpenBitFunSecureStore"
    }
}

public fun androidSecureStore(context: Context, namespace: String): SecureStore =
    AndroidSecureStore(context.applicationContext, namespace)
