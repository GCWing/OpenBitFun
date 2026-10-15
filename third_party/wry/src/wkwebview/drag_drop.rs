// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{ffi::CStr, path::PathBuf};

use objc2::{
  runtime::{Bool, ProtocolObject},
  DeclaredClass,
};
use objc2_app_kit::{NSDragOperation, NSDraggingInfo, NSFilenamesPboardType};
use objc2_foundation::{NSArray, NSPoint, NSRect, NSString};

use crate::DragDropEvent;

use super::WryWebView;

pub(crate) unsafe fn collect_paths(drag_info: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<PathBuf> {
  let pb = drag_info.draggingPasteboard();
  let mut drag_drop_paths = Vec::new();
  let types = NSArray::arrayWithObject(NSFilenamesPboardType);

  if pb.availableTypeFromArray(&types).is_some() {
    let paths = pb.propertyListForType(NSFilenamesPboardType).unwrap();
    let paths = paths.downcast::<NSArray>().unwrap();
    for path in paths {
      let path = path.downcast::<NSString>().unwrap();
      let path = CStr::from_ptr(path.UTF8String()).to_string_lossy();
      drag_drop_paths.push(PathBuf::from(path.into_owned()));
    }
  }
  drag_drop_paths
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
  let paths = unsafe { collect_paths(drag_info) };
  let dl: NSPoint = unsafe { drag_info.draggingLocation() };
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
  let dl: NSPoint = unsafe { drag_info.draggingLocation() };
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let paths = unsafe { collect_paths(drag_info) };
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
  let paths = unsafe { collect_paths(drag_info) };
  let dl: NSPoint = unsafe { drag_info.draggingLocation() };
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
  let paths = unsafe { collect_paths(drag_info) };
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
  use std::cell::Cell;

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
