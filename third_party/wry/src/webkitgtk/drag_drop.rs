// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{cell::Cell, path::PathBuf, rc::Rc};

use gtk::{gdk, glib::GString, prelude::*};
use webkit2gtk::WebView;

use crate::DragDropEvent;

/// The only target this handler claims. Internal application drags never offer
/// it, so claiming it keeps WebKit's DOM drag-and-drop in charge of everything
/// else (tab moves, context pills, text selection).
const URI_LIST_TARGET: &str = "text/uri-list";

#[derive(PartialEq, Eq, PartialOrd, Ord, Clone, Copy, Debug)]
enum DragControllerState {
  Entered,
  Leaving,
  Left,
}

struct DragDropController {
  paths: Cell<Option<Vec<PathBuf>>>,
  state: Cell<DragControllerState>,
  position: Cell<(i32, i32)>,
  /// Whether the URI list has already been requested for the current drag.
  data_requested: Cell<bool>,
  /// Drop timestamp captured by `drag-drop` before the data reply arrives.
  drop_time: Cell<Option<u32>>,
  handler: Box<dyn Fn(DragDropEvent) -> bool>,
}

impl DragDropController {
  fn new(handler: Box<dyn Fn(DragDropEvent) -> bool>) -> Self {
    Self {
      handler,
      paths: Cell::new(None),
      state: Cell::new(DragControllerState::Left),
      position: Cell::new((0, 0)),
      data_requested: Cell::new(false),
      drop_time: Cell::new(None),
    }
  }

  fn store_paths(&self, paths: Vec<PathBuf>) {
    self.paths.set(Some(paths));
  }

  fn take_paths(&self) -> Option<Vec<PathBuf>> {
    self.paths.take()
  }

  fn store_position(&self, position: (i32, i32)) {
    self.position.set(position);
  }

  fn position(&self) -> (i32, i32) {
    self.position.get()
  }

  fn enter(&self) {
    self.state.set(DragControllerState::Entered);
  }

  fn leaving(&self) {
    self.state.set(DragControllerState::Leaving);
  }

  fn leave(&self) {
    self.state.set(DragControllerState::Left);
  }

  fn state(&self) -> DragControllerState {
    self.state.get()
  }

  fn request_data(&self) -> bool {
    if self.data_requested.get() {
      false
    } else {
      self.data_requested.set(true);
      true
    }
  }

  fn set_drop_time(&self, time: u32) {
    self.drop_time.set(Some(time));
  }

  fn take_drop_time(&self) -> Option<u32> {
    self.drop_time.take()
  }

  /// Clears per-drag bookkeeping. Paths stay until the next `Enter` replaces
  /// them so a drop that races the data reply can still resolve them.
  fn reset_for_next_drag(&self) {
    self.data_requested.set(false);
    self.drop_time.set(None);
  }

  fn call(&self, event: DragDropEvent) -> bool {
    (self.handler)(event)
  }
}

fn uri_list_atom() -> gdk::Atom {
  gdk::Atom::intern(URI_LIST_TARGET)
}

/// Only OS file drags publish a URI list. Everything else is left to WebKit.
fn offers_files(ctx: &gdk::DragContext) -> bool {
  let target = uri_list_atom();
  ctx.list_targets().iter().any(|atom| *atom == target)
}

pub(crate) fn connect_drag_event(webview: &WebView, handler: Box<dyn Fn(DragDropEvent) -> bool>) {
  let controller = Rc::new(DragDropController::new(handler));

  {
    let controller = controller.clone();
    webview.connect_drag_motion(move |webview, ctx, x, y, time| {
      if !offers_files(ctx) {
        return false;
      }

      // Claim the drag so the URI list reaches this handler: WebKit's DOM
      // drag-and-drop cannot expose filesystem paths, and letting it handle the
      // drop would discard the files.
      ctx.drag_status(gdk::DragAction::COPY, time);
      controller.store_position((x, y));

      if controller.state() == DragControllerState::Entered {
        controller.call(DragDropEvent::Over { position: (x, y) });
      } else if controller.request_data() {
        // WebKit never asks for the URI list by itself, so no
        // `drag-data-received` would ever arrive without this request.
        webview.drag_get_data(ctx, &uri_list_atom(), time);
      }

      true
    });
  }

  {
    let controller = controller.clone();
    webview.connect_drag_data_received(move |_, ctx, x, y, data, _info, _time| {
      if data.target() != uri_list_atom() {
        return;
      }

      let paths = data
        .uris()
        .iter()
        .filter_map(|uri| path_buf_from_uri(uri))
        .collect::<Vec<_>>();

      if paths.is_empty() {
        // A URL or text drag that happens to advertise a URI list carries no
        // file path; finish it without inventing an attachment.
        if let Some(drop_time) = controller.take_drop_time() {
          ctx.drop_finish(false, drop_time);
          controller.leave();
        }
        return;
      }

      if let Some(drop_time) = controller.take_drop_time() {
        ctx.drop_finish(true, drop_time);
        controller.leave();
        controller.call(DragDropEvent::Drop {
          paths,
          position: (x, y),
        });
        return;
      }

      let first_enter = controller.state() != DragControllerState::Entered;
      controller.enter();
      controller.store_paths(paths.clone());
      if first_enter {
        controller.call(DragDropEvent::Enter {
          paths,
          position: controller.position(),
        });
      }
    });
  }

  {
    let controller = controller.clone();
    webview.connect_drag_drop(move |webview, ctx, x, y, time| {
      if !offers_files(ctx) {
        return false;
      }

      controller.store_position((x, y));

      if let Some(paths) = controller.take_paths() {
        ctx.drop_finish(true, time);
        controller.leave();
        return controller.call(DragDropEvent::Drop {
          paths,
          position: (x, y),
        });
      }

      // The URI list has not arrived yet: keep the drag alive and emit `Drop`
      // from `drag-data-received`.
      controller.set_drop_time(time);
      if controller.request_data() {
        webview.drag_get_data(ctx, &uri_list_atom(), time);
      }
      true
    });
  }

  webview.connect_drag_leave(move |_webview, ctx, _time| {
    if controller.state() == DragControllerState::Left {
      return;
    }

    // A drop waiting for its data reply can never complete once the drag left.
    if let Some(drop_time) = controller.take_drop_time() {
      ctx.drop_finish(false, drop_time);
    }

    let was_entered = controller.state() == DragControllerState::Entered;
    controller.leaving();
    controller.reset_for_next_drag();

    let controller = controller.clone();
    gtk::glib::idle_add_local_once(move || {
      if controller.state() == DragControllerState::Leaving {
        controller.leave();
        controller.take_paths();
        if was_entered {
          controller.call(DragDropEvent::Leave);
        }
      }
    });
  });
}

/// Decodes a `file://` URI into a filesystem path.
///
/// Non-file URIs (web links, application-specific schemes) are rejected so a
/// link drag cannot be turned into a bogus attachment path.
fn path_buf_from_uri(gstr: &GString) -> Option<PathBuf> {
  let path = gstr.as_str();
  let path = path.strip_prefix("file://")?;
  let path = percent_encoding::percent_decode(path.as_bytes())
    .decode_utf8_lossy()
    .to_string();
  Some(PathBuf::from(path))
}
