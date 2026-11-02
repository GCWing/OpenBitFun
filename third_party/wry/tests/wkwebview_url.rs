// A native main-thread harness is required for WKWebView; libtest runs tests
// on worker threads even with --test-threads=1.
#[cfg(target_os = "macos")]
fn main() {
  use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::{Duration, Instant},
  };

  use objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSRunLoop};
  use tao::{event_loop::EventLoop, window::WindowBuilder};
  use wry::{Error, NavigationState, PageLoadEvent, WebViewBuilder, WebViewExtMacOS};

  let event_loop = EventLoop::new();
  let window = WindowBuilder::new()
    .with_visible(false)
    .build(&event_loop)
    .unwrap();
  let loaded = Rc::new(Cell::new(false));
  let loaded_callback = loaded.clone();
  let webview = WebViewBuilder::new()
    .with_incognito(true)
    .with_on_page_load_handler(move |event, url| {
      if matches!(event, PageLoadEvent::Finished) {
        assert_eq!(url, "about:blank");
        loaded_callback.set(true);
      }
    })
    .build(&window)
    .unwrap();

  // A newly created native view has no URL. This used to panic on the main
  // thread instead of returning through the public Result API.
  assert!(matches!(webview.url(), Err(Error::UrlUnavailable)));

  // A valid blank document remains a valid URL, including in page-load events.
  // No external website, persistent browser profile or user data is involved.
  webview.load_url("about:blank").unwrap();
  let deadline = Instant::now() + Duration::from_secs(10);
  while !loaded.get() {
    assert!(
      Instant::now() < deadline,
      "blank document did not finish loading"
    );
    unsafe {
      NSRunLoop::mainRunLoop().runMode_beforeDate(
        NSDefaultRunLoopMode,
        &NSDate::dateWithTimeIntervalSinceNow(0.01),
      );
    }
  }
  assert_eq!(webview.url().unwrap(), "about:blank");

  let states = Rc::new(RefCell::new(Vec::new()));
  let observed = states.clone();
  webview
    .webview()
    .set_navigation_state_handler(move |state| observed.borrow_mut().push(state));
  assert_eq!(states.borrow().last(), Some(&NavigationState::Finished));

  // A closed loopback port fails before document commit, without contacting a
  // website or using the user's network configuration or persistent profile.
  let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
  let url = format!("http://{}/", listener.local_addr().unwrap());
  drop(listener);
  webview.load_url(&url).unwrap();
  let deadline = Instant::now() + Duration::from_secs(10);
  while !matches!(states.borrow().last(), Some(NavigationState::Failed { .. })) {
    assert!(
      Instant::now() < deadline,
      "navigation failure was not delivered"
    );
    unsafe {
      NSRunLoop::mainRunLoop().runMode_beforeDate(
        NSDefaultRunLoopMode,
        &NSDate::dateWithTimeIntervalSinceNow(0.01),
      );
    }
  }
  assert!(states.borrow().contains(&NavigationState::Loading));
  let failure = states.borrow().last().unwrap().clone();
  let observed = states.clone();
  webview
    .webview()
    .set_navigation_state_handler(move |state| observed.borrow_mut().push(state));
  assert_eq!(states.borrow().last(), Some(&failure));

  // An intentional stop must not surface as a failed page. Keep a loopback
  // request pending without serving a response, then stop it through WebKit.
  let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
  states.borrow_mut().clear();
  webview
    .load_url(&format!("http://{}/", listener.local_addr().unwrap()))
    .unwrap();
  let deadline = Instant::now() + Duration::from_secs(10);
  while states.borrow().last() != Some(&NavigationState::Loading) {
    assert!(
      Instant::now() < deadline,
      "pending navigation did not start"
    );
    unsafe {
      NSRunLoop::mainRunLoop().runMode_beforeDate(
        NSDefaultRunLoopMode,
        &NSDate::dateWithTimeIntervalSinceNow(0.01),
      );
    }
  }
  unsafe {
    webview.webview().stopLoading();
  }
  let deadline = Instant::now() + Duration::from_secs(10);
  while states.borrow().last() == Some(&NavigationState::Loading) {
    assert!(Instant::now() < deadline, "intentional stop did not settle");
    unsafe {
      NSRunLoop::mainRunLoop().runMode_beforeDate(
        NSDefaultRunLoopMode,
        &NSDate::dateWithTimeIntervalSinceNow(0.01),
      );
    }
  }
  assert!(!states
    .borrow()
    .iter()
    .any(|state| matches!(state, NavigationState::Failed { .. })));
  assert_eq!(
    states.borrow().last(),
    Some(&NavigationState::Cancelled),
    "an intentional stop must settle the pending navigation"
  );
  drop(listener);

  // Recovery is an explicit new navigation, never an automatic reload.
  loaded.set(false);
  webview.load_url("about:blank").unwrap();
  let deadline = Instant::now() + Duration::from_secs(10);
  while !loaded.get() {
    assert!(
      Instant::now() < deadline,
      "manual navigation did not recover"
    );
    unsafe {
      NSRunLoop::mainRunLoop().runMode_beforeDate(
        NSDefaultRunLoopMode,
        &NSDate::dateWithTimeIntervalSinceNow(0.01),
      );
    }
  }
  assert_eq!(states.borrow().last(), Some(&NavigationState::Finished));
  println!("WKWebView regression passed: unavailable URL, navigation failure, late observation, intentional stop and explicit recovery");
}

#[cfg(not(target_os = "macos"))]
fn main() {
  println!("WKWebView URL regression skipped: requires macOS");
}
