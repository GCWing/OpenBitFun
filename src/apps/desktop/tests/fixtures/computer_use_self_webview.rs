//! Real same-process AppKit chrome and a separate WebKit accessibility subtree.
use objc2::{msg_send, rc::Retained, runtime::AnyObject, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSBackingStoreType, NSWindow, NSWindowStyleMask};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

#[link(name = "WebKit", kind = "framework")]
unsafe extern "C" {}

pub(super) fn create() -> Retained<NSWindow> {
    let mtm = MainThreadMarker::new().unwrap();
    let frame = NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(640.0, 480.0));
    unsafe {
        let window = NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            frame,
            NSWindowStyleMask::Titled | NSWindowStyleMask::Closable | NSWindowStyleMask::Resizable,
            NSBackingStoreType::Buffered,
            false,
        );
        window.setReleasedWhenClosed(false);
        window.setTitle(&NSString::from_str("Computer Use Self WebView Fixture"));
        let view: *mut AnyObject = msg_send![objc2::class!(WKWebView), alloc];
        let view: *mut AnyObject = msg_send![view, initWithFrame: frame];
        let view = Retained::from_raw(view).expect("WKWebView initialization");
        let _: () = msg_send![&*window, setContentView: &*view];
        let html = NSString::from_str(
            r#"<!doctype html><html><body>
            <h1>Self observation ready</h1>
            <button onclick="document.getElementById('result').textContent='Self click count '+(++window.clicks)">Self test button</button>
            <label>Self test field<input aria-label="Self test field"></label>
            <p id="result">Self click count 0</p><p id="input-result">Self input value: </p>
            <script>
            window.clicks=0;
            setInterval(() => {
                const result = document.getElementById('input-result');
                const value = 'Self input value: ' + document.querySelector('input').value;
                if (result.textContent !== value) result.textContent = value;
            }, 50);
            </script>
            </body></html>"#,
        );
        let _: *mut AnyObject =
            msg_send![&*view, loadHTMLString: &*html, baseURL: std::ptr::null::<AnyObject>()];
        window.orderFrontRegardless();
        window
    }
}
