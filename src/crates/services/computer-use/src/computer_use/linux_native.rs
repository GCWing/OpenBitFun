//! Safe ownership boundary for the optional, vendor-header-checked C adapters.
use std::{
    ffi::{c_char, c_void, CStr, CString},
    sync::Arc,
    time::Duration,
};

unsafe extern "C" {
    fn obf_gst_init(error: *mut c_char, size: usize) -> i32;
    fn obf_gst_has_factory(name: *const c_char) -> i32;
    fn obf_gst_start(
        description: *const c_char,
        serial: *const c_char,
        error: *mut c_char,
        size: usize,
    ) -> *mut c_void;
    fn obf_gst_release(pipeline: *mut c_void);
    fn obf_gst_stop(pipeline: *mut c_void) -> i32;
    fn obf_gst_ended(pipeline: *mut c_void) -> i32;
    fn obf_gst_frame(
        pipeline: *mut c_void,
        timeout: u64,
        last: i32,
        bytes: *mut *mut u8,
        length: *mut usize,
        width: *mut i32,
        height: *mut i32,
        error: *mut c_char,
        size: usize,
    ) -> i32;
    fn obf_native_free(bytes: *mut c_void);
    fn obf_tess_read(
        image: *const u8,
        length: usize,
        words: i32,
        error: *mut c_char,
        size: usize,
    ) -> *mut Ocr;
    fn obf_tess_release(result: *mut Ocr);
}

fn message(error: &[c_char]) -> String {
    // Every C function writes a bounded, NUL-terminated message on failure.
    unsafe { CStr::from_ptr(error.as_ptr()) }
        .to_string_lossy()
        .into_owned()
}

pub(super) fn init_capture() -> Result<(), String> {
    let mut error = [0; 512];
    if unsafe { obf_gst_init(error.as_mut_ptr(), error.len()) } == 0 {
        return Err(format!("[CAPTURE_UNAVAILABLE] {}", message(&error)));
    }
    for name in [c"pipewiresrc", c"videoconvert", c"jpegenc", c"appsink"] {
        if unsafe { obf_gst_has_factory(name.as_ptr()) } == 0 {
            return Err(format!("[CAPTURE_UNAVAILABLE] Missing GStreamer plugin {}; install gstreamer1.0-pipewire, gstreamer1.0-plugins-base and gstreamer1.0-plugins-good.", name.to_string_lossy()));
        }
    }
    Ok(())
}

