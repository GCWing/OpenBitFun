use winit::window::Window;

use super::Frame;

#[cfg(target_os = "macos")]
fn frame_image(frame: Frame) -> core_graphics::image::CGImage {
    use std::sync::Arc;

    use core_graphics::{
        color_space::CGColorSpace,
        data_provider::CGDataProvider,
        image::{CGImage, CGImageAlphaInfo, CGImageByteOrderInfo},
    };
    let width = frame.width as usize;
    CGImage::new(
        width,
        frame.height as usize,
        8,
        32,
        width * 4,
        &CGColorSpace::create_device_rgb(),
        CGImageAlphaInfo::CGImageAlphaPremultipliedFirst as u32
            | CGImageByteOrderInfo::CGImageByteOrder32Little as u32,
        &CGDataProvider::from_buffer(Arc::new(frame.pixels)),
        false,
        0,
    )
}

#[cfg(target_os = "macos")]
pub(super) fn present(window: &dyn Window, frame: Frame) -> Result<(), String> {
    use foreign_types::ForeignType;
    use objc2::{runtime::AnyObject, MainThreadMarker};
    use objc2_app_kit::NSView;
    use objc2_foundation::NSString;
    use objc2_quartz_core::{CALayer, CATransaction};
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let _main_thread =
        MainThreadMarker::new().ok_or("Companion painting requires the main thread")?;
    let handle = window.window_handle().map_err(|error| error.to_string())?;
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return Err("Missing AppKit companion view".into());
    };
    // The native window retains this view throughout the redraw callback.
    let view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    view.setWantsLayer(true);
    let backing = view.layer().ok_or("Missing companion backing layer")?;
    let name = NSString::from_str("OpenBitFunAgentCompanion");
    // The layer tree belongs to AppKit's main thread.
    let layer = unsafe { backing.sublayers() }
        .and_then(|layers| {
            layers
                .iter()
                .find(|layer| layer.name().as_deref() == Some(&*name))
        })
        .unwrap_or_else(|| {
            let layer = CALayer::new();
            layer.setName(Some(&name));
            backing.addSublayer(&layer);
            layer
        });

    let image = frame_image(frame);
    CATransaction::begin();
    CATransaction::setDisableActions(true);
    layer.setFrame(view.bounds());
    layer.setContentsScale(window.scale_factor());
    // CALayer accepts and retains a CGImage as its contents.
    unsafe { layer.setContents(image.as_ptr().cast::<AnyObject>().as_ref()) };
    CATransaction::commit();
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{frame_image, Frame};
    use core_graphics::{
        color_space::CGColorSpace,
        context::CGContext,
        geometry::{CGPoint, CGRect, CGSize},
        image::CGImageAlphaInfo,
    };

    #[test]
    fn companion_image_keeps_transparent_and_translucent_pixels() {
        let image = frame_image(Frame {
            width: 2,
            height: 1,
            pixels: vec![0, 0, 0, 0, 0, 0, 128, 128],
        });
        let mut rgba = CGContext::create_bitmap_context(
            None,
            2,
            1,
            8,
            8,
            &CGColorSpace::create_device_rgb(),
            CGImageAlphaInfo::CGImageAlphaPremultipliedLast as u32,
        );
        let bounds = CGRect::new(&CGPoint::new(0., 0.), &CGSize::new(2., 1.));
        rgba.clear_rect(bounds);
        rgba.draw_image(bounds, &image);
        assert_eq!(rgba.data(), &[0, 0, 0, 0, 128, 0, 0, 128]);
    }
}

