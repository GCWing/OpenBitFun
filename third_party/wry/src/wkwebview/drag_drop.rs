// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::path::PathBuf;

use objc2::{
  runtime::{AnyObject, Bool, ProtocolObject},
  ClassType, DeclaredClass,
};
use objc2_app_kit::{
  NSDragOperation, NSDraggingInfo, NSPasteboard, NSPasteboardURLReadingFileURLsOnlyKey,
};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSPoint, NSRect, NSURL};

use crate::DragDropEvent;

use super::WryWebView;

pub(crate) fn collect_paths(drag_info: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<PathBuf> {
  pasteboard_paths(&drag_info.draggingPasteboard())
}

fn pasteboard_paths(pb: &NSPasteboard) -> Vec<PathBuf> {
  let classes = NSArray::from_slice(&[NSURL::class()]);
  let options = NSDictionary::<_, AnyObject>::from_slices(
    &[unsafe { NSPasteboardURLReadingFileURLsOnlyKey }],
    &[&*NSNumber::numberWithBool(true)],
  );
  // SAFETY: NSURL implements NSPasteboardReading and this option takes an NSNumber boolean.
  let Some(urls) = (unsafe { pb.readObjectsForClasses_options(&classes, Some(&options)) }) else {
    return Vec::new();
  };
  urls
    .iter()
    .filter_map(|object| object.downcast::<NSURL>().ok())
    .filter_map(|url| url.path())
    .map(|path| PathBuf::from(path.to_string()))
    .collect()
}

// Tauri's file listener accepts every event, including empty path lists. Let
// WebKit own non-file gestures at every phase so it can deliver HTML dragover
// and drop, and preserve the source's operation (Move, Link or None).
fn route_drag<T>(paths: &[PathBuf], file: impl FnOnce() -> T, webkit: impl FnOnce() -> T) -> T {
  if paths.is_empty() {
    webkit()
  } else {
    file()
  }
}

pub(crate) fn dragging_entered(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
  let paths = collect_paths(drag_info);
  let dl: NSPoint = drag_info.draggingLocation();
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let webkit = || unsafe { objc2::msg_send![super(this), draggingEntered: drag_info] };
  route_drag(
    &paths,
    || {
      let listener = &this.ivars().drag_drop_handler;
      if listener(DragDropEvent::Enter {
        paths: paths.clone(),
        position,
      }) {
        NSDragOperation::Copy
      } else {
        webkit()
      }
    },
    webkit,
  )
}

pub(crate) fn dragging_updated(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
  let dl: NSPoint = drag_info.draggingLocation();
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let paths = collect_paths(drag_info);
  let webkit = || unsafe { objc2::msg_send![super(this), draggingUpdated: drag_info] };
  route_drag(
    &paths,
    || {
      let listener = &this.ivars().drag_drop_handler;
      if listener(DragDropEvent::Over { position }) {
        NSDragOperation::Copy
      } else {
        let operation = webkit();
        // Preserve the existing file-drop fallback outside an HTML file input.
        if operation == NSDragOperation::None {
          NSDragOperation::Copy
        } else {
          operation
        }
      }
    },
    webkit,
  )
}

pub(crate) fn perform_drag_operation(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> Bool {
  let paths = collect_paths(drag_info);
  let dl: NSPoint = drag_info.draggingLocation();
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let webkit = || unsafe { objc2::msg_send![super(this), performDragOperation: drag_info] };
  route_drag(
    &paths,
    || {
      let listener = &this.ivars().drag_drop_handler;
      if listener(DragDropEvent::Drop {
        paths: paths.clone(),
        position,
      }) {
        Bool::YES
      } else {
        webkit()
      }
    },
    webkit,
  )
}

pub(crate) fn dragging_exited(this: &WryWebView, drag_info: &ProtocolObject<dyn NSDraggingInfo>) {
  let paths = collect_paths(drag_info);
  let webkit = || unsafe { objc2::msg_send![super(this), draggingExited: drag_info] };
  route_drag(
    &paths,
    || {
      if !(this.ivars().drag_drop_handler)(DragDropEvent::Leave) {
        webkit()
      }
    },
    webkit,
  )
}

#[cfg(test)]
mod tests {
  use super::*;
  use objc2_app_kit::NSPasteboardTypeString;
  use objc2_foundation::{ns_string, NSString};
  use std::cell::Cell;

  #[test]
  fn file_url_pasteboard_preserves_multiple_paths_and_ignores_web_urls() {
    let pb = NSPasteboard::pasteboardWithUniqueName();
    let first_path = "/tmp/drop #100% \u{6587}\u{4ef6}.txt";
    let second_path = "/tmp/drop folder";
    let first = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(first_path), false);
    let second = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(second_path), true);
    let web = NSURL::URLWithString(ns_string!("https://example.com/drag")).unwrap();
    let objects = NSArray::from_slice(&[
      ProtocolObject::from_ref(&*first),
      ProtocolObject::from_ref(&*web),
      ProtocolObject::from_ref(&*second),
    ]);
    assert!(pb.writeObjects(&objects));
    assert_eq!(
      pasteboard_paths(&pb),
      [PathBuf::from(first_path), PathBuf::from(second_path)]
    );
    pb.clearContents();
  }

  #[test]
  fn empty_text_and_web_pasteboards_remain_non_file_drags() {
    let pb = NSPasteboard::pasteboardWithUniqueName();
    assert!(pasteboard_paths(&pb).is_empty());
    assert!(pb.setString_forType(ns_string!("tab payload"), unsafe { NSPasteboardTypeString }));
    assert!(pasteboard_paths(&pb).is_empty());
    pb.clearContents();
    let web = NSURL::URLWithString(ns_string!("https://example.com/drag")).unwrap();
    assert!(pb.writeObjects(&NSArray::arrayWithObject(ProtocolObject::from_ref(&*web))));
    assert!(pasteboard_paths(&pb).is_empty());
    pb.clearContents();
  }

  #[test]
  fn legacy_filename_pasteboard_remains_readable() {
    let pb = NSPasteboard::pasteboardWithUniqueName();
    // Construct the old wire format without using the deprecated AppKit symbol.
    let legacy_type = ns_string!("NSFilenamesPboardType");
    let paths = NSArray::from_slice(&[
      ns_string!("/tmp/legacy file.txt"),
      ns_string!("/tmp/folder"),
    ]);
    unsafe {
      pb.declareTypes_owner(&NSArray::arrayWithObject(legacy_type), None);
      assert!(pb.setPropertyList_forType(&paths, legacy_type));
    }
    assert_eq!(
      pasteboard_paths(&pb),
      [
        PathBuf::from("/tmp/legacy file.txt"),
        PathBuf::from("/tmp/folder")
      ]
    );
    pb.clearContents();
  }

  #[test]
  fn html_drag_reaches_webkit_even_when_the_native_file_receiver_accepts_everything() {
    let native_calls = Cell::new(0);
    let webkit_calls = Cell::new(0);
    // Enter, repeated over and exit must preserve WebKit's negotiated operation,
    // including rejection. An unconditional Copy is the original regression.
    for expected in [
      NSDragOperation::Move,
      NSDragOperation::Move,
      NSDragOperation::None,
    ] {
      let actual = route_drag(
        &[],
        || {
          native_calls.set(native_calls.get() + 1);
          NSDragOperation::Copy
        },
        || {
          webkit_calls.set(webkit_calls.get() + 1);
          expected
        },
      );
      assert_eq!(actual, expected);
    }
    for accepted in [Bool::YES, Bool::NO] {
      assert_eq!(
        route_drag(
          &[],
          || {
            native_calls.set(native_calls.get() + 1);
            Bool::YES
          },
          || accepted
        ),
        accepted
      );
    }
    route_drag(&[], || native_calls.set(native_calls.get() + 1), || ());
    assert_eq!(native_calls.get(), 0);
    assert_eq!(webkit_calls.get(), 3);
  }

  #[test]
  fn finder_file_drag_keeps_the_native_receiver_and_original_paths() {
    let paths = [PathBuf::from("/tmp/drag fixture.txt")];
    let native_calls = Cell::new(0);
    for _ in 0..3 {
      let operation = route_drag(
        &paths,
        || {
          native_calls.set(native_calls.get() + 1);
          NSDragOperation::Copy
        },
        || panic!("native file receiver must retain ownership"),
      );
      assert_eq!(operation, NSDragOperation::Copy);
    }
    assert_eq!(route_drag(&paths, || Bool::YES, || Bool::NO), Bool::YES);
    route_drag(
      &paths,
      || native_calls.set(native_calls.get() + 1),
      || panic!("file exit"),
    );
    assert_eq!(native_calls.get(), 4);
    assert_eq!(paths[0], PathBuf::from("/tmp/drag fixture.txt"));
  }
}
