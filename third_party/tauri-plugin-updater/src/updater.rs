// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{
    collections::HashMap,
    ffi::OsString,
    io::Cursor,
    path::{Path, PathBuf},
    str::FromStr,
    sync::Arc,
    time::Duration,
};

#[cfg(not(target_os = "macos"))]
use std::ffi::OsStr;

use base64::Engine;
use futures_util::StreamExt;
use http::{header::ACCEPT, HeaderName};
use minisign_verify::{PublicKey, Signature};
use percent_encoding::{AsciiSet, CONTROLS};
use reqwest::{
    header::{HeaderMap, HeaderValue},
    ClientBuilder, StatusCode,
};
use semver::Version;
use serde::{de::Error as DeError, Deserialize, Deserializer, Serialize};
use tauri::{
    utils::{
        config::BundleType,
        platform::{bundle_type, current_exe},
    },
    AppHandle, Resource, Runtime,
};
use time::OffsetDateTime;
use url::Url;

use crate::{
    error::{Error, Result},
    Config,
};

const UPDATER_USER_AGENT: &str = concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"),);

#[derive(Copy, Clone)]
pub enum Installer {
    AppImage,
    Deb,
    Rpm,

    App,

    Msi,
    Nsis,
}

impl Installer {
    fn name(self) -> &'static str {
        match self {
            Self::AppImage => "appimage",
            Self::Deb => "deb",
            Self::Rpm => "rpm",
            Self::App => "app",
            Self::Msi => "msi",
            Self::Nsis => "nsis",
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ReleaseManifestPlatform {
    /// Download URL for the platform
    pub url: Url,
    /// Signature for the platform
    pub signature: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(untagged)]
pub enum RemoteReleaseInner {
    Dynamic(ReleaseManifestPlatform),
    Static {
        platforms: HashMap<String, ReleaseManifestPlatform>,
    },
}

/// Information about a release returned by the remote update server.
///
/// This type can have one of two shapes: Server Format (Dynamic Format) and Static Format.
#[derive(Debug, Clone)]
pub struct RemoteRelease {
    /// Version to install.
    pub version: Version,
    /// Release notes.
    pub notes: Option<String>,
    /// Release date.
    pub pub_date: Option<OffsetDateTime>,
    /// Release data.
    pub data: RemoteReleaseInner,
}

impl RemoteRelease {
    /// The release's download URL for the given target.
    pub fn download_url(&self, target: &str) -> Result<&Url> {
        match self.data {
            RemoteReleaseInner::Dynamic(ref platform) => Ok(&platform.url),
            RemoteReleaseInner::Static { ref platforms } => platforms
                .get(target)
                .map_or(Err(Error::TargetNotFound(target.to_string())), |p| {
                    Ok(&p.url)
                }),
        }
    }

    /// The release's signature for the given target.
    pub fn signature(&self, target: &str) -> Result<&String> {
        match self.data {
            RemoteReleaseInner::Dynamic(ref platform) => Ok(&platform.signature),
            RemoteReleaseInner::Static { ref platforms } => platforms
                .get(target)
                .map_or(Err(Error::TargetNotFound(target.to_string())), |platform| {
                    Ok(&platform.signature)
                }),
        }
    }
}

pub type OnBeforeExit = Arc<dyn Fn() + Send + Sync + 'static>;
pub type OnBeforeRequest = Arc<dyn Fn(ClientBuilder) -> ClientBuilder + Send + Sync + 'static>;
pub type VersionComparator = Arc<dyn Fn(Version, RemoteRelease) -> bool + Send + Sync>;
type MainThreadClosure = Box<dyn FnOnce() + Send + Sync + 'static>;
type RunOnMainThread =
    Box<dyn Fn(MainThreadClosure) -> std::result::Result<(), tauri::Error> + Send + Sync + 'static>;

pub struct UpdaterBuilder {
    #[allow(dead_code)]
    run_on_main_thread: RunOnMainThread,
    app_name: String,
    current_version: Version,
    config: Config,
    pub(crate) version_comparator: Option<VersionComparator>,
    executable_path: Option<PathBuf>,
    target: Option<String>,
    endpoints: Option<Vec<Url>>,
    headers: HeaderMap,
    timeout: Option<Duration>,
    proxy: Option<Url>,
    no_proxy: bool,
    installer_args: Vec<OsString>,
    current_exe_args: Vec<OsString>,
    on_before_exit: Option<OnBeforeExit>,
    installation_receipt: Option<PathBuf>,
    maintenance_result_roots: Option<(PathBuf, PathBuf)>,
    configure_client: Option<OnBeforeRequest>,
}

impl UpdaterBuilder {
    pub(crate) fn new<R: Runtime>(app: &AppHandle<R>, config: crate::Config) -> Self {
        let app_ = app.clone();
        let run_on_main_thread = move |f| app_.run_on_main_thread(f);
        Self {
            run_on_main_thread: Box::new(run_on_main_thread),
            installer_args: config
                .windows
                .as_ref()
                .map(|w| w.installer_args.clone())
                .unwrap_or_default(),
            current_exe_args: Vec::new(),
            app_name: app.package_info().name.clone(),
            current_version: app.package_info().version.clone(),
            config,
            version_comparator: None,
            executable_path: None,
            target: None,
            endpoints: None,
            headers: Default::default(),
            timeout: None,
            proxy: None,
            no_proxy: false,
            on_before_exit: None,
            installation_receipt: None,
            maintenance_result_roots: None,
            configure_client: None,
        }
    }

    pub fn version_comparator<F: Fn(Version, RemoteRelease) -> bool + Send + Sync + 'static>(
        mut self,
        f: F,
    ) -> Self {
        self.version_comparator = Some(Arc::new(f));
        self
    }

    pub fn target(mut self, target: impl Into<String>) -> Self {
        self.target.replace(target.into());
        self
    }

    pub fn endpoints(mut self, endpoints: Vec<Url>) -> Result<Self> {
        crate::config::validate_endpoints(
            &endpoints,
            self.config.dangerous_insecure_transport_protocol,
        )?;

        self.endpoints.replace(endpoints);
        Ok(self)
    }

    pub fn executable_path<P: AsRef<Path>>(mut self, p: P) -> Self {
        self.executable_path.replace(p.as_ref().into());
        self
    }

    pub fn header<K, V>(mut self, key: K, value: V) -> Result<Self>
    where
        HeaderName: TryFrom<K>,
        <HeaderName as TryFrom<K>>::Error: Into<http::Error>,
        HeaderValue: TryFrom<V>,
        <HeaderValue as TryFrom<V>>::Error: Into<http::Error>,
    {
        let key: std::result::Result<HeaderName, http::Error> = key.try_into().map_err(Into::into);
        let value: std::result::Result<HeaderValue, http::Error> =
            value.try_into().map_err(Into::into);
        self.headers.insert(key?, value?);

        Ok(self)
    }

    pub fn headers(mut self, headers: HeaderMap) -> Self {
        self.headers = headers;
        self
    }

    pub fn clear_headers(mut self) -> Self {
        self.headers.clear();
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub fn proxy(mut self, proxy: Url) -> Self {
        self.proxy.replace(proxy);
        self
    }

    /// Clear all proxies. See [`reqwest::ClientBuilder::no_proxy`](https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html#method.no_proxy).
    pub fn no_proxy(mut self) -> Self {
        self.no_proxy = true;
        self
    }

    pub fn pubkey<S: Into<String>>(mut self, pubkey: S) -> Self {
        self.config.pubkey = pubkey.into();
        self
    }

    /// Adds an argument to pass to the Windows installer.
    pub fn installer_arg<S>(mut self, arg: S) -> Self
    where
        S: Into<OsString>,
    {
        self.installer_args.push(arg.into());
        self
    }

    /// Adds multiple arguments to pass to the Windows installer.
    pub fn installer_args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.installer_args.extend(args.into_iter().map(Into::into));
        self
    }

    /// Removes all the additional arguments to pass to the Windows installer.
    ///
    /// Note: this only removes the additional arguments added through
    /// [`Self::installer_arg`], [`crate::Builder::installer_arg`]
    /// and the `plugins > updater > windows > installerArgs` config,
    /// not the ones managed by us (e.g. `/UPDATER` flag passed to the NSIS installer)
    pub fn clear_installer_args(mut self) -> Self {
        self.installer_args.clear();
        self
    }

    /// Function to run before we run the installer and exit the app through `std::process::exit(0)` on Windows
    /// Persist the detached Windows installer outcome for the next application launch.
    pub fn installation_receipt(mut self, path: PathBuf) -> Self {
        self.installation_receipt = Some(path);
        self
    }

    /// Directories used by the standalone maintenance host for native outcomes
    /// under the original user and elevated machine accounts, respectively.
    pub fn maintenance_result_roots(mut self, user: PathBuf, machine: PathBuf) -> Self {
        self.maintenance_result_roots = Some((user, machine));
        self
    }

    pub fn on_before_exit<F: Fn() + Send + Sync + 'static>(mut self, f: F) -> Self {
        self.on_before_exit.replace(Arc::new(f));
        self
    }