#[cfg(target_os = "windows")]
pub(super) fn present(window: &dyn Window, frame: Frame) -> Result<(), String> {
    use std::{ffi::c_void, ptr};

    use windows::Win32::{
        Foundation::{COLORREF, HWND, POINT, SIZE},
        Graphics::Gdi::{
            CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject,
            AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION, DIB_RGB_COLORS,
        },
        UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, UpdateLayeredWindow, GWL_EXSTYLE, ULW_ALPHA,
            WS_EX_LAYERED,
        },
    };
    use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let handle = window.window_handle().map_err(|error| error.to_string())?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return Err("Missing companion HWND".into());
    };
    let hwnd = HWND(handle.hwnd.get() as *mut c_void);
    let native_size = window.surface_size().cast::<i32>();
    let size = SIZE {
        cx: native_size.width,
        cy: native_size.height,
    };
    let len = super::frame_byte_len(size.cx, size.cy).ok_or("Invalid companion HWND size")?;
    let bitmap_info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: size.cx,
            biHeight: -size.cy,
            biPlanes: 1,
            biBitCount: 32,
            ..Default::default()
        },
        ..Default::default()
    };
    let blend = BLENDFUNCTION {
        BlendOp: AC_SRC_OVER as u8,
        SourceConstantAlpha: 255,
        AlphaFormat: AC_SRC_ALPHA as u8,
        ..Default::default()
    };
    // The HWND lives throughout this callback. The selected bitmap remains
    // alive through UpdateLayeredWindow and is deselected before deletion.
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if style & WS_EX_LAYERED.0 as isize == 0 {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED.0 as isize);
        }
        let mut bits = ptr::null_mut();
        let bitmap = CreateDIBSection(None, &bitmap_info, DIB_RGB_COLORS, &mut bits, None, 0)
            .map_err(|error| error.to_string())?;
        let dc = CreateCompatibleDC(None);
        if dc.is_invalid() {
            let _ = DeleteObject(bitmap.into());
            return Err("Failed to allocate a companion memory DC".into());
        }
        let pixels = std::slice::from_raw_parts_mut(bits.cast::<u8>(), len);
        if frame.width == size.cx && frame.height == size.cy {
            pixels.copy_from_slice(&frame.pixels);
        } else {
            // Round the CEF frame to the native surface without resizing the
            // HWND. At fractional DPI the two sizes can differ by a pixel.
            pixels.fill(0);
            let row_width = frame.width.min(size.cx) as usize * 4;
            for (target, source) in pixels
                .chunks_exact_mut(size.cx as usize * 4)
                .zip(frame.pixels.chunks_exact(frame.width as usize * 4))
            {
                target[..row_width].copy_from_slice(&source[..row_width]);
            }
        }
        let previous = SelectObject(dc, bitmap.into());
        let result = UpdateLayeredWindow(
            hwnd,
            None,
            None,
            Some(&size),
            Some(dc),
            Some(&POINT::default()),
            COLORREF(0),
            Some(&blend),
            ULW_ALPHA,
        );
        SelectObject(dc, previous);
        let _ = DeleteDC(dc);
        let _ = DeleteObject(bitmap.into());
        result.map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "linux")]
pub(super) fn present(window: &dyn Window, frame: Frame) -> Result<(), String> {
    use gtk4::{gdk, glib, prelude::*};
    use winit::platform::gtk4::WindowExtGtk4;

    let window = window.gtk_window().ok_or("Missing GTK companion window")?;
    let area = window
        .child()
        .and_then(|layout| layout.last_child())
        .and_downcast::<gtk4::Box>()
        .ok_or("Missing GTK companion content area")?;
    let picture = area
        .first_child()
        .and_downcast::<gtk4::Picture>()
        .unwrap_or_else(|| {
            let picture = gtk4::Picture::new();
            picture.set_can_target(false);
            picture.set_can_shrink(true);
            picture.set_content_fit(gtk4::ContentFit::Fill);
            picture.set_hexpand(true);
            picture.set_vexpand(true);
            area.append(&picture);
            picture
        });
    let texture = gdk::MemoryTexture::new(
        frame.width,
        frame.height,
        gdk::MemoryFormat::B8g8r8a8Premultiplied,
        &glib::Bytes::from_owned(frame.pixels),
        frame.width as usize * 4,
    );
    picture.set_paintable(Some(&texture));
    Ok(())
}
