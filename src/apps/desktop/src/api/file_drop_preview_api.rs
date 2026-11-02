//! A temporary, chat-sized OLE target. It never replaces WebView2's drop target:
//! HTML text, tabs and workspace-file drags keep their normal browser path.
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetFileDropPreviewTargetRequest {
    target_id: String,
    bounds: Option<PreviewBounds>,
}

impl SetFileDropPreviewTargetRequest {
    fn validate(&self) -> Result<(), String> {
        if self.target_id.is_empty() || self.target_id.len() > 128 {
            return Err("Invalid file preview target id".into());
        }
        if let Some(b) = &self.bounds {
            if ![b.x, b.y, b.width, b.height, b.scale]
                .iter()
                .all(|v| v.is_finite())
                || b.width <= 0.0
                || b.height <= 0.0
                || b.scale <= 0.0
                || b.scale > 10.0
            {
                return Err("Invalid file preview target bounds".into());
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn set_file_drop_preview_target(
    webview: tauri::Webview,
    request: SetFileDropPreviewTargetRequest,
) -> Result<(), String> {
    request.validate()?;
    if webview.label() != "main" {
        return Err("File drag previews require the main desktop window".into());
    }
    #[cfg(target_os = "windows")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let window = webview.window();
        let owner = window.clone();
        window
            .run_on_main_thread(move || {
                let release = SetFileDropPreviewTargetRequest {
                    target_id: request.target_id.clone(),
                    bounds: None,
                };
                let result = native::set_target(owner.clone(), request);
                if let Err(error) = &result {
                    log::warn!("Native file preview target activation failed: {error}");
                    // A failed positioning call may still have shown the child.
                    // Release it before handing the drag back to the browser.
                    let _ = native::set_target(owner, release);
                }
                let _ = sender.send(result);
            })
            .map_err(|e| e.to_string())?;
        receiver.await.map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "windows"))]
    Err("Native file drag previews are only available on Windows".into())
}

#[cfg(target_os = "windows")]
mod native {
    use super::*;
    use base64::Engine;
    use serde::Serialize;
    use std::{
        cell::{Cell, RefCell},
        collections::HashMap,
        ffi::OsString,
        io::Cursor,
        os::windows::ffi::OsStringExt,
        ptr,
        rc::Rc,
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc,
        },
    };
    use tauri::Emitter;
    use windows::{
        core::{implement, w},
        Win32::{
            Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, POINTL, RECT, WPARAM},
            Graphics::Gdi::ScreenToClient,
            System::{
                Com::{
                    CoCreateInstance, IDataObject, CLSCTX_INPROC_SERVER, DVASPECT_CONTENT,
                    FORMATETC, TYMED_HGLOBAL,
                },
                LibraryLoader::GetModuleHandleW,
                Ole::{
                    IDropTarget, IDropTarget_Impl, OleInitialize, OleUninitialize,
                    RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, CF_HDROP, DROPEFFECT,
                    DROPEFFECT_COPY, DROPEFFECT_NONE,
                },
                SystemServices::MODIFIERKEYS_FLAGS,
            },
            UI::{
                Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
                Shell::{CLSID_DragDropHelper, DragQueryFileW, IDropTargetHelper, HDROP},
                WindowsAndMessaging::*,
            },
        },
    };

    const EVENT: &str = "openbitfun://file-drop-preview";
    const TIMER: usize = 1;
    const PREVIEW_FILES: usize = 1;

    fn dismiss_shell_drag_image(
        helper: &IDropTargetHelper,
        hwnd: HWND,
        data: &IDataObject,
        pt: &POINTL,
    ) -> windows::core::Result<()> {
        // Show(false) can return S_OK while the modern layered SysDragImage
        // remains visible. Claim the incoming image, then end only the Shell
        // renderer's session before publishing our custom preview. The OLE
        // target remains active and still receives DragOver/Drop normally.
        // Do not forward those callbacks to the retired renderer or mutate the
        // source bitmap: the next target can recreate its image on DragEnter.
        unsafe {
            let entered =
                helper.DragEnter(hwnd, data, &POINT { x: pt.x, y: pt.y }, DROPEFFECT_COPY);
            // Also clean up a partially initialized renderer on enter failure.
            let dismissed = helper.DragLeave();
            entered.and(dismissed)
        }
    }

    fn native_error(operation: &str, error: windows::core::Error) -> String {
        format!("File preview {operation} failed: {error}")
    }
    thread_local! {
        static TARGETS: RefCell<HashMap<isize, TargetWindow>> = RefCell::new(HashMap::new());
    }
    struct TargetWindow {
        hwnd: HWND,
        target_id: Arc<std::sync::Mutex<String>>,
        scale: Rc<Cell<f64>>,
        _ole: OleApartment,
    }

    struct OleApartment;
    impl Drop for OleApartment {
        fn drop(&mut self) {
            unsafe {
                OleUninitialize();
            }
        }
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PreviewFile {
        name: String,
        thumbnail: Option<String>,
    }
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PreviewEvent {
        target_id: String,
        generation: u64,
        kind: &'static str,
        x: f64,
        y: f64,
        count: usize,
        files: Vec<PreviewFile>,
        #[serde(skip_serializing_if = "Option::is_none")]
        paths: Option<Vec<String>>,
    }

    // A layered child with alpha=1 is visually transparent but still receives
    // OLE hit testing. A zero-alpha or WS_EX_TRANSPARENT child would pass through.
    unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        unsafe {
            match msg {
                WM_TIMER if GetAsyncKeyState(VK_LBUTTON.0 as i32) >= 0 => {
                    let _ = ShowWindow(hwnd, SW_HIDE);
                    let _ = KillTimer(Some(hwnd), TIMER);
                }
                WM_DESTROY => {
                    let _ = RevokeDragDrop(hwnd);
                }
                WM_MOUSEACTIVATE => return LRESULT(MA_NOACTIVATE as isize),
                _ => {}
            }
            DefWindowProcW(hwnd, msg, w, l)
        }
    }

    // This must run under the executable's Windows 8+ compatibility manifest.
    // Windows otherwise rejects WS_EX_LAYERED children, sometimes with error 0.
    fn create_preview_window(parent: HWND) -> Result<HWND, String> {
        let instance =
            unsafe { GetModuleHandleW(None) }.map_err(|e| native_error("GetModuleHandleW", e))?;
        let class = w!("OpenBitFunFilePreviewTarget");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance.into(),
            lpszClassName: class,
            ..Default::default()
        };
        if unsafe { RegisterClassW(&wc) } == 0 {
            let error = unsafe { windows::Win32::Foundation::GetLastError() };
            if error != windows::Win32::Foundation::ERROR_CLASS_ALREADY_EXISTS {
                return Err(native_error("RegisterClassW", error.into()));
            }
        }
        unsafe {
            CreateWindowExW(
                WS_EX_LAYERED | WS_EX_NOACTIVATE,
                class,
                w!(""),
                WS_CHILD,
                0,
                0,
                1,
                1,
                Some(parent),
                None,
                Some(instance.into()),
                None,
            )
        }
        .map_err(|e| native_error("CreateWindowExW", e))
    }

    pub(super) fn set_target(
        window: tauri::Window,
        request: SetFileDropPreviewTargetRequest,
    ) -> Result<(), String> {
        let parent = window
            .hwnd()
            .map_err(|e| format!("File preview main-window handle failed: {e}"))?;
        TARGETS.with(|targets| {
            let mut targets = targets.borrow_mut();
            let key = parent.0 as isize;
            if request.bounds.is_none() {
                if let Some(target) = targets.get(&key) {
                    if *target.target_id.lock().unwrap_or_else(|e| e.into_inner())
                        == request.target_id
                    {
                        unsafe {
                            let _ = KillTimer(Some(target.hwnd), TIMER);
                            let _ = ShowWindow(target.hwnd, SW_HIDE);
                        }
                    }
                }
                return Ok(());
            }
            // Do not leave a late activation covering the page after mouse-up.
            if unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } >= 0 {
                return Ok(());
            }
            if targets
                .get(&key)
                .is_some_and(|target| !unsafe { IsWindow(Some(target.hwnd)).as_bool() })
            {
                targets.remove(&key);
            }
            if !targets.contains_key(&key) {
                // CoInitializeEx alone is insufficient for RegisterDragDrop.
                // Balance our own OLE reference even when the host initialized it.
                unsafe { OleInitialize(None) }.map_err(|e| native_error("OleInitialize", e))?;
                let ole = OleApartment;
                let helper: IDropTargetHelper =
                    unsafe { CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER) }
                        .map_err(|e| native_error("CoCreateInstance(DragDropHelper)", e))?;
                let hwnd = create_preview_window(parent)?;
                let target_id = Arc::new(std::sync::Mutex::new(request.target_id.clone()));
                let scale = Rc::new(Cell::new(1.0));
                let target: IDropTarget = FileTarget {
                    hwnd,
                    parent,
                    owner: window,
                    target_id: Arc::clone(&target_id),
                    helper,
                    generation: Arc::new(AtomicU64::new(0)),
                    paths: RefCell::new(Vec::new()),
                    scale: Rc::clone(&scale),
                }
                .into();
                let registered = unsafe {
                    SetLayeredWindowAttributes(hwnd, COLORREF(0), 1, LWA_ALPHA)
                        .map_err(|e| native_error("SetLayeredWindowAttributes", e))
                        .and_then(|_| {
                            RegisterDragDrop(hwnd, &target)
                                .map_err(|e| native_error("RegisterDragDrop", e))
                        })
                };
                if let Err(e) = registered {
                    unsafe {
                        let _ = DestroyWindow(hwnd);
                    }
                    return Err(e);
                }
                targets.insert(
                    key,
                    TargetWindow {
                        hwnd,
                        target_id,
                        scale,
                        _ole: ole,
                    },
                );
            }
            let target = targets.get(&key).expect("target inserted above");
            *target.target_id.lock().unwrap_or_else(|e| e.into_inner()) = request.target_id;
            let b = request.bounds.expect("bounds checked above");
            let mut client = RECT::default();
            unsafe { GetClientRect(parent, &mut client) }
                .map_err(|e| native_error("GetClientRect", e))?;
            let x = (b.x * b.scale).round().clamp(0.0, client.right as f64) as i32;
            let y = (b.y * b.scale).round().clamp(0.0, client.bottom as f64) as i32;
            let width = (b.width * b.scale)
                .round()
                .clamp(0.0, (client.right - x) as f64) as i32;
            let height = (b.height * b.scale)
                .round()
                .clamp(0.0, (client.bottom - y) as f64) as i32;
            target.scale.set(b.scale);
            unsafe {
                SetWindowPos(
                    target.hwnd,
                    Some(HWND_TOP),
                    x,
                    y,
                    width,
                    height,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                )
                .map_err(|e| native_error("SetWindowPos", e))?;
                SetTimer(Some(target.hwnd), TIMER, 100, None);
            }
            Ok(())
        })
    }

    #[implement(IDropTarget)]
    struct FileTarget {
        hwnd: HWND,
        parent: HWND,
        owner: tauri::Window,
        target_id: Arc<std::sync::Mutex<String>>,
        helper: IDropTargetHelper,
        generation: Arc<AtomicU64>,
        paths: RefCell<Vec<String>>,
        scale: Rc<Cell<f64>>,
    }

    fn file_paths(data: &IDataObject) -> windows::core::Result<Vec<String>> {
        let format = FORMATETC {
            cfFormat: CF_HDROP.0,
            ptd: ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        unsafe {
            let mut medium = data.GetData(&format)?;
            let drop = HDROP(medium.u.hGlobal.0);
            let count = DragQueryFileW(drop, u32::MAX, None);
            if count > 4096 {
                ReleaseStgMedium(&mut medium);
                return Err(windows::core::Error::new(
                    windows::Win32::Foundation::E_INVALIDARG,
                    "File drop exceeds the browser intake limit",
                ));
            }
            let mut paths = Vec::with_capacity(count as usize);
            for index in 0..count {
                let length = DragQueryFileW(drop, index, None) as usize;
                let mut buf = vec![0; length + 1];
                DragQueryFileW(drop, index, Some(&mut buf));
                paths.push(
                    OsString::from_wide(&buf[..length])
                        .to_string_lossy()
                        .into_owned(),
                );
            }
            ReleaseStgMedium(&mut medium);
            Ok(paths)
        }
    }

    fn thumbnail(path: &str) -> Option<String> {
        let extension = std::path::Path::new(path)
            .extension()?
            .to_str()?
            .to_ascii_lowercase();
        if !matches!(
            extension.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
        ) {
            return None;
        }
        let file = std::fs::File::open(path).ok()?;
        if file.metadata().ok()?.len() > 32 * 1024 * 1024 {
            return None;
        }
        let mut reader = image::ImageReader::new(std::io::BufReader::new(file))
            .with_guessed_format()
            .ok()?;
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);
        let image = reader.decode().ok()?.thumbnail(200, 160);
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).ok()?;
        Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
        ))
    }

    impl FileTarget_Impl {
        fn event(&self, kind: &'static str, pt: &POINTL) -> PreviewEvent {
            let mut point = POINT { x: pt.x, y: pt.y };
            unsafe {
                let _ = ScreenToClient(self.parent, &mut point);
            }
            let paths = self.paths.borrow();
            PreviewEvent {
                target_id: self
                    .target_id
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone(),
                generation: self.generation.load(Ordering::Relaxed),
                kind,
                x: point.x as f64 / self.scale.get(),
                y: point.y as f64 / self.scale.get(),
                count: paths.len(),
                files: paths
                    .iter()
                    .take(PREVIEW_FILES)
                    .map(|path| PreviewFile {
                        name: std::path::Path::new(path)
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned(),
                        thumbnail: None,
                    })
                    .collect(),
                paths: (kind == "drop").then(|| paths.clone()),
            }
        }
        fn finish(&self, kind: &'static str, pt: &POINTL) {
            let _ = self
                .owner
                .emit_to(self.owner.label(), EVENT, self.event(kind, pt));
            self.generation.fetch_add(1, Ordering::Relaxed);
            self.paths.borrow_mut().clear();
            unsafe {
                let _ = KillTimer(Some(self.hwnd), TIMER);
                let _ = ShowWindow(self.hwnd, SW_HIDE);
            }
        }
    }

    #[allow(non_snake_case)]
    impl IDropTarget_Impl for FileTarget_Impl {
        fn DragEnter(
            &self,
            data: windows_core::Ref<'_, IDataObject>,
            _keys: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            let Some(data) = data.as_ref() else {
                unsafe {
                    *effect = DROPEFFECT_NONE;
                }
                self.finish("unavailable", pt);
                return Ok(());
            };
            let paths = match file_paths(data) {
                Ok(paths) if !paths.is_empty() => paths,
                _ => {
                    unsafe {
                        *effect = DROPEFFECT_NONE;
                    }
                    self.finish("unavailable", pt);
                    return Ok(());
                }
            };
            *self.paths.borrow_mut() = paths.clone();
            self.generation.fetch_add(1, Ordering::Relaxed);
            unsafe {
                *effect = DROPEFFECT_COPY;
                let _ = KillTimer(Some(self.hwnd), TIMER);
                if let Err(error) = dismiss_shell_drag_image(&self.helper, self.hwnd, data, pt) {
                    log::warn!("Native file drag preview is unavailable: {error}");
                    *effect = DROPEFFECT_NONE;
                    self.finish("unavailable", pt);
                    return Ok(());
                }
            }
            let event = self.event("enter", pt);
            let _ = self.owner.emit_to(self.owner.label(), EVENT, &event);
            let owner = self.owner.clone();
            let generation = Arc::clone(&self.generation);
            tauri::async_runtime::spawn_blocking(move || {
                let mut update = event;
                update.kind = "thumbnails";
                for (file, path) in update.files.iter_mut().zip(paths.iter()) {
                    if generation.load(Ordering::Relaxed) != update.generation {
                        return;
                    }
                    file.thumbnail = thumbnail(path);
                }
                if generation.load(Ordering::Relaxed) == update.generation {
                    let _ = owner.emit_to(owner.label(), EVENT, update);
                }
            });
            Ok(())
        }
        fn DragOver(
            &self,
            _keys: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            unsafe {
                *effect = DROPEFFECT_COPY;
            }
            let _ = self
                .owner
                .emit_to(self.owner.label(), EVENT, self.event("over", pt));
            Ok(())
        }
        fn DragLeave(&self) -> windows::core::Result<()> {
            self.finish("leave", &POINTL::default());
            Ok(())
        }
        fn Drop(
            &self,
            data: windows_core::Ref<'_, IDataObject>,
            _keys: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            let paths = data.as_ref().and_then(|data| file_paths(data).ok());
            let Some(paths) = paths.filter(|paths| !paths.is_empty()) else {
                unsafe {
                    *effect = DROPEFFECT_NONE;
                }
                self.finish("unavailable", pt);
                return Ok(());
            };
            *self.paths.borrow_mut() = paths;
            unsafe {
                *effect = DROPEFFECT_COPY;
            }
            self.finish("drop", pt);
            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::{
            core::{Interface, BOOL},
            Win32::{
                Foundation::SIZE,
                Graphics::Gdi::{CreateBitmap, DeleteObject},
                UI::Shell::{IDragSourceHelper, SHCreateDataObject, SHDRAGIMAGE},
            },
        };

        struct TestWindow(HWND);
        impl TestWindow {
            fn new() -> Self {
                Self(unsafe {
                    CreateWindowExW(
                        WINDOW_EX_STYLE::default(),
                        w!("STATIC"),
                        w!(""),
                        WS_OVERLAPPED,
                        0,
                        0,
                        640,
                        480,
                        None,
                        None,
                        None,
                        None,
                    )
                    .unwrap()
                })
            }
        }
        impl Drop for TestWindow {
            fn drop(&mut self) {
                unsafe {
                    let _ = DestroyWindow(self.0);
                }
            }
        }

        // Inspect only this test thread's windows, never Explorer/user windows.
        fn shell_image_count(parent: HWND) -> usize {
            unsafe extern "system" fn count(hwnd: HWND, context: LPARAM) -> BOOL {
                let mut class = [0u16; 64];
                unsafe {
                    let length = GetClassNameW(hwnd, &mut class) as usize;
                    if String::from_utf16_lossy(&class[..length]) == "SysDragImage" {
                        *(context.0 as *mut usize) += 1;
                    }
                }
                BOOL(1)
            }
            let mut result = 0usize;
            unsafe {
                let mut message = MSG::default();
                while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                let _ = EnumThreadWindows(
                    GetWindowThreadProcessId(parent, None),
                    Some(count),
                    LPARAM(&mut result as *mut usize as isize),
                );
            }
            result
        }

        #[test]
        fn custom_preview_retires_shell_image_and_allows_next_target_to_restore_it() {
            unsafe { OleInitialize(None) }.unwrap();
            let _ole = OleApartment;
            let parent = TestWindow::new();
            let data: IDataObject = unsafe { SHCreateDataObject(None, None, None) }.unwrap();
            let source: IDragSourceHelper =
                unsafe { CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER) }
                    .unwrap();
            let shell: IDropTargetHelper = source.cast().unwrap();
            let custom: IDropTargetHelper =
                unsafe { CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER) }
                    .unwrap();
            // Transparent one-pixel fixture: real Shell rendering, no thumbnail
            // of user files and no visible test window over the working desktop.
            let pixel = 0u32;
            let bitmap = unsafe { CreateBitmap(1, 1, 1, 32, Some((&pixel as *const u32).cast())) };
            assert!(!bitmap.is_invalid());
            let image = SHDRAGIMAGE {
                sizeDragImage: SIZE { cx: 1, cy: 1 },
                hbmpDragImage: bitmap,
                ..Default::default()
            };
            let initialized = unsafe { source.InitializeFromBitmap(&image, &data) };
            if initialized.is_err() {
                unsafe {
                    let _ = DeleteObject(bitmap.into());
                }
            }
            // The helper owns the bitmap after successful initialization.
            initialized.unwrap();
            let point = POINT::default();
            for visit in 0..20 {
                unsafe { shell.DragEnter(parent.0, &data, &point, DROPEFFECT_COPY) }.unwrap();
                assert_eq!(
                    shell_image_count(parent.0),
                    1,
                    "Shell fixture must create a real image"
                );
                // Include both a completed handoff and an image still held by
                // the preceding target when our native receiver takes over.
                if visit % 2 == 0 {
                    unsafe { shell.DragLeave() }.unwrap();
                }
                dismiss_shell_drag_image(&custom, parent.0, &data, &POINTL::default()).unwrap();
                assert_eq!(
                    shell_image_count(parent.0),
                    0,
                    "custom preview must be the only renderer"
                );
                unsafe { shell.DragEnter(parent.0, &data, &point, DROPEFFECT_COPY) }.unwrap();
                assert_eq!(
                    shell_image_count(parent.0),
                    1,
                    "leaving chat must preserve the source image"
                );
                unsafe {
                    if visit % 2 == 0 {
                        shell.Drop(&data, &point, DROPEFFECT_COPY).unwrap();
                    } else {
                        shell.DragLeave().unwrap();
                    }
                }
                assert_eq!(
                    shell_image_count(parent.0),
                    0,
                    "drop/cancel must leave no image window"
                );
            }
        }

        #[test]
        fn creates_and_recreates_the_layered_receiver_window() {
            // Keep the parent hidden: this exercises real Win32 creation without
            // displaying a window or interfering with the user's active drag.
            let parent = TestWindow::new();
            for _ in 0..50 {
                let child = create_preview_window(parent.0).expect(
                    "layered child creation requires the desktop Windows compatibility manifest",
                );
                unsafe {
                    let alpha = SetLayeredWindowAttributes(child, COLORREF(0), 1, LWA_ALPHA);
                    let valid = IsWindow(Some(child)).as_bool();
                    DestroyWindow(child).unwrap();
                    assert!(valid);
                    alpha.unwrap();
                    assert!(!IsWindow(Some(child)).as_bool());
                }
            }
        }

        #[test]
        fn encodes_a_bounded_thumbnail_for_large_images() {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("photo.PNG");
            image::RgbaImage::from_pixel(800, 600, image::Rgba([20, 100, 180, 255]))
                .save(&path)
                .unwrap();
            let preview = thumbnail(path.to_str().unwrap()).unwrap();
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(preview.strip_prefix("data:image/png;base64,").unwrap())
                .unwrap();
            let decoded = image::load_from_memory(&bytes).unwrap();
            assert_eq!((decoded.width(), decoded.height()), (200, 150));
        }

        #[test]
        fn unreadable_or_non_image_files_keep_the_format_icon_path() {
            let directory = tempfile::tempdir().unwrap();
            for name in ["broken.jpg", "report.pdf", "notes.docx"] {
                let path = directory.path().join(name);
                std::fs::write(&path, b"not an image").unwrap();
                assert!(thumbnail(path.to_str().unwrap()).is_none());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_release_and_extra_fields_for_forward_compatibility() {
        let request: SetFileDropPreviewTargetRequest =
            serde_json::from_str(r#"{"targetId":"chat","bounds":null,"future":true}"#).unwrap();
        assert!(request.validate().is_ok());
    }
    #[test]
    fn rejects_invalid_preview_geometry() {
        let request = SetFileDropPreviewTargetRequest {
            target_id: "chat".into(),
            bounds: Some(PreviewBounds {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
                scale: f64::NAN,
            }),
        };
        assert!(request.validate().is_err());
    }
}