    /// Allows you to modify the `reqwest` client builder before the HTTP request is sent.
    ///
    /// Note that `reqwest` crate may be updated in minor releases of tauri-plugin-updater.
    /// Therefore it's recommended to pin the plugin to at least a minor version when you're using `configure_client`.
    pub fn configure_client<F: Fn(ClientBuilder) -> ClientBuilder + Send + Sync + 'static>(
        mut self,
        f: F,
    ) -> Self {
        self.configure_client.replace(Arc::new(f));
        self
    }

    pub fn build(self) -> Result<Updater> {
        let endpoints = self
            .endpoints
            .unwrap_or_else(|| self.config.endpoints.clone());

        if endpoints.is_empty() {
            return Err(Error::EmptyEndpoints);
        };

        let arch = updater_arch().ok_or(Error::UnsupportedArch)?;

        let executable_path = self.executable_path.clone().unwrap_or(current_exe()?);

        // Get the extract_path from the provided executable_path
        let extract_path = if cfg!(target_os = "linux") {
            executable_path
        } else {
            extract_path_from_executable(&executable_path)?
        };

        Ok(Updater {
            run_on_main_thread: Arc::new(self.run_on_main_thread),
            config: self.config,
            app_name: self.app_name,
            current_version: self.current_version,
            version_comparator: self.version_comparator,
            timeout: self.timeout,
            proxy: self.proxy,
            no_proxy: self.no_proxy,
            endpoints,
            installer_args: self.installer_args,
            current_exe_args: self.current_exe_args,
            arch,
            target: self.target,
            headers: self.headers,
            extract_path,
            on_before_exit: self.on_before_exit,
            installation_receipt: self.installation_receipt,
            maintenance_result_roots: self.maintenance_result_roots,
            configure_client: self.configure_client,
        })
    }
}

impl UpdaterBuilder {
    pub(crate) fn current_exe_args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.current_exe_args
            .extend(args.into_iter().map(Into::into));
        self
    }
}

pub struct Updater {
    #[allow(dead_code)]
    run_on_main_thread: Arc<RunOnMainThread>,
    config: Config,
    app_name: String,
    current_version: Version,
    version_comparator: Option<VersionComparator>,
    timeout: Option<Duration>,
    proxy: Option<Url>,
    no_proxy: bool,
    endpoints: Vec<Url>,
    arch: &'static str,
    // The `{{target}}` variable we replace in the endpoint and serach for in the JSON,
    // this is either the user provided target or the current operating system by default
    target: Option<String>,
    headers: HeaderMap,
    extract_path: PathBuf,
    on_before_exit: Option<OnBeforeExit>,
    installation_receipt: Option<PathBuf>,
    maintenance_result_roots: Option<(PathBuf, PathBuf)>,
    configure_client: Option<OnBeforeRequest>,
    #[allow(unused)]
    installer_args: Vec<OsString>,
    #[allow(unused)]
    current_exe_args: Vec<OsString>,
}

impl Updater {
    pub async fn check(&self) -> Result<Option<Update>> {
        // we want JSON only
        let mut headers = self.headers.clone();
        if !headers.contains_key(ACCEPT) {
            headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        }

        // Set SSL certs for linux if they aren't available.
        #[cfg(target_os = "linux")]
        {
            if std::env::var_os("SSL_CERT_FILE").is_none() {
                std::env::set_var("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt");
            }
            if std::env::var_os("SSL_CERT_DIR").is_none() {
                std::env::set_var("SSL_CERT_DIR", "/etc/ssl/certs");
            }
        }
        let target = if let Some(target) = &self.target {
            target
        } else {
            updater_os().ok_or(Error::UnsupportedOs)?
        };

        let mut remote_release: Option<RemoteRelease> = None;
        let mut raw_json: Option<serde_json::Value> = None;
        let mut last_error: Option<Error> = None;
        for url in &self.endpoints {
            // replace {{current_version}}, {{target}}, {{arch}} and {{bundle_type}} in the provided URL
            // this is useful if we need to query example
            // https://releases.myapp.com/update/{{target}}/{{arch}}/{{current_version}}
            // will be translated into ->
            // https://releases.myapp.com/update/darwin/aarch64/1.0.0
            // The main objective is if the update URL is defined via the Cargo.toml
            // the URL will be generated dynamically
            let version = self.current_version.to_string();
            let version = version.as_bytes();
            const CONTROLS_ADD: &AsciiSet = &CONTROLS.add(b'+');
            let encoded_version = percent_encoding::percent_encode(version, CONTROLS_ADD);
            let encoded_version = encoded_version.to_string();
            let installer = installer_for_bundle_type(bundle_type())
                .map(|i| i.name())
                .unwrap_or("unknown");

            let url: Url = url
                .to_string()
                // url::Url automatically url-encodes the path components
                .replace("%7B%7Bcurrent_version%7D%7D", &encoded_version)
                .replace("%7B%7Btarget%7D%7D", target)
                .replace("%7B%7Barch%7D%7D", self.arch)
                .replace("%7B%7Bbundle_type%7D%7D", installer)
                // but not query parameters
                .replace("{{current_version}}", &encoded_version)
                .replace("{{target}}", target)
                .replace("{{arch}}", self.arch)
                .replace("{{bundle_type}}", installer)
                .parse()?;

            log::debug!("checking for updates {url}");

            #[cfg(feature = "rustls-tls")]
            if rustls::crypto::CryptoProvider::get_default().is_none() {
                // This can only fail if there is already a default provider which we checked for already.
                let _ = rustls::crypto::ring::default_provider().install_default();
            }

            let mut request = ClientBuilder::new()
                .user_agent(UPDATER_USER_AGENT)
                .connect_timeout(Duration::from_secs(20))
                .read_timeout(Duration::from_secs(60));
            if self.config.dangerous_accept_invalid_certs {
                request = request.danger_accept_invalid_certs(true);
            }
            if self.config.dangerous_accept_invalid_hostnames {
                request = request.danger_accept_invalid_hostnames(true);
            }
            if let Some(timeout) = self.timeout {
                request = request.timeout(timeout);
            }
            if self.no_proxy {
                log::debug!("disabling proxy");
                request = request.no_proxy();
            } else if let Some(ref proxy) = self.proxy {
                log::debug!("using proxy {proxy}");
                let proxy = reqwest::Proxy::all(proxy.as_str())?;
                request = request.proxy(proxy);
            }

            if let Some(ref configure_client) = self.configure_client {
                request = configure_client(request);
            }

            let response = request
                .build()?
                .get(url)
                .headers(headers.clone())
                .send()
                .await;

            match response {
                Ok(res) => {
                    if res.status().is_success() {
                        // no updates found!
                        if StatusCode::NO_CONTENT == res.status() {
                            log::debug!("update endpoint returned 204 No Content");
                            return Ok(None);
                        };

                        let update_response: serde_json::Value = res.json().await?;
                        log::debug!("update response: {update_response:?}");
                        raw_json = Some(update_response.clone());
                        match serde_json::from_value::<RemoteRelease>(update_response)
                            .map_err(Into::into)
                        {
                            Ok(release) => {
                                log::debug!("parsed release response {release:?}");
                                last_error = None;
                                remote_release = Some(release);
                                // we found a release, break the loop
                                break;
                            }
                            Err(err) => {
                                log::error!("failed to deserialize update response: {err}");
                                last_error = Some(err)
                            }
                        }
                    } else {
                        log::error!(
                            "update endpoint did not respond with a successful status code"
                        );
                    }
                }
                Err(err) => {
                    log::error!("failed to check for updates: {err}");
                    last_error = Some(err.into())
                }
            }
        }

        // Last error is cleaned on success.
        // Shouldn't be triggered if we had a successfull call
        if let Some(error) = last_error {
            return Err(error);
        }

        // Extracted remote metadata
        let release = remote_release.ok_or(Error::ReleaseNotFound)?;

        let should_update = match self.version_comparator.as_ref() {
            Some(comparator) => comparator(self.current_version.clone(), release.clone()),
            None => release.version > self.current_version,
        };

        let installer = installer_for_bundle_type(bundle_type());
        let (download_url, signature) = self.get_urls(&release, &installer)?;

        let update = if should_update {
            Some(Update {
                run_on_main_thread: self.run_on_main_thread.clone(),
                config: self.config.clone(),
                on_before_exit: self.on_before_exit.clone(),
                installation_receipt: self.installation_receipt.clone(),
                maintenance_result_roots: self.maintenance_result_roots.clone(),
                app_name: self.app_name.clone(),
                current_version: self.current_version.to_string(),
                target: target.to_owned(),
                extract_path: self.extract_path.clone(),
                version: release.version.to_string(),
                date: release.pub_date,
                download_url: download_url.clone(),
                signature: signature.to_owned(),
                body: release.notes,
                raw_json: raw_json.unwrap(),
                timeout: None,
                proxy: self.proxy.clone(),
                no_proxy: self.no_proxy,
                headers: self.headers.clone(),
                installer_args: self.installer_args.clone(),
                current_exe_args: self.current_exe_args.clone(),
                configure_client: self.configure_client.clone(),
            })
        } else {
            None
        };

        Ok(update)
    }

