// Run through scripts/test-macos-window-resize.mjs on the AppKit main thread.
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSAutoresizingMaskOptions, NSView};
use objc2_foundation::{NSPoint, NSRect, NSSize};

fn rect(x: f64, y: f64, width: f64, height: f64) -> NSRect {
    NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
}

fn main() {
    let mtm = MainThreadMarker::new().unwrap();
    let parent = NSView::initWithFrame(NSView::alloc(mtm), rect(0.0, 0.0, 1200.0, 800.0));
    let main = NSView::initWithFrame(NSView::alloc(mtm), parent.bounds());
    main.setAutoresizingMask(NSAutoresizingMaskOptions::ViewMinYMargin);
    parent.addSubview(&main);

    // Reproduce Wry's child-view policy: the native container has grown but
    // the frontend still has its old size, before any queued event is handled.
    parent.setFrameSize(NSSize::new(1470.0, 826.0));
    assert_eq!(main.frame().size, NSSize::new(1200.0, 800.0));
    assert_ne!(main.frame(), parent.bounds());

    geometry::follow_parent_bounds(&main).unwrap();
    assert_eq!(main.frame(), parent.bounds());
    let preview = NSView::initWithFrame(NSView::alloc(mtm), rect(90.0, 130.0, 400.0, 300.0));
    preview.setAutoresizingMask(NSAutoresizingMaskOptions::ViewMinYMargin);
    parent.addSubview(&preview);
    let preview_top =
        parent.bounds().size.height - preview.frame().origin.y - preview.frame().size.height;

    // No event loop is pumped between mutation and assertion. Exercise large
    // growth, shrinking, single-pixel adjustment, height-only and fractional
    // logical sizes (AppKit, rather than rounded physical-event sizes, owns it).
    for size in [
        NSSize::new(1800.0, 1100.0),
        NSSize::new(900.0, 600.0),
        NSSize::new(901.0, 600.0),
        NSSize::new(901.0, 950.0),
        NSSize::new(1200.5, 800.5),
    ] {
        parent.setFrameSize(size);
        assert_eq!(main.frame(), parent.bounds());
        assert_eq!(preview.frame().size, NSSize::new(400.0, 300.0));
        assert_eq!(preview.frame().origin.x, 90.0);
        assert_eq!(
            parent.bounds().size.height - preview.frame().origin.y - preview.frame().size.height,
            preview_top
        );
        assert_eq!(
            preview.autoresizingMask(),
            NSAutoresizingMaskOptions::ViewMinYMargin
        );
    }
    // Idempotence and graceful failure must not overwrite sibling policies.
    geometry::follow_parent_bounds(&main).unwrap();
    assert_eq!(main.frame(), parent.bounds());
    let orphan = NSView::initWithFrame(NSView::alloc(mtm), rect(0.0, 0.0, 400.0, 300.0));
    assert!(geometry::follow_parent_bounds(&orphan).is_err());
    parent.setAutoresizesSubviews(false);
    let previous_mask = preview.autoresizingMask();
    let previous_frame = preview.frame();
    assert!(geometry::follow_parent_bounds(&preview).is_err());
    assert_eq!(preview.autoresizingMask(), previous_mask);
    assert_eq!(preview.frame(), previous_frame);
    println!("PASS synchronous main-view resizing and independent browser child bounds");

    parent.setAutoresizesSubviews(true);
    parent.setFrameSize(NSSize::new(1200.0, 800.0));
    let surface: backdrop::Surface = serde_json::from_str(
        r#"{
        "left":300,"top":0,"right":0,"bottom":0,
        "topLeftRadius":12,"bottomLeftRadius":12,"pixelRatio":1,
        "color":[249,248,247],"futureField":true
    }"#,
    )
    .unwrap();
    let background = backdrop::SceneBackdrop::new(mtm);
    parent.addSubview(&background);
    background.update(Some(surface.clone()));
    assert!(!background.isHidden());
    assert_eq!(background.frame(), rect(300.0, 0.0, 900.0, 800.0));
    parent.setFrameSize(NSSize::new(1600.0, 1000.0));
    assert_eq!(background.frame(), rect(300.0, 0.0, 1300.0, 1000.0));
    assert_eq!(
        surface.frame(parent.bounds(), 1.5).unwrap(),
        rect(450.0, 0.0, 1150.0, 1000.0)
    );
    let mut invalid = surface.clone();
    invalid.left = f64::NAN;
    background.update(Some(invalid));
    assert!(background.isHidden());
    background.update(Some(surface));
    background.update(None);
    assert!(background.isHidden());
    println!("PASS native scene background growth, zoom and invalid-payload fallback");
}
