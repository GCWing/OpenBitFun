//! Native scene paint below the transparent WebView, never above page content.

use objc2::{define_class, msg_send, rc::Retained, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSBezierPath, NSColor, NSView, NSViewLayerContentsRedrawPolicy,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use std::cell::RefCell;

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Surface {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub top_left_radius: f64,
    pub bottom_left_radius: f64,
    pub pixel_ratio: f64,
    // Resolved from the actual scene's computed background; no native palette.
    pub color: [u8; 3],
}

impl Surface {
    pub(super) fn frame(&self, bounds: NSRect, scale: f64) -> Option<NSRect> {
        if [
            self.left,
            self.top,
            self.right,
            self.bottom,
            self.top_left_radius,
            self.bottom_left_radius,
        ]
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0)
            || !self.pixel_ratio.is_finite()
            || self.pixel_ratio <= 0.0
            || !scale.is_finite()
            || scale <= 0.0
        {
            return None;
        }
        let width = bounds.size.width - (self.left + self.right) * scale;
        let height = bounds.size.height - (self.top + self.bottom) * scale;
        (width > 0.0 && height > 0.0).then(|| {
            NSRect::new(
                NSPoint::new(
                    bounds.origin.x + self.left * scale,
                    bounds.origin.y + self.bottom * scale,
                ),
                NSSize::new(width, height),
            )
        })
    }
}

#[derive(Default)]
pub(super) struct Paint {
    surface: Option<Surface>,
    scale: f64,
}

#[derive(Default)]
pub(super) struct PaintCell(RefCell<Paint>);

define_class!(
    #[unsafe(super(NSView))]
    #[name = "OpenBitFunSceneBackdrop"]
    #[ivars = PaintCell]
    pub(super) struct SceneBackdrop;

    impl SceneBackdrop {
        #[unsafe(method(drawRect:))]
        fn draw(&self, _dirty: NSRect) {
            let paint = self.ivars().0.borrow();
            let Some(surface) = &paint.surface else { return };
            let bounds = self.bounds();
            let width = bounds.size.width;
            let height = bounds.size.height;
            let radius_limit = width.min(height / 2.0);
            let top = (surface.top_left_radius * paint.scale).min(radius_limit);
            let bottom = (surface.bottom_left_radius * paint.scale).min(radius_limit);
            let color = surface.color.map(|channel| f64::from(channel) / 255.0);
            NSColor::colorWithSRGBRed_green_blue_alpha(color[0], color[1], color[2], 1.0).setFill();

            // Only the two left corners are rounded, matching the scene surface.
            let path = NSBezierPath::bezierPath();
            let kappa = 0.5522847498307936;
            path.moveToPoint(NSPoint::new(bottom, 0.0));
            path.lineToPoint(NSPoint::new(width, 0.0));
            path.lineToPoint(NSPoint::new(width, height));
            path.lineToPoint(NSPoint::new(top, height));
            path.curveToPoint_controlPoint1_controlPoint2(
                NSPoint::new(0.0, height - top),
                NSPoint::new(top * (1.0 - kappa), height),
                NSPoint::new(0.0, height - top * (1.0 - kappa)),
            );
            path.lineToPoint(NSPoint::new(0.0, bottom));
            path.curveToPoint_controlPoint1_controlPoint2(
                NSPoint::new(bottom, 0.0),
                NSPoint::new(0.0, bottom * (1.0 - kappa)),
                NSPoint::new(bottom * (1.0 - kappa), 0.0),
            );
            path.closePath();
            path.fill();
        }
    }
);

impl SceneBackdrop {
    pub(super) fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let view = Self::alloc(mtm).set_ivars(PaintCell::default());
        // SAFETY: Initialize the NSView superclass before using the instance.
        let view: Retained<Self> = unsafe { msg_send![super(view), init] };
        view.setAutoresizingMask(
            NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable,
        );
        view.setWantsLayer(true);
        view.setLayerContentsRedrawPolicy(NSViewLayerContentsRedrawPolicy::DuringViewResize);
        view.setHidden(true);
        view
    }

    pub(super) fn update(&self, surface: Option<Surface>) {
        let Some(surface) = surface else {
            self.clear();
            return;
        };
        // SAFETY: All native view access stays on the main thread.
        let Some(parent) = (unsafe { self.superview() }) else {
            self.clear();
            return;
        };
        let scale = surface.pixel_ratio
            / self
                .window()
                .map_or(1.0, |window| window.backingScaleFactor());
        let Some(frame) = surface.frame(parent.bounds(), scale) else {
            self.clear();
            return;
        };
        self.ivars().0.replace(Paint {
            surface: Some(surface),
            scale,
        });
        self.setFrame(frame);
        self.setHidden(false);
        self.setNeedsDisplay(true);
    }

    pub(super) fn clear(&self) {
        self.setHidden(true);
        self.ivars().0.borrow_mut().surface = None;
    }
}