    fn get_urls<'a>(
        &self,
        release: &'a RemoteRelease,
        installer: &Option<Installer>,
    ) -> Result<(&'a Url, &'a String)> {
        // Use the user provided target
        if let Some(target) = &self.target {
            return Ok((release.download_url(target)?, release.signature(target)?));
        }

        // Or else we search for [`{os}-{arch}-{installer}`, `{os}-{arch}`] in order
        let os = updater_os().ok_or(Error::UnsupportedOs)?;
        let arch = self.arch;
        let mut targets = Vec::new();
        if let Some(installer) = installer {
            let installer = installer.name();
            targets.push(format!("{os}-{arch}-{installer}"));
        }
        targets.push(format!("{os}-{arch}"));

        for target in &targets {
            log::debug!("Searching for updater target '{target}' in release data");
            if let (Ok(download_url), Ok(signature)) =
                (release.download_url(target), release.signature(target))
            {
                return Ok((download_url, signature));
            };
        }

        Err(Error::TargetsNotFound(targets))
    }
}

#[derive(Clone)]
pub struct Update {
    #[allow(dead_code)]
    run_on_main_thread: Arc<RunOnMainThread>,
    config: Config,
    #[allow(unused)]
    on_before_exit: Option<OnBeforeExit>,
    installation_receipt: Option<PathBuf>,
    #[allow(unused)]
    maintenance_result_roots: Option<(PathBuf, PathBuf)>,
    /// Update description
    pub body: Option<String>,
    /// Version used to check for update
    pub current_version: String,
    /// Version announced
    pub version: String,
    /// Update publish date
    pub date: Option<OffsetDateTime>,
    /// The `{{target}}` variable we replace in the endpoint and search for in the JSON,
    /// this is either the user provided target or the current operating system by default
    pub target: String,
    /// Download URL announced
    pub download_url: Url,
    /// Signature announced
    pub signature: String,
    /// The raw version of server's JSON response. Useful if the response contains additional fields that the updater doesn't handle.
    pub raw_json: serde_json::Value,
    /// Request timeout
    pub timeout: Option<Duration>,
    /// Request proxy
    pub proxy: Option<Url>,
    /// Disable system proxy
    pub no_proxy: bool,
    /// Request headers
    pub headers: HeaderMap,
    /// Extract path
    #[allow(unused)]
    extract_path: PathBuf,
    /// App name, used for creating named tempfiles on Windows
    #[allow(unused)]
    app_name: String,
    #[allow(unused)]
    installer_args: Vec<OsString>,
    #[allow(unused)]
    current_exe_args: Vec<OsString>,
    configure_client: Option<OnBeforeRequest>,
}

impl Resource for Update {}

impl Update {
    /// Downloads the updater package, verifies it then return it as bytes.
    ///
    /// Use [`Update::install`] to install it
    pub async fn download<C: FnMut(usize, Option<u64>), D: FnOnce()>(
        &self,
        mut on_chunk: C,
        on_download_finish: D,
    ) -> Result<Vec<u8>> {
        // set our headers
        let mut headers = self.headers.clone();
        if !headers.contains_key(ACCEPT) {
            headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));
        }

        let mut request = ClientBuilder::new()
            .user_agent(UPDATER_USER_AGENT)
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(60));
        if self.config.dangerous_accept_invalid_certs {
            request = request.danger_accept_invalid_certs(true);
        }
        if self.config.dangerous_accept_invalid_hostnames {
            request = request.danger_accept_invalid_hostnames(true);
        }
        if let Some(timeout) = self.timeout {
            request = request.timeout(timeout);
        }
        if self.no_proxy {
            request = request.no_proxy();
        } else if let Some(ref proxy) = self.proxy {
            let proxy = reqwest::Proxy::all(proxy.as_str())?;
            request = request.proxy(proxy);
        }
        if let Some(ref configure_client) = self.configure_client {
            request = configure_client(request);
        }
        let response = request
            .build()?
            .get(self.download_url.clone())
            .headers(headers)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(Error::Network(format!(
                "Download request failed with status: {}",
                response.status()
            )));
        }

        let content_length: Option<u64> = response
            .headers()
            .get("Content-Length")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok());

        let mut buffer = Vec::new();

        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            on_chunk(chunk.len(), content_length);
            buffer.extend(chunk);
        }
        on_download_finish();

        verify_signature(&buffer, &self.signature, &self.config.pubkey)?;

        Ok(buffer)
    }

    /// Installs the updater package downloaded by [`Update::download`]
    pub fn install(&self, bytes: impl AsRef<[u8]>) -> Result<()> {
        self.install_inner(bytes.as_ref())
    }

    /// Downloads and installs the updater package
    pub async fn download_and_install<C: FnMut(usize, Option<u64>), D: FnOnce()>(
        &self,
        on_chunk: C,
        on_download_finish: D,
    ) -> Result<()> {
        let bytes = self.download(on_chunk, on_download_finish).await?;
        self.install(bytes)
    }

    #[cfg(mobile)]
    fn install_inner(&self, _bytes: &[u8]) -> Result<()> {
        Ok(())
    }
}

#[cfg(windows)]
enum WindowsUpdaterType {
    Nsis {
        path: PathBuf,
        #[allow(unused)]
        temp: Option<tempfile::TempPath>,
    },
    Msi {
        path: PathBuf,
        #[allow(unused)]
        temp: Option<tempfile::TempPath>,
    },
}

#[cfg(windows)]
impl WindowsUpdaterType {
    fn nsis(path: PathBuf, temp: Option<tempfile::TempPath>) -> Self {
        Self::Nsis { path, temp }
    }

    fn msi(path: PathBuf, temp: Option<tempfile::TempPath>) -> Self {
        Self::Msi {
            path: path.wrap_in_quotes(),
            temp,
        }
    }
}

#[cfg(windows)]
impl Config {
    fn install_mode(&self) -> crate::config::WindowsUpdateInstallMode {
        self.windows
            .as_ref()
            .map(|w| w.install_mode.clone())
            .unwrap_or_default()
    }
}

