use std::sync::atomic::{AtomicBool, Ordering};

// Fail closed until the config layer applies the saved preference (#3213):
// sensitive diagnostics are opt-in everywhere else (config default, UI copy).
static INCLUDE_SENSITIVE_DIAGNOSTICS: AtomicBool = AtomicBool::new(false);

pub fn set_include_sensitive_diagnostics(enabled: bool) {
    INCLUDE_SENSITIVE_DIAGNOSTICS.store(enabled, Ordering::Relaxed);
}

pub fn include_sensitive_diagnostics() -> bool {
    INCLUDE_SENSITIVE_DIAGNOSTICS.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::{include_sensitive_diagnostics, set_include_sensitive_diagnostics};

    #[test]
    fn sensitive_diagnostics_can_be_toggled() {
        set_include_sensitive_diagnostics(true);
        assert!(include_sensitive_diagnostics());

        set_include_sensitive_diagnostics(false);
        assert!(!include_sensitive_diagnostics());

        set_include_sensitive_diagnostics(true);
    }
}
