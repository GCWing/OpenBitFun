//! Best-effort detection of the operating system HTTP proxy.
//!
//! Desktop users often reach an AI provider only through a local proxy agent
//! (Clash, V2Ray, a corporate gateway) that is configured in the OS. reqwest
//! reads only process environment variables, so a client built without an
//! explicit proxy bypasses that setting and fails to connect even though the
//! browser and other apps work. This module supplies the missing OS view.
//!
//! Detection never fails the caller: an unreadable or malformed setting returns
//! `None` and the request proceeds without a proxy.

/// Proxy the operating system would apply to an HTTPS request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemProxy {
    /// Proxy URL with an explicit scheme, for example `http://127.0.0.1:7897`.
    pub url: String,
    /// Hosts that must bypass the proxy, ready for `reqwest::NoProxy` syntax.
    pub no_proxy: Option<String>,
}

/// Hosts that must never be sent through a system proxy.
///
/// Local model servers (Ollama, LM Studio, llama.cpp) bind to loopback and a
/// proxy agent is not required for them; routing those through the proxy is a
/// common source of hard-to-diagnose connection failures.
#[cfg(any(windows, test))]
const LOOPBACK_NO_PROXY: &str = "localhost,127.0.0.1,::1";

/// Detect the proxy the current user configured in the operating system.
#[cfg(windows)]
pub fn detect() -> Option<SystemProxy> {
    windows_registry::detect()
}

/// Environment variables remain the only portable source outside Windows, and
/// reqwest already honours them on its own.
#[cfg(not(windows))]
pub fn detect() -> Option<SystemProxy> {
    None
}

/// Turn a registry `ProxyServer` value into a single proxy URL.
///
/// The setting is either a bare `host:port` applied to every protocol or a
/// per-protocol list such as `http=127.0.0.1:7897;https=127.0.0.1:7897`.
#[cfg(any(windows, test))]
fn parse_proxy_server(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let candidate = if trimmed.contains('=') {
        let mut http = None;
        let mut https = None;
        for entry in trimmed.split(';') {
            let mut pair = entry.splitn(2, '=');
            let scheme = pair.next().unwrap_or_default().trim().to_ascii_lowercase();
            let value = pair.next().unwrap_or_default().trim();
            if value.is_empty() {
                continue;
            }
            match scheme.as_str() {
                "https" => https = Some(value.to_string()),
                "http" => http = Some(value.to_string()),
                _ => {}
            }
        }
        https.or(http)?
    } else {
        trimmed.to_string()
    };

    Some(with_scheme(&candidate))
}

#[cfg(any(windows, test))]
fn with_scheme(value: &str) -> String {
    if value.contains("://") {
        value.to_string()
    } else {
        format!("http://{value}")
    }
}

/// Convert a registry `ProxyOverride` value into `reqwest::NoProxy` syntax.
///
/// `<local>` means "bypass plain hostnames"; entries are separated by `;` and
/// may use `*` wildcards, which reqwest understands.
#[cfg(any(windows, test))]
fn parse_proxy_override(raw: &str) -> Option<String> {
    let mut entries: Vec<String> = Vec::new();
    let mut bypass_plain_hostnames = false;

    for entry in raw.split(';') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        if entry.eq_ignore_ascii_case("<local>") {
            bypass_plain_hostnames = true;
            continue;
        }
        entries.push(entry.to_string());
    }

    if bypass_plain_hostnames && !entries.iter().any(|entry| entry == "*") {
        entries.push("*".to_string());
    }

    (!entries.is_empty()).then(|| entries.join(","))
}

/// Combine the mandatory loopback bypass with the user's own override list.
#[cfg(any(windows, test))]
fn merged_no_proxy(override_list: Option<String>) -> Option<String> {
    match override_list {
        Some(list) if !list.is_empty() => Some(format!("{LOOPBACK_NO_PROXY},{list}")),
        _ => Some(LOOPBACK_NO_PROXY.to_string()),
    }
}

#[cfg(windows)]
mod windows_registry {
    use super::{merged_no_proxy, parse_proxy_override, parse_proxy_server, SystemProxy};
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            Foundation::ERROR_SUCCESS,
            System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ},
        },
    };

    const INTERNET_SETTINGS: PCWSTR =
        w!("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings");

    pub(super) fn detect() -> Option<SystemProxy> {
        if read_dword(w!("ProxyEnable"))? == 0 {
            return None;
        }

        let server = read_string(w!("ProxyServer"))?;
        let url = parse_proxy_server(&server)?;
        let no_proxy = merged_no_proxy(
            read_string(w!("ProxyOverride")).and_then(|raw| parse_proxy_override(&raw)),
        );

        Some(SystemProxy { url, no_proxy })
    }

    fn read_dword(name: PCWSTR) -> Option<u32> {
        let mut value = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                INTERNET_SETTINGS,
                name,
                RRF_RT_REG_DWORD,
                None,
                Some((&mut value as *mut u32).cast()),
                Some(&mut size),
            )
        };
        (status == ERROR_SUCCESS).then_some(value)
    }

    fn read_string(name: PCWSTR) -> Option<String> {
        let mut stack = [0u16; 1024];
        let mut size = (stack.len() * 2) as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                INTERNET_SETTINGS,
                name,
                RRF_RT_REG_SZ,
                None,
                Some(stack.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }

        let written = (size as usize / 2).min(stack.len());
        let end = stack[..written]
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(written);
        Some(String::from_utf16_lossy(&stack[..end]))
    }
}

#[cfg(test)]
mod tests {
    use super::{merged_no_proxy, parse_proxy_override, parse_proxy_server};

    #[test]
    fn bare_host_and_port_gets_a_scheme() {
        assert_eq!(
            parse_proxy_server("127.0.0.1:7897").as_deref(),
            Some("http://127.0.0.1:7897")
        );
    }

    #[test]
    fn explicit_scheme_is_preserved() {
        assert_eq!(
            parse_proxy_server("socks5://127.0.0.1:1080").as_deref(),
            Some("socks5://127.0.0.1:1080")
        );
    }

    #[test]
    fn per_protocol_list_prefers_https() {
        assert_eq!(
            parse_proxy_server("http=127.0.0.1:7890;https=127.0.0.1:7891").as_deref(),
            Some("http://127.0.0.1:7891")
        );
        assert_eq!(
            parse_proxy_server("http=127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
    }

    #[test]
    fn empty_server_value_is_not_a_proxy() {
        assert_eq!(parse_proxy_server("   "), None);
        assert_eq!(parse_proxy_server("http=;https="), None);
    }

    #[test]
    fn override_list_keeps_explicit_entries() {
        assert_eq!(
            parse_proxy_override("*.internal;10.*").as_deref(),
            Some("*.internal,10.*")
        );
    }

    #[test]
    fn override_list_translates_local_marker() {
        assert_eq!(parse_proxy_override("<local>").as_deref(), Some("*"));
        assert_eq!(
            parse_proxy_override("<local>;*.corp.example").as_deref(),
            Some("*.corp.example,*")
        );
        assert_eq!(parse_proxy_override("  "), None);
    }

    #[test]
    fn loopback_always_bypasses_the_proxy() {
        assert_eq!(
            merged_no_proxy(None).as_deref(),
            Some("localhost,127.0.0.1,::1")
        );
        assert_eq!(
            merged_no_proxy(Some("*.corp".to_string())).as_deref(),
            Some("localhost,127.0.0.1,::1,*.corp")
        );
    }
}