/// Windows
#[cfg(windows)]
impl Update {
    /// ### Expected structure:
    /// ├── [AppName]_[version]_x64.msi              # Application MSI
    /// ├── [AppName]_[version]_x64-setup.exe        # NSIS installer
    /// ├── [AppName]_[version]_x64.msi.zip          # ZIP generated by tauri-bundler
    /// │   └──[AppName]_[version]_x64.msi           # Application MSI
    /// ├── [AppName]_[version]_x64-setup.exe.zip          # ZIP generated by tauri-bundler
    /// │   └──[AppName]_[version]_x64-setup.exe           # NSIS installer
    /// └── ...
    fn install_inner(&self, bytes: &[u8]) -> Result<()> {
        use std::iter::once;

        let updater_type = self.extract(bytes)?;
        let marker = b"OPENBITFUN_MAINTENANCE_V1";
        let transactional = bytes.windows(marker.len()).any(|window| window == marker);
        let event_name = format!(
            "Local\\OpenBitFunUpdate-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );

        let install_mode = self.config.install_mode();
        let current_args = &self.current_exe_args()[1..];
        let msi_args;
        let nsis_args;

        let installer_args: Vec<&OsStr> = match &updater_type {
            WindowsUpdaterType::Nsis { .. } => {
                nsis_args = current_args
                    .iter()
                    .map(escape_nsis_current_exe_arg)
                    .collect::<Vec<_>>();

                install_mode
                    .nsis_args()
                    .iter()
                    // The unelevated supervisor restarts the product after a
                    // transactional update, preserving the original token.
                    .filter(|arg| !transactional || !arg.eq_ignore_ascii_case("/R"))
                    .map(OsStr::new)
                    .chain(once(OsStr::new("/UPDATE")))
                    .chain(once(OsStr::new("/ARGS")))
                    .chain(nsis_args.iter().map(OsStr::new))
                    .chain(self.installer_args())
                    .collect()
            }
            WindowsUpdaterType::Msi { path, .. } => {
                let escaped_args = current_args
                    .iter()
                    .map(escape_msi_property_arg)
                    .collect::<Vec<_>>()
                    .join(" ");
                msi_args = OsString::from(format!("LAUNCHAPPARGS=\"{escaped_args}\""));

                [OsStr::new("/i"), path.as_os_str()]
                    .into_iter()
                    .chain(install_mode.msiexec_args().iter().map(OsStr::new))
                    .chain(once(OsStr::new("/promptrestart")))
                    .chain(self.installer_args())
                    .chain(once(OsStr::new("AUTOLAUNCHAPP=True")))
                    .chain(once(msi_args.as_os_str()))
                    .collect()
            }
        };

        let file = match &updater_type {
            WindowsUpdaterType::Nsis { path, .. } => path.clone(),
            WindowsUpdaterType::Msi { .. } => PathBuf::from(
                std::env::var_os("SYSTEMROOT").unwrap_or_else(|| "C:\\Windows".into()),
            )
            .join("System32/msiexec.exe"),
        };
        let mut parameters = installer_args
            .join(OsStr::new(" "))
            .to_string_lossy()
            .into_owned();
        if matches!(updater_type, WindowsUpdaterType::Nsis { .. }) {
            if transactional {
                parameters = format!(
                    "/OPENBITFUN_TARGET={} /WAITPID={} /READY_EVENT={} {}",
                    quote_windows_argument(self.extract_path.as_os_str()),
                    std::process::id(),
                    event_name,
                    parameters
                );
            } else {
                parameters.push_str(&format!(" /D={}", self.extract_path.display()));
            }
        }
        let current = std::env::current_exe()?;
        let parent = current.parent().ok_or(Error::BinaryNotFoundInArchive)?;
        let protected = match tempfile::NamedTempFile::new_in(parent) {
            Ok(_) => false,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => true,
            Err(error) => return Err(error.into()),
        };
        let needs_elevation = protected
            || self
                .installer_args
                .iter()
                .any(|arg| arg.to_string_lossy().eq_ignore_ascii_case("/ALLUSERS"));
        let quote = |value: &str| format!("'{}'", value.replace('\'', "''"));
        let restart_args = self.current_exe_args()[1..]
            .iter()
            .map(|arg| quote_windows_argument(arg))
            .collect::<Vec<_>>()
            .join(" ");
        let receipt = self
            .installation_receipt
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let (user_results, machine_results) = self
            .maintenance_result_roots
            .as_ref()
            .map(|(user, machine)| {
                (
                    user.to_string_lossy().into_owned(),
                    machine.to_string_lossy().into_owned(),
                )
            })
            .unwrap_or_default();
        let cleanup = if matches!(updater_type, WindowsUpdaterType::Nsis { .. }) {
            file.to_string_lossy().into_owned()
        } else {
            String::new()
        };
        // The supervisor stays outside the product's managed child tree, waits
        // for the *process handle* to signal, and reports installer failures even
        // though the main application has already exited.
        let script = format!(
            r#"$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$parentProcess=Get-Process -Id {pid}
$null=$parentProcess.Handle
$nativeResultFile=''
function Read-NativeFailure($code) {{
  if($nativeResultFile -and (Test-Path -LiteralPath $nativeResultFile)) {{
    try {{
      $native=Get-Content -LiteralPath $nativeResultFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if($native.exitCode -eq $code) {{ return $native.error }}
    }} catch {{}}
  }}
  return $null
}}
$result=@{{version={version};success=$false;exitCode=$null;error=$null}}
$announced=$false
try {{
  $parameters=@{{FilePath={file};ArgumentList={parameters};PassThru=$true}}
  if ({transactional}) {{
    $event=[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::ManualReset,{event})
    $parameters.ArgumentList='/SUPERVISOR_PID='+$PID+' /OWNER_SID='+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value+' '+$parameters.ArgumentList
    if({user_results} -ne '' -and {machine_results} -ne '') {{
      $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
      $root=if({elevate} -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){{{machine_results}}}else{{{user_results}}}
      $resultID=[Guid]::NewGuid().ToString('N')
      $nativeResultFile=Join-Path $root ($resultID+'.json')
      $parameters.ArgumentList='/RESULT_ID='+$resultID+' '+$parameters.ArgumentList
    }}
  }} else {{
    [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); $announced=$true
    $parentProcess.WaitForExit()
  }}
  if ({elevate}) {{ $parameters.Verb='RunAs' }}
  $installer=Start-Process @parameters
  if ({transactional}) {{
    $deadline=[DateTime]::UtcNow.AddSeconds(150)
    while (!$event.WaitOne(100)) {{
      if ($installer.HasExited) {{
        $result.exitCode=$installer.ExitCode
        $detail=Read-NativeFailure $installer.ExitCode
        if($detail) {{ throw $detail }}
        throw 'Maintenance exited before it was ready. Check permissions, disk space and installation ownership.'
      }}
      if ([DateTime]::UtcNow -gt $deadline) {{ $installer.Kill(); throw 'Maintenance readiness timed out; no files were changed.' }}
    }}
    [Console]::Out.WriteLine('READY'); [Console]::Out.Flush(); $announced=$true
  }}
  $installer.WaitForExit()
  $result.exitCode=$installer.ExitCode
  $detail=Read-NativeFailure $installer.ExitCode
  if ($installer.ExitCode -ne 0 -and $installer.ExitCode -ne 2) {{ if($detail) {{ throw $detail }}; throw "Installer exited with code $($installer.ExitCode)" }}
  $result.success=$true
  if ($installer.ExitCode -eq 2) {{ $result.error=if($detail){{$detail}}else{{'The update was installed, but some maintenance files require cleanup.'}} }}
}} catch {{
  $result.error=$_.Exception.Message
  if (!$announced) {{ [Console]::Out.WriteLine('ERROR: '+$result.error); [Console]::Out.Flush() }}
}}
if ({receipt} -ne '') {{
  try {{
    $json=$result | ConvertTo-Json -Compress
    $tmp={receipt}+'.tmp'
    [IO.File]::WriteAllText($tmp,$json,(New-Object Text.UTF8Encoding($false)))
    if ([IO.File]::Exists({receipt})) {{ [IO.File]::Replace($tmp,{receipt},[NullString]::Value) }} else {{ [IO.File]::Move($tmp,{receipt}) }}
  }} catch {{}}
}}
if ($result.error -and $announced) {{
  Add-Type -AssemblyName System.Windows.Forms
  $message=if($result.success){{'OpenBitFun update completed with a cleanup warning. '}}else{{'OpenBitFun update failed. The downloaded package is retained. '}}
  [Windows.Forms.MessageBox]::Show($message+$result.error,'OpenBitFun',[Windows.Forms.MessageBoxButtons]::OK,[Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
}}
if ({cleanup} -ne '') {{
  try {{ Remove-Item -LiteralPath {cleanup} -Force; [IO.Directory]::Delete([IO.Path]::GetDirectoryName({cleanup}),$false) }} catch {{}}
}}
if ($announced -and ({transactional} -or !$result.success)) {{
  if (Test-Path -LiteralPath {current}) {{
    $restart=@{{FilePath={current}}}
    if ({restart} -ne '') {{ $restart.ArgumentList={restart} }}
    Start-Process @restart
  }}
}}
"#,
            pid = std::process::id(),
            version = quote(&self.version),
            file = quote(&file.to_string_lossy()),
            parameters = quote(&parameters),
            elevate = if needs_elevation { "$true" } else { "$false" },
            receipt = quote(&receipt),
            current = quote(&current.to_string_lossy()),
            restart = quote(&restart_args),
            transactional = if transactional { "$true" } else { "$false" },
            event = quote(&event_name),
            user_results = quote(&user_results),
            machine_results = quote(&machine_results),
            cleanup = quote(&cleanup)
        );
        use std::io::{BufRead, BufReader};
        use std::os::windows::process::CommandExt;
        let encoded = base64::engine::general_purpose::STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let powershell =
            PathBuf::from(std::env::var_os("SYSTEMROOT").unwrap_or_else(|| "C:\\Windows".into()))
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut supervisor = std::process::Command::new(powershell)
            .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
            .creation_flags(windows_supervisor_creation_flags())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()?;
        let stdout = supervisor
            .stdout
            .take()
            .ok_or(Error::BinaryNotFoundInArchive)?;
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout)
                .read_line(&mut line)
                .map(|_| line.trim().to_owned());
            let _ = ready_tx.send(result);
        });
        let ready = ready_rx.recv_timeout(Duration::from_secs(180));
        if !matches!(&ready, Ok(Ok(line)) if line == "READY") {
            let _ = supervisor.kill();
            let detail = match ready {
                Ok(Ok(line)) if !line.is_empty() => line.trim_start_matches("ERROR: ").to_owned(),
                Ok(Err(error)) => error.to_string(),
                _ => "Maintenance readiness timed out or the supervisor exited".into(),
            };
            return Err(Error::Io(std::io::Error::other(format!(
                "Cannot start update maintenance: {detail}; the application was left running"
            ))));
        }
        if let Some(on_before_exit) = self.on_before_exit.as_ref() {
            on_before_exit();
        }
        std::process::exit(0);
    }