struct PipelineInner(*mut c_void);
// GStreamer permits concurrent state, bus and appsink operations. Arc retains
// the complete object graph until the last observer/Stop operation returns.
unsafe impl Send for PipelineInner {}
unsafe impl Sync for PipelineInner {}
impl Drop for PipelineInner {
    fn drop(&mut self) {
        unsafe { obf_gst_release(self.0) };
    }
}
#[derive(Clone)]
pub(super) struct Pipeline(Arc<PipelineInner>);
pub(super) struct Frame {
    pub bytes: Vec<u8>,
    pub width: i32,
    pub height: i32,
}
impl Frame {
    pub(super) fn dimensions(&self) -> u64 {
        ((self.width as u64) << 32) | self.height as u64
    }
}
impl Pipeline {
    pub(super) fn start(description: &str, serial: Option<u64>) -> Result<Self, String> {
        let description =
            CString::new(description).map_err(|_| "[CAPTURE_UNAVAILABLE] Invalid pipeline")?;
        let serial = serial.map(|serial| CString::new(serial.to_string()).unwrap());
        let mut error = [0; 512];
        let pipeline = unsafe {
            obf_gst_start(
                description.as_ptr(),
                serial.as_ref().map_or(std::ptr::null(), |s| s.as_ptr()),
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if pipeline.is_null() {
            return Err(format!("[CAPTURE_UNAVAILABLE] {}", message(&error)));
        }
        Ok(Self(Arc::new(PipelineInner(pipeline))))
    }
    pub(super) fn stop(&self) -> Result<(), String> {
        if unsafe { obf_gst_stop(self.0 .0) } != 0 {
            Ok(())
        } else {
            Err("[CAPTURE_STOP_FAILED] Cannot stop the native stream".into())
        }
    }
    pub(super) async fn ended(&self) {
        loop {
            if unsafe { obf_gst_ended(self.0 .0) } != 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    pub(super) fn pull(&self, timeout: Duration) -> Result<Option<Frame>, String> {
        self.frame(timeout, false)
    }
    pub(super) fn last(&self) -> Result<Option<Frame>, String> {
        self.frame(Duration::ZERO, true)
    }
    fn frame(&self, timeout: Duration, last: bool) -> Result<Option<Frame>, String> {
        let (mut bytes, mut length, mut width, mut height) = (std::ptr::null_mut(), 0, 0, 0);
        let mut error = [0; 512];
        let status = unsafe {
            obf_gst_frame(
                self.0 .0,
                timeout.as_nanos().min(u64::MAX as u128) as u64,
                i32::from(last),
                &mut bytes,
                &mut length,
                &mut width,
                &mut height,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        match status {
            0 => Ok(None),
            1 => {
                // The shim guarantees a nonempty bounded allocation on status 1.
                let data = unsafe { std::slice::from_raw_parts(bytes, length) }.to_vec();
                unsafe { obf_native_free(bytes.cast()) };
                Ok(Some(Frame {
                    bytes: data,
                    width,
                    height,
                }))
            }
            _ => Err(format!("[CAPTURE_INVALID_FRAME] {}", message(&error))),
        }
    }
}

#[repr(C)]
struct OcrWord {
    text: *mut c_char,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    confidence: i32,
}
#[repr(C)]
struct Ocr {
    tsv: *mut c_char,
    words: *mut OcrWord,
    count: usize,
}
struct OcrOwner(*mut Ocr);
impl Drop for OcrOwner {
    fn drop(&mut self) {
        unsafe { obf_tess_release(self.0) };
    }
}
pub(super) struct RecognizedWord {
    pub text: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub confidence: f32,
}
pub(super) struct Recognition {
    pub tsv: String,
    pub words: Vec<RecognizedWord>,
    pub region_count: usize,
}
pub(super) fn recognize(image: &[u8], words: bool) -> Result<Recognition, String> {
    let mut error = [0; 512];
    let raw = unsafe {
        obf_tess_read(
            image.as_ptr(),
            image.len(),
            i32::from(words),
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if raw.is_null() {
        return Err(format!("[OCR_UNAVAILABLE] {}", message(&error)));
    }
    let _owner = OcrOwner(raw);
    let result = unsafe { &*raw };
    let mut output = Recognition {
        tsv: String::new(),
        words: Vec::new(),
        region_count: result.count,
    };
    let text = |value| {
        unsafe { CStr::from_ptr(value) }
            .to_str()
            .map(str::to_owned)
            .map_err(|_| "[OCR_INVALID_TEXT] Invalid UTF-8 from Tesseract".to_owned())
    };
    if !result.tsv.is_null() {
        output.tsv = text(result.tsv)?;
    }
    if !result.words.is_null() {
        for word in unsafe { std::slice::from_raw_parts(result.words, result.count) } {
            if word.text.is_null() {
                continue;
            }
            output.words.push(RecognizedWord {
                text: text(word.text)?,
                x: word.x,
                y: word.y,
                width: word.width,
                height: word.height,
                confidence: word.confidence as f32 / 100.0,
            });
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    // A disposable generated stream tests the actual dlopen/C adapter without
    // a screen, portal consent, or user content. Optional system packages required.
    #[test]
    #[ignore = "requires the Linux GStreamer runtime and base/good plugins"]
    fn native_generated_stream_captures_and_stops() {
        let pipeline = Pipeline::start("videotestsrc num-buffers=4 ! video/x-raw,width=160,height=90 ! jpegenc ! appsink name=frames max-buffers=1 drop=true sync=false", None).unwrap();
        let frame = pipeline.pull(Duration::from_secs(5)).unwrap().unwrap();
        assert_eq!((frame.width, frame.height), (160, 90));
        assert_eq!(image::load_from_memory(&frame.bytes).unwrap().width(), 160);
        assert_eq!(
            pipeline.last().unwrap().unwrap().dimensions(),
            frame.dimensions()
        );
        pipeline.stop().unwrap();
        assert!(pipeline.pull(Duration::ZERO).unwrap().is_none());
    }
}
