use tauri::{Runtime, Webview};

use super::types::PrintOptions;
use crate::server::response::WebDriverErrorResponse;

pub async fn take_screenshot<R: Runtime>(
    webview: Webview<R>,
    timeout_ms: u64,
) -> Result<String, WebDriverErrorResponse> {
    imp::take_screenshot(webview, timeout_ms).await
}

pub async fn print_page<R: Runtime>(
    webview: Webview<R>,
    timeout_ms: u64,
    options: &PrintOptions,
) -> Result<String, WebDriverErrorResponse> {
    imp::print_page(webview, timeout_ms, options).await
}

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use base64::Engine as _;
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
    };
    use objc2_foundation::{NSData, NSDictionary, NSError};
    use objc2_web_kit::{WKPDFConfiguration, WKSnapshotConfiguration, WKWebView};
    use tokio::sync::oneshot;

    pub(super) async fn take_screenshot<R: Runtime>(
        webview: Webview<R>,
        timeout_ms: u64,
    ) -> Result<String, WebDriverErrorResponse> {
        let (tx, rx) = oneshot::channel();
        let runtime = tokio::runtime::Handle::current();

        // SAFETY: Tauri runs this callback on the main thread with a live
        // platform webview, so the pointer is valid for the call and
        // `MainThreadMarker::new_unchecked` states a fact the runtime upholds.
        // On macOS that webview is always WKWebView-backed, making the cast sound.
        let result = webview.with_webview(move |platform_webview| unsafe {
            let wk_webview: &WKWebView = &*platform_webview.inner().cast();
            let mtm = MainThreadMarker::new_unchecked();
            let config = WKSnapshotConfiguration::new(mtm);

            let tx = Arc::new(std::sync::Mutex::new(Some(tx)));
            let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let Some(sender) = tx.lock().ok().and_then(|mut guard| guard.take()) else {
                    return;
                };
                if sender.is_closed() {
                    return;
                }

                let tiff = if !error.is_null() {
                    let error_ref = &*error;
                    Err(error_ref.localizedDescription().to_string())
                } else if image.is_null() {
                    Err("No image returned".to_string())
                } else {
                    // NSImage belongs to this callback's main thread. Only owned
                    // bytes cross threads; bitmap decoding and PNG compression
                    // must not block native window/presentation updates.
                    (&*image)
                        .TIFFRepresentation()
                        .map(|data| data.to_vec())
                        .ok_or_else(|| "Failed to get TIFF representation".to_string())
                };

                match tiff {
                    Ok(tiff) => {
                        let _encoding = spawn_png_response(&runtime, tiff, sender);
                    }
                    Err(error) => {
                        let _ = sender.send(Err(error));
                    }
                }
            });

            wk_webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block);
        });

        if let Err(error) = result {
            return Err(WebDriverErrorResponse::unknown_error(format!(
                "Failed to capture screenshot: {error}"
            )));
        }

        await_base64_response(rx, timeout_ms, "Screenshot").await
    }

    pub(super) async fn print_page<R: Runtime>(
        webview: Webview<R>,
        timeout_ms: u64,
        options: &PrintOptions,
    ) -> Result<String, WebDriverErrorResponse> {
        let page_width = options.page_width.unwrap_or(21.0);
        let page_height = options.page_height.unwrap_or(29.7);
        let margin_top = options.margin_top.unwrap_or(1.0);
        let margin_bottom = options.margin_bottom.unwrap_or(1.0);
        let margin_left = options.margin_left.unwrap_or(1.0);
        let margin_right = options.margin_right.unwrap_or(1.0);
        let orientation = options.orientation.as_deref().unwrap_or("portrait");
        let css = format!(
            r#"(function() {{
                let style = document.getElementById('__openbitfun_webdriver_print_style');
                if (!style) {{
                    style = document.createElement('style');
                    style.id = '__openbitfun_webdriver_print_style';
                    document.head.appendChild(style);
                }}
                style.textContent = `
                    @page {{
                        size: {page_width}cm {page_height}cm {orientation};
                        margin: {margin_top}cm {margin_right}cm {margin_bottom}cm {margin_left}cm;
                    }}
                    @media print {{
                        body {{
                            -webkit-print-color-adjust: exact;
                            print-color-adjust: exact;
                        }}
                    }}
                `;
            }})();"#
        );
        webview.eval(&css).map_err(|error| {
            WebDriverErrorResponse::unknown_error(format!("Failed to inject print CSS: {error}"))
        })?;

        let (tx, rx) = oneshot::channel();
        // SAFETY: Tauri runs this callback on the main thread with a live
        // platform webview, so the pointer is valid for the call and
        // `MainThreadMarker::new_unchecked` states a fact the runtime upholds.
        // On macOS that webview is always WKWebView-backed, making the cast sound.
        let result = webview.with_webview(move |platform_webview| unsafe {
            let wk_webview: &WKWebView = &*platform_webview.inner().cast();
            let mtm = MainThreadMarker::new_unchecked();
            let config = WKPDFConfiguration::new(mtm);

            let tx = Arc::new(std::sync::Mutex::new(Some(tx)));
            let block = RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                let response = if !error.is_null() {
                    let error_ref = &*error;
                    Err(error_ref.localizedDescription().to_string())
                } else if data.is_null() {
                    Err("No PDF data returned".to_string())
                } else {
                    Ok(BASE64_STANDARD.encode((&*data).to_vec()))
                };

                if let Ok(mut guard) = tx.lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(response);
                    }
                }
            });

            wk_webview.createPDFWithConfiguration_completionHandler(Some(&config), &block);
        });

        if let Err(error) = result {
            return Err(WebDriverErrorResponse::unknown_error(format!(
                "Failed to print page: {error}"
            )));
        }

        let response = await_base64_response(rx, timeout_ms, "Print").await;
        let _ = webview.eval(
            "(() => { document.getElementById('__openbitfun_webdriver_print_style')?.remove(); })();",
        );
        response
    }

    async fn await_base64_response(
        rx: oneshot::Receiver<Result<String, String>>,
        timeout_ms: u64,
        label: &str,
    ) -> Result<String, WebDriverErrorResponse> {
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(Ok(base64))) if !base64.is_empty() => Ok(base64),
            Ok(Ok(Ok(_))) => Err(WebDriverErrorResponse::unknown_error(format!(
                "{label} returned empty data"
            ))),
            Ok(Ok(Err(error))) => Err(WebDriverErrorResponse::unknown_error(error)),
            Ok(Err(_)) => Err(WebDriverErrorResponse::unknown_error(format!(
                "{label} channel closed unexpectedly"
            ))),
            Err(_) => Err(WebDriverErrorResponse::timeout(format!(
                "{label} timed out after {timeout_ms}ms"
            ))),
        }
    }

    fn spawn_png_response(
        runtime: &tokio::runtime::Handle,
        tiff: Vec<u8>,
        sender: oneshot::Sender<Result<String, String>>,
    ) -> tokio::task::JoinHandle<()> {
        runtime.spawn_blocking(move || {
            if sender.is_closed() {
                return;
            }
            // Blocking-pool threads do not have an AppKit event-loop pool.
            let response = objc2::rc::autoreleasepool(|_| tiff_to_png_base64(tiff));
            let _ = sender.send(response);
        })
    }

    fn tiff_to_png_base64(tiff: Vec<u8>) -> Result<String, String> {
        let tiff_data = NSData::with_bytes(&tiff);
        drop(tiff);

        let bitmap_rep = NSBitmapImageRep::imageRepWithData(&tiff_data)
            .ok_or("Failed to create bitmap image rep")?;

        let empty_dict: objc2::rc::Retained<NSDictionary<NSBitmapImageRepPropertyKey, AnyObject>> =
            NSDictionary::new();
        // SAFETY: `bitmap_rep` and `empty_dict` are live `Retained` handles for
        // the whole call; the method only reads them and returns a new object.
        let png_data = unsafe {
            bitmap_rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &empty_dict)
        }
        .ok_or("Failed to convert image to PNG")?;

        Ok(BASE64_STANDARD.encode(png_data.to_vec()))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn screenshot_fixture() -> (Vec<u8>, image::RgbaImage) {
            let pixels = image::RgbaImage::from_fn(19, 13, |x, y| {
                let alpha = [0, 85, 170, 255][(x % 4) as usize];
                if alpha == 0 {
                    image::Rgba([0, 0, 0, 0])
                } else {
                    image::Rgba([(x * 13) as u8, (y * 19) as u8, ((x + y) * 7) as u8, alpha])
                }
            });
            let mut png = std::io::Cursor::new(Vec::new());
            pixels.write_to(&mut png, image::ImageFormat::Png).unwrap();
            let tiff = objc2::rc::autoreleasepool(|_| {
                let data = NSData::with_bytes(png.get_ref());
                let bitmap = NSBitmapImageRep::imageRepWithData(&data).unwrap();
                bitmap.TIFFRepresentation().unwrap().to_vec()
            });
            (tiff, pixels)
        }

        #[test]
        fn background_png_preserves_dimensions_pixels_and_transparency() {
            let (tiff, expected) = screenshot_fixture();
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .unwrap();
            runtime.block_on(async {
                let (tx, rx) = oneshot::channel();
                let encoding = spawn_png_response(runtime.handle(), tiff, tx);
                let encoded = await_base64_response(rx, 5000, "Screenshot").await.unwrap();
                encoding.await.unwrap();
                let png = BASE64_STANDARD.decode(encoded).unwrap();
                assert_eq!(image::guess_format(&png).unwrap(), image::ImageFormat::Png);
                let actual = image::load_from_memory(&png).unwrap().to_rgba8();
                assert_eq!(actual.dimensions(), expected.dimensions());
                assert_eq!(actual.as_raw(), expected.as_raw());
            });
        }

        #[test]
        fn background_png_reports_decode_failure() {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .unwrap();
            runtime.block_on(async {
                let (tx, rx) = oneshot::channel();
                let encoding = spawn_png_response(runtime.handle(), vec![0, 1, 2, 3], tx);
                let error = await_base64_response(rx, 5000, "Screenshot")
                    .await
                    .unwrap_err();
                encoding.await.unwrap();
                assert_eq!(error.error, "unknown error");
                assert_eq!(error.message, "Failed to create bitmap image rep");
            });
        }

        #[test]
        fn screenshot_timeout_includes_queued_encoding() {
            let (tiff, _) = screenshot_fixture();
            let runtime = tokio::runtime::Builder::new_current_thread()
                .max_blocking_threads(1)
                .enable_time()
                .build()
                .unwrap();
            let (release, wait) = std::sync::mpsc::channel();
            let blocker = runtime.spawn_blocking(move || {
                let _ = wait.recv_timeout(Duration::from_secs(5));
            });
            runtime.block_on(async {
                let (tx, rx) = oneshot::channel();
                let encoding = spawn_png_response(runtime.handle(), tiff, tx);
                let response = await_base64_response(rx, 10, "Screenshot").await;
                let _ = release.send(());
                blocker.await.unwrap();
                encoding.await.unwrap();
                let error = response.unwrap_err();
                assert_eq!(error.error, "timeout");
                assert_eq!(error.message, "Screenshot timed out after 10ms");
            });
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use base64::Engine as _;
    use tokio::sync::oneshot;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2CapturePreviewCompletedHandler,
        ICoreWebView2CapturePreviewCompletedHandler_Impl, ICoreWebView2Environment6,
        ICoreWebView2PrintToPdfCompletedHandler, ICoreWebView2PrintToPdfCompletedHandler_Impl,
        ICoreWebView2_7, COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
        COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use windows::core::{implement, Interface, HSTRING};
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::{
        CoInitializeEx, COINIT_APARTMENTTHREADED, STATFLAG_NONAME, STREAM_SEEK_SET,
    };
    use windows_core::BOOL;

    type CaptureSender = Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, String>>>>>;
    type PrintSender = Arc<std::sync::Mutex<Option<oneshot::Sender<Result<(), String>>>>>;

    pub(super) async fn take_screenshot<R: Runtime>(
        webview: Webview<R>,
        timeout_ms: u64,
    ) -> Result<String, WebDriverErrorResponse> {
        let (tx, rx) = oneshot::channel();

        // SAFETY: Tauri runs this callback on the main thread with a live
        // platform webview, so the pointer is valid for the call and
        // `MainThreadMarker::new_unchecked` states a fact the runtime upholds.
        // On macOS that webview is always WKWebView-backed, making the cast sound.
        let result = webview.with_webview(move |platform_webview| unsafe {
            let webview2 = match platform_webview.controller().CoreWebView2() {
                Ok(webview2) => webview2,
                Err(error) => {
                    let _ = tx.send(Err(format!("Failed to access CoreWebView2: {error:?}")));
                    return;
                }
            };

            let stream = match CreateStreamOnHGlobal(HGLOBAL::default(), true) {
                Ok(stream) => stream,
                Err(error) => {
                    let _ = tx.send(Err(format!("Failed to create preview stream: {error}")));
                    return;
                }
            };

            let handler_tx = Arc::new(std::sync::Mutex::new(Some(tx)));
            let handler = CapturePreviewHandler::new(handler_tx.clone(), stream.clone());
            let handler: ICoreWebView2CapturePreviewCompletedHandler = handler.into();

            if let Err(error) = webview2.CapturePreview(
                COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                &stream,
                &handler,
            ) {
                if let Ok(mut guard) = handler_tx.lock() {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send(Err(format!("CapturePreview failed: {error:?}")));
                    }
                }
            }
        });

        if let Err(error) = result {
            return Err(WebDriverErrorResponse::unknown_error(format!(
                "Failed to capture screenshot: {error}"
            )));
        }

        await_base64_response(rx, timeout_ms, "Screenshot").await
    }

    pub(super) async fn print_page<R: Runtime>(
        webview: Webview<R>,
        timeout_ms: u64,
        options: &PrintOptions,
    ) -> Result<String, WebDriverErrorResponse> {
        let (tx, rx) = oneshot::channel();
        let tx = Arc::new(std::sync::Mutex::new(Some(tx)));

        let temp_dir = tempfile::TempDir::new().map_err(|error| {
            WebDriverErrorResponse::unknown_error(format!("Failed to create temp dir: {error}"))
        })?;
        let pdf_path = temp_dir.path().join("print.pdf");
        let pdf_path_clone = pdf_path.clone();

        let orientation = options.orientation.clone();
        let scale = options.scale;
        let background = options.background;
        let page_width = options.page_width;
        let page_height = options.page_height;
        let margin_top = options.margin_top;
        let margin_bottom = options.margin_bottom;
        let margin_left = options.margin_left;
        let margin_right = options.margin_right;

        // SAFETY: Tauri runs this callback on the main thread with a live
        // platform webview, so the pointer is valid for the call and
        // `MainThreadMarker::new_unchecked` states a fact the runtime upholds.
        // On macOS that webview is always WKWebView-backed, making the cast sound.
        let result = webview.with_webview(move |platform_webview| unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

            let webview2 = match platform_webview.controller().CoreWebView2() {
                Ok(webview2) => webview2,
                Err(error) => {
                    if let Ok(mut guard) = tx.lock() {
                        if let Some(tx) = guard.take() {
                            let _ =
                                tx.send(Err(format!("Failed to access CoreWebView2: {error:?}")));
                        }
                    }
                    return;
                }
            };

            let webview7: ICoreWebView2_7 = match webview2.cast() {
                Ok(webview7) => webview7,
                Err(error) => {
                    if let Ok(mut guard) = tx.lock() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(format!(
                                "Failed to cast CoreWebView2 to ICoreWebView2_7: {error:?}"
                            )));
                        }
                    }
                    return;
                }
            };

            let environment = match webview7.Environment() {
                Ok(environment) => environment,
                Err(error) => {
                    if let Ok(mut guard) = tx.lock() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(format!(
                                "Failed to access WebView2 environment: {error:?}"
                            )));
                        }
                    }
                    return;
                }
            };

            let env6: ICoreWebView2Environment6 = match environment.cast() {
                Ok(env6) => env6,
                Err(error) => {
                    if let Ok(mut guard) = tx.lock() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(format!(
                                "Failed to cast environment to ICoreWebView2Environment6: {error:?}"
                            )));
                        }
                    }
                    return;
                }
            };

            let settings = match env6.CreatePrintSettings() {
                Ok(settings) => settings,
                Err(error) => {
                    if let Ok(mut guard) = tx.lock() {
                        if let Some(tx) = guard.take() {
                            let _ =
                                tx.send(Err(format!("Failed to create print settings: {error:?}")));
                        }
                    }
                    return;
                }
            };

            if let Some(orientation) = orientation.as_deref() {
                let orientation_value = if orientation == "landscape" {
                    COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
                } else {
                    COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
                };
                let _ = settings.SetOrientation(orientation_value);
            }
            if let Some(scale) = scale {
                let _ = settings.SetScaleFactor(scale);
            }
            if let Some(background) = background {
                let _ = settings.SetShouldPrintBackgrounds(background);
            }
            if let Some(page_width) = page_width {
                let _ = settings.SetPageWidth(page_width / 2.54);
            }
            if let Some(page_height) = page_height {
                let _ = settings.SetPageHeight(page_height / 2.54);
            }
            if let Some(margin_top) = margin_top {
                let _ = settings.SetMarginTop(margin_top / 2.54);
            }
            if let Some(margin_bottom) = margin_bottom {
                let _ = settings.SetMarginBottom(margin_bottom / 2.54);
            }
            if let Some(margin_left) = margin_left {
                let _ = settings.SetMarginLeft(margin_left / 2.54);
            }
            if let Some(margin_right) = margin_right {
                let _ = settings.SetMarginRight(margin_right / 2.54);
            }

            let handler_tx = tx.clone();
            let handler: ICoreWebView2PrintToPdfCompletedHandler =
                PrintToPdfHandler::new(tx).into();
            let path = HSTRING::from(pdf_path_clone.to_string_lossy().to_string());

            if let Err(error) = webview7.PrintToPdf(&path, &settings, &handler) {
                if let Ok(mut guard) = handler_tx.lock() {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send(Err(format!("PrintToPdf call failed: {error:?}")));
                    }
                }
            }
        });

        if let Err(error) = result {
            return Err(WebDriverErrorResponse::unknown_error(format!(
                "Failed to print page: {error}"
            )));
        }

        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(error))) => return Err(WebDriverErrorResponse::unknown_error(error)),
            Ok(Err(_)) => {
                return Err(WebDriverErrorResponse::unknown_error(
                    "Print channel closed unexpectedly",
                ))
            }
            Err(_) => {
                return Err(WebDriverErrorResponse::timeout(format!(
                    "Print timed out after {timeout_ms}ms"
                )))
            }
        }

        let pdf_bytes = std::fs::read(&pdf_path).map_err(|error| {
            WebDriverErrorResponse::unknown_error(format!("Failed to read printed PDF: {error}"))
        })?;
        Ok(BASE64_STANDARD.encode(pdf_bytes))
    }

    async fn await_base64_response(
        rx: oneshot::Receiver<Result<String, String>>,
        timeout_ms: u64,
        label: &str,
    ) -> Result<String, WebDriverErrorResponse> {
        match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
            Ok(Ok(Ok(base64))) if !base64.is_empty() => Ok(base64),
            Ok(Ok(Ok(_))) => Err(WebDriverErrorResponse::unknown_error(format!(
                "{label} returned empty data"
            ))),
            Ok(Ok(Err(error))) => Err(WebDriverErrorResponse::unknown_error(error)),
            Ok(Err(_)) => Err(WebDriverErrorResponse::unknown_error(format!(
                "{label} channel closed unexpectedly"
            ))),
            Err(_) => Err(WebDriverErrorResponse::timeout(format!(
                "{label} timed out after {timeout_ms}ms"
            ))),
        }
    }

    #[implement(ICoreWebView2CapturePreviewCompletedHandler)]
    struct CapturePreviewHandler {
        sender: CaptureSender,
        stream: windows::Win32::System::Com::IStream,
    }

    impl CapturePreviewHandler {
        fn new(sender: CaptureSender, stream: windows::Win32::System::Com::IStream) -> Self {
            Self { sender, stream }
        }
    }

    impl ICoreWebView2CapturePreviewCompletedHandler_Impl for CapturePreviewHandler_Impl {
        fn Invoke(&self, error_code: windows::core::HRESULT) -> windows::core::Result<()> {
            let response = if error_code.is_err() {
                Err(format!("CapturePreview completion failed: {error_code:?}"))
            } else {
                unsafe {
                    let mut stat = std::mem::zeroed();
                    if self.stream.Stat(&raw mut stat, STATFLAG_NONAME).is_err() {
                        Err("Failed to read preview stream metadata".to_string())
                    } else {
                        let size = usize::try_from(stat.cbSize).unwrap_or(0);
                        if size == 0 {
                            Err("Preview stream was empty".to_string())
                        } else {
                            let _ = self.stream.Seek(0, STREAM_SEEK_SET, None);
                            let mut bytes = vec![0u8; size];
                            let mut read = 0u32;
                            if self
                                .stream
                                .Read(
                                    bytes.as_mut_ptr().cast(),
                                    u32::try_from(size).unwrap_or(u32::MAX),
                                    Some(&raw mut read),
                                )
                                .is_err()
                            {
                                Err("Failed to read preview stream bytes".to_string())
                            } else {
                                bytes.truncate(read as usize);
                                Ok(BASE64_STANDARD.encode(bytes))
                            }
                        }
                    }
                }
            };

            if let Ok(mut guard) = self.sender.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(response);
                }
            }

            Ok(())
        }
    }

    #[implement(ICoreWebView2PrintToPdfCompletedHandler)]
    struct PrintToPdfHandler {
        sender: PrintSender,
    }

    impl PrintToPdfHandler {
        fn new(sender: PrintSender) -> Self {
            Self { sender }
        }
    }

    impl ICoreWebView2PrintToPdfCompletedHandler_Impl for PrintToPdfHandler_Impl {
        fn Invoke(
            &self,
            error_code: windows::core::HRESULT,
            is_successful: BOOL,
        ) -> windows::core::Result<()> {
            let response = if error_code.is_ok() && is_successful.as_bool() {
                Ok(())
            } else if error_code.is_ok() {
                Err("PrintToPdf reported failure".to_string())
            } else {
                Err(format!("PrintToPdf completion failed: {error_code:?}"))
            };

            if let Ok(mut guard) = self.sender.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(response);
                }
            }

            Ok(())
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;

    pub(super) async fn take_screenshot<R: Runtime>(
        _webview: Webview<R>,
        _timeout_ms: u64,
    ) -> Result<String, WebDriverErrorResponse> {
        Err(WebDriverErrorResponse::unsupported_operation(
            "Linux embedded webdriver screenshots are temporarily disabled",
        ))
    }

    pub(super) async fn print_page<R: Runtime>(
        _webview: Webview<R>,
        _timeout_ms: u64,
        _options: &PrintOptions,
    ) -> Result<String, WebDriverErrorResponse> {
        Err(WebDriverErrorResponse::unsupported_operation(
            "Linux embedded webdriver print is temporarily disabled",
        ))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod imp {
    use super::*;

    pub(super) async fn take_screenshot<R: Runtime>(
        _webview: Webview<R>,
        _timeout_ms: u64,
    ) -> Result<String, WebDriverErrorResponse> {
        Err(WebDriverErrorResponse::unknown_error(
            "Native screenshot is not implemented for this platform yet",
        ))
    }

    pub(super) async fn print_page<R: Runtime>(
        _webview: Webview<R>,
        _timeout_ms: u64,
        _options: &PrintOptions,
    ) -> Result<String, WebDriverErrorResponse> {
        Err(WebDriverErrorResponse::unsupported_operation(
            "Printing is not implemented for this platform yet",
        ))
    }
}