    fn installer_args(&self) -> Vec<&OsStr> {
        self.installer_args
            .iter()
            .map(OsStr::new)
            .collect::<Vec<_>>()
    }

    fn current_exe_args(&self) -> Vec<&OsStr> {
        self.current_exe_args
            .iter()
            .map(OsStr::new)
            .collect::<Vec<_>>()
    }

    fn extract(&self, bytes: &[u8]) -> Result<WindowsUpdaterType> {
        #[cfg(feature = "zip")]
        if infer::archive::is_zip(bytes) {
            return self.extract_zip(bytes);
        }

        self.extract_exe(bytes)
    }

    fn make_temp_dir(&self) -> Result<PathBuf> {
        Ok(tempfile::Builder::new()
            .prefix(&format!("{}-{}-updater-", self.app_name, self.version))
            .tempdir()?
            .keep())
    }

    #[cfg(feature = "zip")]
    fn extract_zip(&self, bytes: &[u8]) -> Result<WindowsUpdaterType> {
        let temp_dir = self.make_temp_dir()?;

        let archive = Cursor::new(bytes);
        let mut extractor = zip::ZipArchive::new(archive)?;
        extractor.extract(&temp_dir)?;

        let paths = std::fs::read_dir(&temp_dir)?;
        for path in paths {
            let path = path?.path();
            let ext = path.extension();
            if ext == Some(OsStr::new("exe")) {
                return Ok(WindowsUpdaterType::nsis(path, None));
            } else if ext == Some(OsStr::new("msi")) {
                return Ok(WindowsUpdaterType::msi(path, None));
            }
        }

        Err(crate::Error::BinaryNotFoundInArchive)
    }

    fn extract_exe(&self, bytes: &[u8]) -> Result<WindowsUpdaterType> {
        if infer::app::is_exe(bytes) {
            let (path, temp) = self.write_to_temp(bytes, ".exe")?;
            Ok(WindowsUpdaterType::nsis(path, temp))
        } else if infer::archive::is_msi(bytes) {
            let (path, temp) = self.write_to_temp(bytes, ".msi")?;
            Ok(WindowsUpdaterType::msi(path, temp))
        } else {
            Err(crate::Error::InvalidUpdaterFormat)
        }
    }

    fn write_to_temp(
        &self,
        bytes: &[u8],
        ext: &str,
    ) -> Result<(PathBuf, Option<tempfile::TempPath>)> {
        use std::io::Write;

        let temp_dir = self.make_temp_dir()?;
        let mut temp_file = tempfile::Builder::new()
            .prefix(&format!("{}-{}-installer", self.app_name, self.version))
            .suffix(ext)
            .rand_bytes(0)
            .tempfile_in(temp_dir)?;
        temp_file.write_all(bytes)?;

        let temp = temp_file.into_temp_path();
        Ok((temp.to_path_buf(), Some(temp)))
    }
}

/// Linux (AppImage, Deb, RPM)
#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
impl Update {
    /// ### Expected structure:
    /// ├── [AppName]_[version]_amd64.AppImage.tar.gz    # GZ generated by tauri-bundler
    /// │   └──[AppName]_[version]_amd64.AppImage        # Application AppImage
    /// ├── [AppName]_[version]_amd64.deb                # Debian package
    /// ├── [AppName]_[version]_amd64.rpm                # RPM package
    /// └── ...
    ///
    fn install_inner(&self, bytes: &[u8]) -> Result<()> {
        match installer_for_bundle_type(bundle_type()) {
            Some(Installer::Deb) => self.install_deb(bytes),
            Some(Installer::Rpm) => self.install_rpm(bytes),
            _ => self.install_appimage(bytes),
        }
    }

    fn install_appimage(&self, bytes: &[u8]) -> Result<()> {
        use std::io::{Read, Write};
        let parent = self
            .extract_path
            .parent()
            .ok_or(Error::FailedToDetermineExtractPath)?;
        let filename = self
            .extract_path
            .file_name()
            .ok_or(Error::FailedToDetermineExtractPath)?;
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(parent.join(format!(".{}.update.lock", filename.to_string_lossy())))?;
        lock.try_lock()
            .map_err(|_| std::io::Error::other("Another application update is running"))?;
        let stage = tempfile::Builder::new()
            .prefix(".openbitfun-appimage-update-")
            .tempdir_in(parent)?;
        let new = stage.path().join("new.AppImage");
        let mut output = std::fs::File::create(&new)?;
        if infer::archive::is_gz(bytes) {
            #[cfg(feature = "zip")]
            {
                let mut archive =
                    tar::Archive::new(flate2::read::GzDecoder::new(Cursor::new(bytes)));
                let mut found = false;
                for entry in archive.entries()? {
                    let mut entry = entry?;
                    if entry.path()?.extension() == Some(OsStr::new("AppImage")) {
                        if found || !entry.header().entry_type().is_file() {
                            return Err(Error::InvalidUpdaterFormat);
                        }
                        std::io::copy(&mut entry, &mut output)?;
                        found = true;
                    }
                }
                if !found {
                    return Err(Error::BinaryNotFoundInArchive);
                }
            }
            #[cfg(not(feature = "zip"))]
            return Err(Error::InvalidUpdaterFormat);
        } else {
            output.write_all(bytes)?;
        }
        output.sync_all()?;
        drop(output);
        let mut magic = [0_u8; 11];
        std::fs::File::open(&new)?.read_exact(&mut magic)?;
        if !magic.starts_with(b"\x7fELF") || !matches!(&magic[8..], b"AI\x01" | b"AI\x02") {
            return Err(Error::InvalidUpdaterFormat);
        }
        std::fs::set_permissions(&new, self.extract_path.metadata()?.permissions())?;
        // rename replaces a regular file atomically on Unix. The old application
        // stays runnable throughout extraction, validation and failed publication.
        std::fs::rename(&new, &self.extract_path)?;
        if let Err(error) = stage.close() {
            log::warn!("Application updated; staging cleanup failed: {error}");
        }
        Ok(())
    }

