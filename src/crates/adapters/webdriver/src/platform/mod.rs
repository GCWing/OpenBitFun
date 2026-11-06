mod capture;
mod devtools;
pub(crate) mod evaluator;
mod image;
mod types;

pub use capture::{print_page, take_screenshot};
pub use devtools::call_devtools;
pub use image::crop_screenshot;
pub use types::{Cookie, ElementScreenshotMetadata, PrintOptions, WindowRect};
