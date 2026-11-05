//! End-to-end encryption for Remote Connect.
//!
//! Uses X25519 ECDH for key exchange and AES-256-GCM for authenticated encryption.
//! Both sides generate ephemeral keypairs; the shared secret is derived via ECDH
//! and used directly as the AES-256-GCM key (X25519 output is already 32 bytes).

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::RngCore;
use x25519_dalek::{PublicKey, StaticSecret};

const NONCE_SIZE: usize = 12;

/// Holds a keypair for X25519 ECDH key exchange.
pub struct KeyPair {
    secret: StaticSecret,
    public: PublicKey,
}

impl KeyPair {
    pub fn generate() -> Self {
        let secret = StaticSecret::random_from_rng(OsRng);
        let public = PublicKey::from(&secret);
        Self { secret, public }
    }

    pub fn public_key_bytes(&self) -> [u8; 32] {
        self.public.to_bytes()
    }

    pub fn public_key_base64(&self) -> String {
        BASE64.encode(self.public.to_bytes())
    }

    /// Derive a shared secret from our secret key and the peer's public key.
    pub fn derive_shared_secret(&self, peer_public_bytes: &[u8; 32]) -> [u8; 32] {
        let peer_public = PublicKey::from(*peer_public_bytes);
        let shared = self.secret.diffie_hellman(&peer_public);
        *shared.as_bytes()
    }
}

/// Encrypts plaintext using AES-256-GCM with a random nonce.
/// Returns `(ciphertext, nonce)` both as raw bytes.
pub fn encrypt(shared_secret: &[u8; 32], plaintext: &[u8]) -> Result<(Vec<u8>, [u8; NONCE_SIZE])> {
    let cipher =
        Aes256Gcm::new_from_slice(shared_secret).map_err(|e| anyhow!("cipher init: {e}"))?;

    let mut nonce_bytes = [0u8; NONCE_SIZE];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| anyhow!("encrypt: {e}"))?;

    Ok((ciphertext, nonce_bytes))
}

/// Decrypts ciphertext using AES-256-GCM.
pub fn decrypt(
    shared_secret: &[u8; 32],
    ciphertext: &[u8],
    nonce_bytes: &[u8; NONCE_SIZE],
) -> Result<Vec<u8>> {
    let cipher =
        Aes256Gcm::new_from_slice(shared_secret).map_err(|e| anyhow!("cipher init: {e}"))?;
    let nonce = Nonce::from_slice(nonce_bytes);

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| anyhow!("decrypt: {e}"))
}

/// Convenience: encrypt a string and return base64-encoded `(data, nonce)`.
pub fn encrypt_to_base64(shared_secret: &[u8; 32], plaintext: &str) -> Result<(String, String)> {
    encrypt_relay_message(shared_secret, plaintext, false)
}

pub fn encrypt_relay_message(
    shared_secret: &[u8; 32],
    plaintext: &str,
    accepts_zstd: bool,
) -> Result<(String, String)> {
    let bytes = super::message_encoding::encode(plaintext.as_bytes(), accepts_zstd)?;
    let (ct, nonce) = encrypt(shared_secret, &bytes)?;
    Ok((BASE64.encode(ct), BASE64.encode(nonce)))
}

/// Convenience: decrypt from base64-encoded `(data, nonce)`.
pub fn decrypt_from_base64(
    shared_secret: &[u8; 32],
    ciphertext_b64: &str,
    nonce_b64: &str,
) -> Result<String> {
    super::message_encoding::decode(open_relay_ciphertext(
        shared_secret,
        ciphertext_b64,
        nonce_b64,
    )?)
}

pub(super) fn open_relay_ciphertext(
    shared_secret: &[u8; 32],
    ciphertext_b64: &str,
    nonce_b64: &str,
) -> Result<Vec<u8>> {
    let ct = BASE64
        .decode(ciphertext_b64)
        .map_err(|e| anyhow!("base64 decode ciphertext: {e}"))?;
    let nonce_vec = BASE64
        .decode(nonce_b64)
        .map_err(|e| anyhow!("base64 decode nonce: {e}"))?;

    if nonce_vec.len() != NONCE_SIZE {
        return Err(anyhow!(
            "invalid nonce length: expected {NONCE_SIZE}, got {}",
            nonce_vec.len()
        ));
    }
    let mut nonce = [0u8; NONCE_SIZE];
    nonce.copy_from_slice(&nonce_vec);

    decrypt(shared_secret, &ct, &nonce)
}

/// Parse a base64-encoded public key into 32-byte array.
pub fn parse_public_key(b64: &str) -> Result<[u8; 32]> {
    let bytes = BASE64
        .decode(b64)
        .map_err(|e| anyhow!("base64 decode public key: {e}"))?;
    if bytes.len() != 32 {
        return Err(anyhow!(
            "invalid public key length: expected 32, got {}",
            bytes.len()
        ));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_exchange_and_encrypt_decrypt() {
        let alice = KeyPair::generate();
        let bob = KeyPair::generate();

        let alice_shared = alice.derive_shared_secret(&bob.public_key_bytes());
        let bob_shared = bob.derive_shared_secret(&alice.public_key_bytes());
        assert_eq!(alice_shared, bob_shared);

        let message = "Hello, Remote Connect!";
        let (ct, nonce) = encrypt(&alice_shared, message.as_bytes()).unwrap();
        let decrypted = decrypt(&bob_shared, &ct, &nonce).unwrap();
        assert_eq!(decrypted, message.as_bytes());
    }

    #[test]
    fn test_base64_round_trip() {
        let alice = KeyPair::generate();
        let bob = KeyPair::generate();

        let shared = alice.derive_shared_secret(&bob.public_key_bytes());
        let message = "加密测试消息 with unicode 🔒";
        let (ct_b64, nonce_b64) = encrypt_to_base64(&shared, message).unwrap();
        let decrypted = decrypt_from_base64(&shared, &ct_b64, &nonce_b64).unwrap();
        assert_eq!(decrypted, message);
    }

    #[test]
    fn test_wrong_key_fails() {
        let alice = KeyPair::generate();
        let bob = KeyPair::generate();
        let eve = KeyPair::generate();

        let alice_shared = alice.derive_shared_secret(&bob.public_key_bytes());
        let eve_shared = eve.derive_shared_secret(&bob.public_key_bytes());

        let (ct, nonce) = encrypt(&alice_shared, b"secret").unwrap();
        assert!(decrypt(&eve_shared, &ct, &nonce).is_err());
    }

    #[test]
    fn test_parse_public_key() {
        let kp = KeyPair::generate();
        let b64 = kp.public_key_base64();
        let parsed = parse_public_key(&b64).unwrap();
        assert_eq!(parsed, kp.public_key_bytes());
    }

    #[test]
    fn test_tampered_ciphertext_fails() {
        let alice = KeyPair::generate();
        let bob = KeyPair::generate();
        let shared = alice.derive_shared_secret(&bob.public_key_bytes());

        let (mut ct, nonce) = encrypt(&shared, b"secret data").unwrap();
        if let Some(byte) = ct.last_mut() {
            *byte ^= 0xff;
        }
        assert!(decrypt(&shared, &ct, &nonce).is_err());
    }
}