    fn install_deb(&self, bytes: &[u8]) -> Result<()> {
        // First verify the bytes are actually a .deb package
        if !infer::archive::is_deb(bytes) {
            log::warn!("update is not a valid deb package");
            return Err(Error::InvalidUpdaterFormat);
        }

        self.try_tmp_locations(bytes, "dpkg", "-i", "deb")
    }

    fn install_rpm(&self, bytes: &[u8]) -> Result<()> {
        // First verify the bytes are actually a .rpm package
        if !infer::archive::is_rpm(bytes) {
            return Err(Error::InvalidUpdaterFormat);
        }
        self.try_tmp_locations(bytes, "rpm", "-U", "rpm")
    }

    fn try_tmp_locations(
        &self,
        bytes: &[u8],
        install_cmd: &str,
        install_arg: &str,
        package_extension: &str,
    ) -> Result<()> {
        // Try different temp directories
        let tmp_dir_locations = vec![
            Box::new(|| Some(std::env::temp_dir())) as Box<dyn FnOnce() -> Option<PathBuf>>,
            Box::new(dirs::cache_dir),
            Box::new(|| Some(self.extract_path.parent().unwrap().to_path_buf())),
        ];

        // Try writing to multiple temp locations until one succeeds
        for tmp_dir_location in tmp_dir_locations {
            if let Some(path) = tmp_dir_location() {
                let prefix = format!("tauri_{package_extension}_update");
                if let Ok(tmp_dir) = tempfile::Builder::new().prefix(&prefix).tempdir_in(path) {
                    let pkg_path = tmp_dir.path().join(format!("package.{package_extension}"));

                    // Try writing the .deb / .rpm file
                    if std::fs::write(&pkg_path, bytes).is_ok() {
                        // If write succeeds, proceed with installation
                        return self.try_install_with_privileges(
                            &pkg_path,
                            install_cmd,
                            install_arg,
                        );
                    }
                    // If write fails, continue to next temp location
                }
            }
        }

        // If we get here, all temp locations failed
        Err(Error::TempDirNotFound)
    }

    fn try_install_with_privileges(
        &self,
        pkg_path: &Path,
        install_cmd: &str,
        install_arg: &str,
    ) -> Result<()> {
        // 1. First try using pkexec (graphical sudo prompt)
        if let Ok(status) = std::process::Command::new("pkexec")
            .arg(install_cmd)
            .arg(install_arg)
            .arg(pkg_path)
            .status()
        {
            if status.success() {
                log::debug!("installed {pkg_path:?} with pkexec");
                return Ok(());
            }
            return Err(Error::PackageInstallFailed);
        }

        // A GUI must never fall back to an invisible terminal password prompt.
        let password = self.get_password_graphically()?;
        if self.install_with_sudo(pkg_path, &password, install_cmd, install_arg)? {
            Ok(())
        } else {
            Err(Error::PackageInstallFailed)
        }
    }

    fn get_password_graphically(&self) -> Result<String> {
        // Try zenity first
        let zenity_result = std::process::Command::new("zenity")
            .args([
                "--password",
                "--title=Authentication Required",
                "--text=Enter your password to install the update:",
            ])
            .output();

        if let Ok(output) = zenity_result {
            if output.status.success() {
                return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
            }
            return Err(Error::AuthenticationFailed);
        }

        // Fall back to kdialog if zenity fails or isn't available
        let kdialog_result = std::process::Command::new("kdialog")
            .args(["--password", "Enter your password to install the update:"])
            .output();

        if let Ok(output) = kdialog_result {
            if output.status.success() {
                return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
            }
        }

        Err(Error::AuthenticationFailed)
    }

    fn install_with_sudo(
        &self,
        pkg_path: &Path,
        password: &str,
        install_cmd: &str,
        install_arg: &str,
    ) -> Result<bool> {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let mut child = Command::new("sudo")
            .arg("-S") // read password from stdin
            .args(["-p", "", "-k"])
            .arg(install_cmd)
            .arg(install_arg)
            .arg(pkg_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        if let Some(mut stdin) = child.stdin.take() {
            // Write password to stdin
            writeln!(stdin, "{password}")?;
        }

        // Drain both pipes while waiting; package-manager output can exceed the
        // pipe capacity and otherwise deadlock an update indefinitely.
        let output = child.wait_with_output()?;
        Ok(output.status.success())
    }
}

/// MacOS
#[cfg(target_os = "macos")]
impl Update {
    /// ### Expected structure:
    /// ├── [AppName]_[version]_x64.app.tar.gz       # GZ generated by tauri-bundler
    /// │   └──[AppName].app                         # Main application
    /// │      └── Contents                          # Application contents...
    /// │          └── ...
    /// └── ...
    fn install_inner(&self, bytes: &[u8]) -> Result<()> {
        use flate2::read::GzDecoder;
        let parent = self
            .extract_path
            .parent()
            .ok_or(Error::FailedToDetermineExtractPath)?;
        let (stage, needs_authorization) = match tempfile::Builder::new()
            .prefix(".tauri-update-")
            .tempdir_in(parent)
        {
            Ok(stage) => (stage, false),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                (tempfile::tempdir()?, true)
            }
            Err(error) => return Err(error.into()),
        };
        let unpack = stage.path().join("unpack");
        std::fs::create_dir(&unpack)?;
        // Archive::unpack validates traversal and symlink parents; do not strip
        // paths and feed unchecked entries to Entry::unpack.
        tar::Archive::new(GzDecoder::new(Cursor::new(bytes))).unpack(&unpack)?;
        let apps = std::fs::read_dir(&unpack)?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                path.extension().is_some_and(|ext| ext == "app")
                    && std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
            })
            .collect::<Vec<_>>();
        if apps.len() != 1 {
            return Err(Error::InvalidUpdaterFormat);
        }
        let new_app = &apps[0];
        let executable = std::env::current_exe()?;
        if !new_app
            .join("Contents/MacOS")
            .join(
                executable
                    .file_name()
                    .ok_or(Error::BinaryNotFoundInArchive)?,
            )
            .is_file()
        {
            return Err(Error::BinaryNotFoundInArchive);
        }
        if needs_authorization {
            // Stage and back up on the target volume. Authorization failure or
            // a failed ditto leaves the old app untouched. A failed final rename
            // restores it, and never deletes the sole recovery copy.
            let q = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"));
            let shell = format!(
                r#"set -eu
stage=$(/usr/bin/mktemp -d {parent}/.tauri-update.XXXXXXXX)
/usr/bin/ditto {new} "$stage/new.app"
/bin/mv {old} "$stage/previous.app"
if /bin/mv "$stage/new.app" {old}; then
  /bin/rm -rf "$stage/previous.app"
  /bin/rmdir "$stage"
else
  /bin/mv "$stage/previous.app" {old} || {{ echo "Recovery backup retained at $stage" >&2; exit 2; }}
  exit 1
fi"#,
                parent = q(parent),
                new = q(new_app),
                old = q(&self.extract_path)
            );
            let apple = format!(
                "do shell script \"{}\" with administrator privileges",
                shell
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('\n', "\\n")
            );
            let (tx, rx) = std::sync::mpsc::channel();
            (self.run_on_main_thread)(Box::new(move || {
                let mut script =
                    osakit::Script::new_from_source(osakit::Language::AppleScript, &apple);
                let result = script
                    .compile()
                    .map_err(|e| format!("{e:?}"))
                    .and_then(|_| script.execute().map(|_| ()).map_err(|e| format!("{e:?}")));
                let _ = tx.send(result);
            }))
            .map_err(|e| Error::Io(std::io::Error::other(e.to_string())))?;
            rx.recv()
                .map_err(|e| Error::Io(std::io::Error::other(e.to_string())))?
                .map_err(|e| {
                    Error::Io(std::io::Error::other(format!(
                        "Authorized app replacement failed: {e}"
                    )))
                })?;
        } else {
            let backup = stage.path().join("previous.app");
            std::fs::rename(&self.extract_path, &backup)?;
            if let Err(error) = std::fs::rename(new_app, &self.extract_path) {
                if let Err(recovery) = std::fs::rename(&backup, &self.extract_path) {
                    let retained = stage.keep();
                    return Err(Error::Io(std::io::Error::other(format!("App replacement failed: {error}; recovery failed: {recovery}; backup retained at {}", retained.display()))));
                }
                return Err(error.into());
            }
        }
        Ok(())
    }
}

