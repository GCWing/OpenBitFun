fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rerun-if-changed=src/computer_use/linux_native.c");
        let mut build = cc::Build::new();
        for library in ["gstreamer-1.0", "gstreamer-app-1.0", "tesseract", "lept"] {
            // Headers only: runtime libraries remain optional and are dlopened
            // at the capture/OCR boundary, never when the CLI starts.
            let headers = pkg_config::Config::new()
                .cargo_metadata(false)
                .probe(library)
                .unwrap_or_else(|error| {
                    panic!("Missing Computer Use build headers for {library}: {error}")
                });
            build.includes(headers.include_paths);
        }
        build
            .file("src/computer_use/linux_native.c")
            .std("gnu11")
            .warnings(true)
            .compile("computer_use_linux");
        println!("cargo:rustc-link-lib=dl");
    }

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-changed=src/computer_use/pointer_motion.h");
        println!("cargo:rerun-if-changed=src/computer_use/pointer_motion.c");
        cc::Build::new()
            .file("src/computer_use/pointer_motion.c")
            .std("c11")
            .compile("computer_use_pointer_motion");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=src/computer_use/macos_capture.m");
        println!("cargo:rerun-if-changed=src/computer_use/pointer_motion.h");
        cc::Build::new()
            .file("src/computer_use/macos_capture.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("computer_use_capture");
        // Older macOS installs must reach the runtime unsupported-version guard.
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
        for framework in [
            "CoreMedia",
            "CoreVideo",
            "CoreImage",
            "AppKit",
            "ApplicationServices",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
}
