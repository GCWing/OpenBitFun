//! QR code generation for Remote Connect pairing.

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use qrcode::QrCode;

pub struct QrGenerator;

pub struct QrPresentation {
    pub image_url: String,
    pub terminal: Option<String>,
}

impl QrGenerator {
    /// Provider QR content may be an existing image or the text to encode.
    /// A login/deep-link URL is not an image URL.
    pub fn present_content(content: &str) -> Result<QrPresentation> {
        let content = content.trim();
        let image_url = content.to_ascii_lowercase().starts_with("data:image/")
            || reqwest::Url::parse(content).ok().is_some_and(|url| {
                matches!(url.scheme(), "http" | "https")
                    && [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]
                        .iter()
                        .any(|extension| url.path().to_ascii_lowercase().ends_with(extension))
            });
        if image_url {
            return Ok(QrPresentation {
                image_url: content.into(),
                terminal: None,
            });
        }
        let code = QrCode::new(content.as_bytes())
            .map_err(|error| anyhow!("QR code generation failed: {error}"))?;
        Ok(QrPresentation {
            image_url: format!(
                "data:image/png;base64,{}",
                Self::generate_png_base64_from_url(content)?
            ),
            terminal: Some(
                code.render::<qrcode::render::unicode::Dense1x2>()
                    .quiet_zone(true)
                    .build(),
            ),
        })
    }

    /// Account-device invitations carry only a target id. Identity and public
    /// keys are resolved through the authenticated same-account directory.
    pub fn build_device_url(web_app_url: &str, device_id: &str) -> Result<String> {
        if device_id.is_empty()
            || device_id.len() > 128
            || !device_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(anyhow!("Invalid account device id"));
        }
        let mut url = super::account::validate_relay_base_url(web_app_url)?;
        url.set_path(&format!("{}/", url.path().trim_end_matches('/')));
        url.set_fragment(Some(&format!("/pair?did={device_id}")));
        Ok(url.to_string())
    }

    /// Generate a QR code as a base64-encoded PNG from a pre-built URL.
    pub fn generate_png_base64_from_url(url: &str) -> Result<String> {
        let code =
            QrCode::new(url.as_bytes()).map_err(|e| anyhow!("QR code generation failed: {e}"))?;
        let img = code.render::<image::Luma<u8>>().quiet_zone(true).build();
        let mut buf = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut buf);
        image::ImageEncoder::write_image(
            encoder,
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::L8,
        )
        .map_err(|e| anyhow!("PNG encoding failed: {e}"))?;
        Ok(BASE64.encode(&buf))
    }

    /// Generate the QR code as an SVG string from a pre-built URL.
    pub fn generate_svg_from_url(url: &str) -> Result<String> {
        let code =
            QrCode::new(url.as_bytes()).map_err(|e| anyhow!("QR code generation failed: {e}"))?;
        let svg = code
            .render::<qrcode::render::svg::Color>()
            .quiet_zone(true)
            .build();
        Ok(svg)
    }
}

#[cfg(test)]
mod account_device_tests {
    use super::QrGenerator;
    use base64::Engine;

    #[test]
    fn provider_login_link_is_encoded_instead_of_treated_as_an_image() {
        let presentation =
            QrGenerator::present_content("https://liteapp.weixin.qq.com/login?code=example")
                .unwrap();
        let png = super::BASE64
            .decode(
                presentation
                    .image_url
                    .strip_prefix("data:image/png;base64,")
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert!(presentation.terminal.unwrap().contains('\u{2588}'));
        for image in [
            "https://example.test/qr.png?code=1",
            "data:image/png;base64,aGVsbG8=",
        ] {
            let presentation = QrGenerator::present_content(image).unwrap();
            assert_eq!(presentation.image_url, image);
            assert!(presentation.terminal.is_none());
        }
    }

    #[test]
    fn invitation_uses_only_the_authenticated_device_target() {
        assert_eq!(
            QrGenerator::build_device_url("https://remote.openbitfun.com/v/1.0.2", "host-1")
                .unwrap(),
            "https://remote.openbitfun.com/v/1.0.2/#/pair?did=host-1"
        );
        for id in ["", "host&relay=evil", "../host", "host/other"] {
            assert!(
                QrGenerator::build_device_url("https://remote.openbitfun.com/v/1.0.2", id).is_err()
            );
        }
    }
}