/// Gets the base target string used by the updater. If bundle type is available it
/// will be added to this string when selecting the download URL and signature.
/// `tauri::utils::platform::bundle_type` method is used to obtain current bundle type.
pub fn target() -> Option<String> {
    if let (Some(target), Some(arch)) = (updater_os(), updater_arch()) {
        Some(format!("{target}-{arch}"))
    } else {
        None
    }
}

fn updater_os() -> Option<&'static str> {
    if cfg!(target_os = "linux") {
        Some("linux")
    } else if cfg!(target_os = "macos") {
        // TODO shouldn't this be macos instead?
        Some("darwin")
    } else if cfg!(target_os = "windows") {
        Some("windows")
    } else {
        None
    }
}

fn updater_arch() -> Option<&'static str> {
    if cfg!(target_arch = "x86") {
        Some("i686")
    } else if cfg!(target_arch = "x86_64") {
        Some("x86_64")
    } else if cfg!(target_arch = "arm") {
        Some("armv7")
    } else if cfg!(target_arch = "aarch64") {
        Some("aarch64")
    } else if cfg!(target_arch = "riscv64") {
        Some("riscv64")
    } else {
        None
    }
}

pub fn extract_path_from_executable(executable_path: &Path) -> Result<PathBuf> {
    // Return the path of the current executable by default
    // Example C:\Program Files\My App\
    let extract_path = executable_path
        .parent()
        .map(PathBuf::from)
        .ok_or(Error::FailedToDetermineExtractPath)?;

    // MacOS example binary is in /Applications/TestApp.app/Contents/MacOS/myApp
    // We need to get /Applications/<app>.app
    // TODO(lemarier): Need a better way here
    // Maybe we could search for <*.app> to get the right path
    #[cfg(target_os = "macos")]
    if extract_path
        .display()
        .to_string()
        .contains("Contents/MacOS")
    {
        return extract_path
            .parent()
            .map(PathBuf::from)
            .ok_or(Error::FailedToDetermineExtractPath)?
            .parent()
            .map(PathBuf::from)
            .ok_or(Error::FailedToDetermineExtractPath);
    }

    Ok(extract_path)
}

impl<'de> Deserialize<'de> for RemoteRelease {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct InnerRemoteRelease {
            #[serde(alias = "name", deserialize_with = "parse_version")]
            version: Version,
            notes: Option<String>,
            pub_date: Option<String>,
            platforms: Option<HashMap<String, ReleaseManifestPlatform>>,
            // dynamic platform response
            url: Option<Url>,
            signature: Option<String>,
        }

        let release = InnerRemoteRelease::deserialize(deserializer)?;

        let pub_date = if let Some(date) = release.pub_date {
            Some(
                OffsetDateTime::parse(&date, &time::format_description::well_known::Rfc3339)
                    .map_err(|e| DeError::custom(format!("invalid value for `pub_date`: {e}")))?,
            )
        } else {
            None
        };

        Ok(RemoteRelease {
            version: release.version,
            notes: release.notes,
            pub_date,
            data: if let Some(platforms) = release.platforms {
                RemoteReleaseInner::Static { platforms }
            } else {
                RemoteReleaseInner::Dynamic(ReleaseManifestPlatform {
                    url: release.url.ok_or_else(|| {
                        DeError::custom("the `url` field was not set on the updater response")
                    })?,
                    signature: release.signature.ok_or_else(|| {
                        DeError::custom("the `signature` field was not set on the updater response")
                    })?,
                })
            },
        })
    }
}

fn installer_for_bundle_type(bundle: Option<BundleType>) -> Option<Installer> {
    match bundle? {
        BundleType::Deb => Some(Installer::Deb),
        BundleType::Rpm => Some(Installer::Rpm),
        BundleType::AppImage => Some(Installer::AppImage),
        BundleType::Msi => Some(Installer::Msi),
        BundleType::Nsis => Some(Installer::Nsis),
        BundleType::App => Some(Installer::App), // App is also returned for Dmg type
        _ => None,
    }
}

fn parse_version<'de, D>(deserializer: D) -> std::result::Result<Version, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let str = String::deserialize(deserializer)?;

    Version::from_str(str.trim_start_matches('v')).map_err(serde::de::Error::custom)
}

// Validate signature
fn verify_signature(data: &[u8], release_signature: &str, pub_key: &str) -> Result<bool> {
    // we need to convert the pub key
    let pub_key_decoded = base64_to_string(pub_key)?;
    let public_key = PublicKey::decode(&pub_key_decoded)?;
    let signature_base64_decoded = base64_to_string(release_signature)?;
    let signature = Signature::decode(&signature_base64_decoded)?;

    // Validate signature or bail out
    public_key.verify(data, &signature, true)?;
    Ok(true)
}

fn base64_to_string(base64_string: &str) -> Result<String> {
    let decoded_string = &base64::engine::general_purpose::STANDARD.decode(base64_string)?;
    let result = std::str::from_utf8(decoded_string)
        .map_err(|_| Error::SignatureUtf8(base64_string.into()))?
        .to_string();
    Ok(result)
}

#[cfg(windows)]
fn windows_supervisor_creation_flags() -> u32 {
    // A host-lifetime Job must not kill maintenance when the old app exits.
    // If the launching Job forbids breakaway, spawning fails before shutdown.
    0x08000000 | 0x00000200 | 0x01000000
}

#[cfg(windows)]
trait PathExt {
    fn wrap_in_quotes(&self) -> Self;
}

#[cfg(windows)]
fn quote_windows_argument(argument: &OsStr) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for c in argument.to_string_lossy().chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            '\\',
            slashes * if c == '"' { 2 } else { 1 },
        ));
        slashes = 0;
        if c == '"' {
            result.push('\\');
        }
        result.push(c);
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}

#[cfg(windows)]
impl PathExt for PathBuf {
    fn wrap_in_quotes(&self) -> Self {
        let mut msi_path = OsString::from("\"");
        msi_path.push(self.as_os_str());
        msi_path.push("\"");
        PathBuf::from(msi_path)
    }
}

// adapted from https://github.com/rust-lang/rust/blob/1c047506f94cd2d05228eb992b0a6bbed1942349/library/std/src/sys/args/windows.rs#L174
#[cfg(windows)]
fn escape_nsis_current_exe_arg(arg: &&OsStr) -> String {
    let arg = arg.to_string_lossy();
    let mut cmd: Vec<char> = Vec::new();

    // compared to std we additionally escape `/` so that nsis won't interpret them as a beginning of an nsis argument.
    let quote = arg.chars().any(|c| c == ' ' || c == '\t' || c == '/') || arg.is_empty();
    let escape = true;
    if quote {
        cmd.push('"');
    }
    let mut backslashes: usize = 0;
    for x in arg.chars() {
        if escape {
            if x == '\\' {
                backslashes += 1;
            } else {
                if x == '"' {
                    // Add n+1 backslashes to total 2n+1 before internal '"'.
                    cmd.extend((0..=backslashes).map(|_| '\\'));
                }
                backslashes = 0;
            }
        }
        cmd.push(x);
    }
    if quote {
        // Add n backslashes to total 2n before ending '"'.
        cmd.extend((0..backslashes).map(|_| '\\'));
        cmd.push('"');
    }
    cmd.into_iter().collect()
}

#[cfg(windows)]
fn escape_msi_property_arg(arg: impl AsRef<OsStr>) -> String {
    let mut arg = arg.as_ref().to_string_lossy().to_string();

    // Otherwise this argument will get lost in ShellExecute
    if arg.is_empty() {
        return "\"\"\"\"".to_string();
    } else if !arg.contains(' ') && !arg.contains('"') {
        return arg;
    }

    if arg.contains('"') {
        arg = arg.replace('"', r#""""""#);
    }

    if arg.starts_with('-') {
        if let Some((a1, a2)) = arg.split_once('=') {
            format!("{a1}=\"\"{a2}\"\"")
        } else {
            format!("\"\"{arg}\"\"")
        }
    } else {
        format!("\"\"{arg}\"\"")
    }
}

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(windows)]
    fn windows_supervisor_survives_the_host_lifetime_job() {
        use std::{
            os::windows::process::CommandExt,
            process::{Command, Stdio},
        };
        if let Some(receipt) = std::env::var_os("OPENBITFUN_UPDATER_JOB_FIXTURE") {
            use std::ffi::c_void;
            #[repr(C)]
            struct BasicLimits {
                process_time: i64,
                job_time: i64,
                flags: u32,
                min_working_set: usize,
                max_working_set: usize,
                active_processes: u32,
                affinity: usize,
                priority: u32,
                scheduling: u32,
            }
            #[repr(C)]
            struct ExtendedLimits {
                basic: BasicLimits,
                io: [u64; 6],
                process_memory: usize,
                job_memory: usize,
                peak_process_memory: usize,
                peak_job_memory: usize,
            }
            #[link(name = "kernel32")]
            extern "system" {
                fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
                fn SetInformationJobObject(
                    job: *mut c_void,
                    class: i32,
                    info: *const c_void,
                    size: u32,
                ) -> i32;
                fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
            }
            // The disposable child owns this Job. Do not assign the test runner
            // or a real OpenBitFun instance to a kill-on-close Job.
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            assert!(!job.is_null());
            let mut info: ExtendedLimits = unsafe { std::mem::zeroed() };
            info.basic.flags = 0x2000 | 0x0800; // KILL_ON_JOB_CLOSE | BREAKAWAY_OK
            assert_ne!(
                unsafe {
                    SetInformationJobObject(
                        job,
                        9,
                        &info as *const _ as *const _,
                        std::mem::size_of_val(&info) as u32,
                    )
                },
                0
            );
            assert_ne!(
                unsafe { AssignProcessToJobObject(job, -1_isize as *mut c_void) },
                0
            );
            let powershell = std::path::PathBuf::from(std::env::var_os("SYSTEMROOT").unwrap())
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
            Command::new(powershell).args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Milliseconds 800; [IO.File]::WriteAllText($env:OPENBITFUN_UPDATER_JOB_FIXTURE, 'survived')"])
                .env("OPENBITFUN_UPDATER_JOB_FIXTURE", receipt).creation_flags(super::windows_supervisor_creation_flags())
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
            // OS teardown closes the only Job handle, exercising the same
            // lifetime boundary as the old application exiting during update.
            std::process::exit(0);
        }
        let temp = tempfile::tempdir().unwrap();
        let receipt = temp.path().join("supervisor.txt");
        let result = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "updater::tests::windows_supervisor_survives_the_host_lifetime_job",
            ])
            .env("OPENBITFUN_UPDATER_JOB_FIXTURE", &receipt)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !receipt.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(std::fs::read_to_string(receipt).unwrap(), "survived");
    }
    #[test]
    #[cfg(windows)]
    fn native_windows_arguments_roundtrip_through_the_os_parser() {
        #[link(name = "shell32")]
        extern "system" {
            fn CommandLineToArgvW(command: *const u16, count: *mut i32) -> *mut *mut u16;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
        }
        let values = [
            r"/OPENBITFUN_TARGET=C:\Program Files\测试目录",
            "space here",
            "quote\"inside",
            "trailing\\",
            "",
        ];
        let command = format!(
            "program.exe {}",
            values
                .iter()
                .map(|value| super::quote_windows_argument(std::ffi::OsStr::new(value)))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let wide = command
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let mut count = 0;
        let arguments = unsafe { CommandLineToArgvW(wide.as_ptr(), &mut count) };
        assert!(!arguments.is_null());
        let decoded = unsafe { std::slice::from_raw_parts(arguments, count as usize) }
            .iter()
            .skip(1)
            .map(|pointer| {
                let mut length = 0;
                unsafe {
                    while *(*pointer).add(length) != 0 {
                        length += 1;
                    }
                    String::from_utf16_lossy(std::slice::from_raw_parts(*pointer, length))
                }
            })
            .collect::<Vec<_>>();
        unsafe {
            LocalFree(arguments.cast());
        }
        assert_eq!(decoded, values);
    }

    #[test]
    #[cfg(windows)]
    fn it_wraps_correctly() {
        use super::PathExt;
        use std::path::PathBuf;

        assert_eq!(
            PathBuf::from("C:\\Users\\Some User\\AppData\\tauri-example.exe").wrap_in_quotes(),
            PathBuf::from("\"C:\\Users\\Some User\\AppData\\tauri-example.exe\"")
        )
    }

    #[test]
    #[cfg(windows)]
    fn it_escapes_correctly_for_msi() {
        use crate::updater::escape_msi_property_arg;

        // Explanation for quotes:
        // The output of escape_msi_property_args() will be used in `LAUNCHAPPARGS=\"{HERE}\"`. This is the first quote level.
        // To escape a quotation mark we use a second quotation mark, so "" is interpreted as " later.
        // This means that the escaped strings can't ever have a single quotation mark!
        // Now there are 3 major things to look out for to not break the msiexec call:
        //   1) Wrap spaces in quotation marks, otherwise it will be interpreted as the end of the msiexec argument.
        //   2) Escape escaping quotation marks, otherwise they will either end the msiexec argument or be ignored.
        //   3) Escape emtpy args in quotation marks, otherwise the argument will get lost.
        let cases = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "some space",                     // This simulates `./my-app "some string"`.
            "--arg value", // -> This simulates `./my-app "--arg value"`. Same as above but it triggers the startsWith(`-`) logic.
            "--arg=unwrapped space", // `./my-app --arg="unwrapped space"`
            "--arg=\"wrapped\"", // `./my-app --args=""wrapped""`
            "--arg=\"wrapped space\"", // `./my-app --args=""wrapped space""`
            "--arg=midword\"wrapped space\"", // `./my-app --args=midword""wrapped""`
            "",            // `./my-app '""'`
        ];
        let cases_escaped = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "\"\"some space\"\"",
            "\"\"--arg value\"\"",
            "--arg=\"\"unwrapped space\"\"",
            r#"--arg=""""""wrapped"""""""#,
            r#"--arg=""""""wrapped space"""""""#,
            r#"--arg=""midword""""wrapped space"""""""#,
            "\"\"\"\"",
        ];

        // Just to be sure we didn't mess that up
        assert_eq!(cases.len(), cases_escaped.len());

        for (orig, escaped) in cases.iter().zip(cases_escaped) {
            assert_eq!(escape_msi_property_arg(orig), escaped);
        }
    }

    #[test]
    #[cfg(windows)]
    fn it_escapes_correctly_for_nsis() {
        use crate::updater::escape_nsis_current_exe_arg;
        use std::ffi::OsStr;

        let cases = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "some space",                     // This simulates `./my-app "some string"`.
            "--arg value", // -> This simulates `./my-app "--arg value"`. Same as above but it triggers the startsWith(`-`) logic.
            "--arg=unwrapped space", // `./my-app --arg="unwrapped space"`
            "--arg=\"wrapped\"", // `./my-app --args=""wrapped""`
            "--arg=\"wrapped space\"", // `./my-app --args=""wrapped space""`
            "--arg=midword\"wrapped space\"", // `./my-app --args=midword""wrapped""`
            "",            // `./my-app '""'`
        ];
        // Note: These may not be the results we actually want (monitor this!).
        // We only make sure the implementation doesn't unintentionally change.
        let cases_escaped = [
            "something",
            "--flag",
            "--empty=",
            "--arg=value",
            "\"some space\"",
            "\"--arg value\"",
            "\"--arg=unwrapped space\"",
            "--arg=\\\"wrapped\\\"",
            "\"--arg=\\\"wrapped space\\\"\"",
            "\"--arg=midword\\\"wrapped space\\\"\"",
            "\"\"",
        ];

        // Just to be sure we didn't mess that up
        assert_eq!(cases.len(), cases_escaped.len());

        for (orig, escaped) in cases.iter().zip(cases_escaped) {
            assert_eq!(escape_nsis_current_exe_arg(&OsStr::new(orig)), escaped);
        }
    }
}
