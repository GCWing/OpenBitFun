use once_cell::sync::Lazy;
/// Theme and style definitions
use std::collections::{HashMap, HashSet};
use std::io::IsTerminal;
use std::time::{Duration, Instant};

use ratatui::style::{Color, Modifier, Style};

#[cfg(unix)]
use std::io::Read;

#[derive(Debug, Clone)]
pub(crate) struct Theme {
    pub(super) primary: Color,
    pub(super) success: Color,
    pub(super) warning: Color,
    pub(super) error: Color,
    pub(super) info: Color,
    pub(super) muted: Color,
    pub(super) background: Color,
    pub(super) border: Color,

    // Panel backgrounds (inspired by opencode theme)
    pub(super) background_panel: Color,
    pub(super) background_element: Color,
    pub(super) input_background: Color,

    // Diff colors
    pub(super) diff_added_fg: Color,
    pub(super) diff_removed_fg: Color,
    pub(super) diff_added_bg: Color,
    pub(super) diff_removed_bg: Color,

    // Block card colors
    pub(super) block_bg: Color,
    pub(super) block_bg_hover: Color,
    pub(super) block_border_active: Color,

    // Inline tool icon color
    pub(super) inline_icon: Color,

    // Command text color (for bash $ prefix)
    pub(super) command_text: Color,

    // Diff hunk header and line number colors
    pub(super) diff_hunk_header: Color,
    pub(super) diff_line_number: Color,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EffectiveColorScheme {
    Truecolor,
    Ansi16,
    Monochrome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Appearance {
    Dark,
    Light,
}

impl Appearance {
    pub(crate) fn is_light(self) -> bool {
        matches!(self, Appearance::Light)
    }
}

pub(crate) fn resolve_effective_color_scheme(preference: &str) -> EffectiveColorScheme {
    if std::env::var_os("NO_COLOR").is_some() {
        return EffectiveColorScheme::Monochrome;
    }
    if matches!(std::env::var("CLICOLOR").ok().as_deref(), Some("0")) {
        return EffectiveColorScheme::Monochrome;
    }

    match preference.trim().to_ascii_lowercase().as_str() {
        "mono" | "monochrome" | "nocolor" | "no_color" => EffectiveColorScheme::Monochrome,
        "ansi" | "ansi16" => EffectiveColorScheme::Ansi16,
        "truecolor" | "24bit" => EffectiveColorScheme::Truecolor,
        _ => {
            if terminal_supports_truecolor() {
                EffectiveColorScheme::Truecolor
            } else {
                EffectiveColorScheme::Ansi16
            }
        }
    }
}

fn terminal_supports_truecolor() -> bool {
    if !std::io::stdout().is_terminal() {
        return false;
    }

    let term = std::env::var("TERM")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if term.is_empty() || term == "dumb" {
        return false;
    }

    let term_program = std::env::var("TERM_PROGRAM")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if term_program == "apple_terminal" {
        return false;
    }

    let colorterm = std::env::var("COLORTERM")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if colorterm.contains("truecolor") || colorterm.contains("24bit") {
        return true;
    }

    // Many terminals expose truecolor capability via TERM_PROGRAM.
    // Apple Terminal historically lacks reliable 24-bit support across versions/configurations,
    // so we keep detection conservative and prefer ANSI16 in ambiguous cases.
    if term_program == "iterm.app"
        || term_program == "wezterm"
        || term_program == "vscode"
        || term_program == "ghostty"
    {
        return true;
    }

    // Some terminals encode truecolor as "-direct" terminfo.
    if term.contains("-direct") || term.contains("xterm-kitty") {
        return true;
    }

    false
}

pub(crate) fn resolve_appearance(preference: &str) -> Appearance {
    match preference.trim().to_ascii_lowercase().as_str() {
        "light" => Appearance::Light,
        "auto" => {
            detect_terminal_appearance(Duration::from_millis(250)).unwrap_or(Appearance::Dark)
        }
        _ => Appearance::Dark,
    }
}

fn detect_terminal_appearance(timeout: Duration) -> Option<Appearance> {
    if std::env::var_os("NO_COLOR").is_some() {
        return None;
    }
    if !std::io::stdout().is_terminal() || !std::io::stdin().is_terminal() {
        return None;
    }

    // OSC 11 query: request default background color.
    // Response typically looks like:
    //   ESC ] 11 ; rgb:RRRR/GGGG/BBBB BEL
    // or:
    //   ESC ] 11 ; #RRGGBB BEL
    use std::io::Write;

    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(b"\x1b]11;?\x07");
    let _ = stdout.flush();

    let start = Instant::now();

    // Read from stdin in non-blocking mode (Unix-only best-effort).
    #[cfg(unix)]
    {
        let mut buf = Vec::with_capacity(256);
        use std::os::fd::AsRawFd;

        let fd = std::io::stdin().as_raw_fd();
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            if flags < 0 {
                return None;
            }
            if libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
                return None;
            }

            let mut stdin = std::io::stdin().lock();
            let mut tmp = [0u8; 256];
            while start.elapsed() < timeout {
                match stdin.read(&mut tmp) {
                    Ok(0) => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Ok(n) => {
                        buf.extend_from_slice(&tmp[..n]);
                        if buf.contains(&b'\x07') {
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }

            let _ = libc::fcntl(fd, libc::F_SETFL, flags);
        }

        let s = String::from_utf8_lossy(&buf);
        let prefix = "\u{1b}]11;";
        let idx = s.find(prefix)?;
        let rest = &s[idx + prefix.len()..];
        let end = rest.find('\u{7}').unwrap_or(rest.len());
        let color = rest[..end].trim();

        let (r, g, b) = parse_osc_color(color)?;
        let lum = (0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64) / 255.0;
        Some(if lum > 0.5 {
            Appearance::Light
        } else {
            Appearance::Dark
        })
    }

    #[cfg(not(unix))]
    {
        let _ = (start, timeout);
        None
    }
}

#[cfg(unix)]
fn parse_osc_color(s: &str) -> Option<(u8, u8, u8)> {
    if let Some(hex) = s.strip_prefix('#') {
        if hex.len() == 6 {
            let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
            let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
            let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
            return Some((r, g, b));
        }
    }

    if let Some(rgb) = s.strip_prefix("rgb:") {
        let parts: Vec<&str> = rgb.split('/').collect();
        if parts.len() == 3 {
            let r16 = u16::from_str_radix(parts[0], 16).ok()?;
            let g16 = u16::from_str_radix(parts[1], 16).ok()?;
            let b16 = u16::from_str_radix(parts[2], 16).ok()?;
            return Some(((r16 >> 8) as u8, (g16 >> 8) as u8, (b16 >> 8) as u8));
        }
    }

    if let Some(rgb) = s.strip_prefix("rgb(").and_then(|t| t.strip_suffix(')')) {
        let parts: Vec<&str> = rgb.split(',').map(|p| p.trim()).collect();
        if parts.len() == 3 {
            let r = parts[0].parse::<u8>().ok()?;
            let g = parts[1].parse::<u8>().ok()?;
            let b = parts[2].parse::<u8>().ok()?;
            return Some((r, g, b));
        }
    }

    None
}

impl Theme {
    pub(crate) fn dark() -> Self {
        Self::from_builtin_preset("openbitfun-dark", Appearance::Dark)
    }

    pub(crate) fn dark_ansi16() -> Self {
        Self {
            primary: Color::Blue,
            success: Color::Green,
            warning: Color::Yellow,
            error: Color::Red,
            info: Color::Cyan,
            muted: Color::DarkGray,
            background: Color::Reset,
            border: Color::DarkGray,

            background_panel: Color::Reset,
            background_element: Color::Reset,
            input_background: Color::Reset,

            diff_added_fg: Color::Green,
            diff_removed_fg: Color::Red,
            diff_added_bg: Color::Reset,
            diff_removed_bg: Color::Reset,

            block_bg: Color::Reset,
            block_bg_hover: Color::Reset,
            block_border_active: Color::Blue,

            inline_icon: Color::Blue,

            command_text: Color::Cyan,

            diff_hunk_header: Color::Magenta,
            diff_line_number: Color::DarkGray,
        }
    }

    pub(crate) fn light() -> Self {
        Self::from_builtin_preset("openbitfun-light", Appearance::Light)
    }

    pub(crate) fn light_ansi16() -> Self {
        Self {
            primary: Color::Blue,
            success: Color::Green,
            warning: Color::Yellow,
            error: Color::Red,
            info: Color::Cyan,
            muted: Color::DarkGray,
            background: Color::Reset,
            border: Color::DarkGray,

            background_panel: Color::Reset,
            background_element: Color::Reset,
            input_background: Color::Reset,

            diff_added_fg: Color::Green,
            diff_removed_fg: Color::Red,
            diff_added_bg: Color::Reset,
            diff_removed_bg: Color::Reset,

            block_bg: Color::Reset,
            block_bg_hover: Color::Reset,
            block_border_active: Color::Blue,

            inline_icon: Color::Blue,

            command_text: Color::Blue,

            diff_hunk_header: Color::Magenta,
            diff_line_number: Color::DarkGray,
        }
    }

    pub(crate) fn monochrome() -> Self {
        Self {
            primary: Color::Reset,
            success: Color::Reset,
            warning: Color::Reset,
            error: Color::Reset,
            info: Color::Reset,
            muted: Color::Reset,
            background: Color::Reset,
            border: Color::Reset,

            background_panel: Color::Reset,
            background_element: Color::Reset,
            input_background: Color::Reset,

            diff_added_fg: Color::Reset,
            diff_removed_fg: Color::Reset,
            diff_added_bg: Color::Reset,
            diff_removed_bg: Color::Reset,

            block_bg: Color::Reset,
            block_bg_hover: Color::Reset,
            block_border_active: Color::Reset,

            inline_icon: Color::Reset,

            command_text: Color::Reset,

            diff_hunk_header: Color::Reset,
            diff_line_number: Color::Reset,
        }
    }

    pub(crate) fn with_effective_scheme(mut self, scheme: EffectiveColorScheme) -> Self {
        match scheme {
            EffectiveColorScheme::Truecolor => self,
            EffectiveColorScheme::Monochrome => Theme::monochrome(),
            EffectiveColorScheme::Ansi16 => {
                self.primary = to_ansi16(self.primary);
                self.success = to_ansi16(self.success);
                self.warning = to_ansi16(self.warning);
                self.error = to_ansi16(self.error);
                self.info = to_ansi16(self.info);
                self.muted = to_ansi16(self.muted);
                self.background = to_ansi16(self.background);
                self.border = to_ansi16(self.border);
                self.background_panel = to_ansi16(self.background_panel);
                self.background_element = to_ansi16(self.background_element);
                // Keep the startup input panel as the preset-defined RGB color.
                // Otherwise subtle dark theme variants collapse to the same ANSI black/blue.
                self.diff_added_fg = to_ansi16(self.diff_added_fg);
                self.diff_removed_fg = to_ansi16(self.diff_removed_fg);
                self.diff_added_bg = to_ansi16(self.diff_added_bg);
                self.diff_removed_bg = to_ansi16(self.diff_removed_bg);
                self.block_bg = to_ansi16(self.block_bg);
                self.block_bg_hover = to_ansi16(self.block_bg_hover);
                self.block_border_active = to_ansi16(self.block_border_active);
                self.inline_icon = to_ansi16(self.inline_icon);
                self.command_text = to_ansi16(self.command_text);
                self.diff_hunk_header = to_ansi16(self.diff_hunk_header);
                self.diff_line_number = to_ansi16(self.diff_line_number);
                self
            }
        }
    }

    pub(crate) fn apply_opencode_theme_json(
        &self,
        json: &OpencodeThemeJson,
        appearance: Appearance,
    ) -> anyhow::Result<Self> {
        let fallback = self.clone();
        let resolved = resolve_opencode_theme(json, appearance)?;
        build_theme_from_resolved_tokens(resolved, Some(&fallback))
    }

    pub(super) fn style(&self, kind: StyleKind) -> Style {
        match kind {
            StyleKind::Primary => Style::default().fg(self.primary),
            StyleKind::Success => Style::default().fg(self.success),
            StyleKind::Warning => Style::default().fg(self.warning),
            StyleKind::Error => Style::default().fg(self.error),
            StyleKind::Info => Style::default().fg(self.info),
            StyleKind::Muted => Style::default().fg(self.muted),
            StyleKind::Title => Style::default()
                .fg(self.primary)
                .add_modifier(Modifier::BOLD),
            StyleKind::Border => Style::default().fg(self.border),
            StyleKind::DiffAdded => Style::default()
                .fg(self.diff_added_fg)
                .bg(self.diff_added_bg),
            StyleKind::DiffRemoved => Style::default()
                .fg(self.diff_removed_fg)
                .bg(self.diff_removed_bg),
            StyleKind::BlockBackground => Style::default().bg(self.block_bg),
            StyleKind::BlockBackgroundHover => Style::default().bg(self.block_bg_hover),
            StyleKind::BlockBorderActive => Style::default().fg(self.block_border_active),
            StyleKind::InlineIcon => Style::default().fg(self.inline_icon),
            StyleKind::CommandText => Style::default().fg(self.command_text),
            StyleKind::DiffHunkHeader => Style::default().fg(self.diff_hunk_header),
            StyleKind::DiffLineNumber => Style::default().fg(self.diff_line_number),
        }
    }

    pub(super) fn selection_foreground(&self) -> Color {
        readable_foreground_for(self.primary)
    }

    fn from_builtin_preset(id: &'static str, appearance: Appearance) -> Self {
        let json = builtin_theme_json(id)
            .unwrap_or_else(|| panic!("Built-in CLI theme {id} must be registered"));
        Self::from_complete_opencode_theme_json(json, appearance)
            .unwrap_or_else(|err| panic!("Built-in CLI theme {id} must be complete: {err}"))
    }

    fn from_complete_opencode_theme_json(
        json: &OpencodeThemeJson,
        appearance: Appearance,
    ) -> anyhow::Result<Self> {
        let resolved = resolve_opencode_theme(json, appearance)?;
        build_theme_from_resolved_tokens(resolved, None)
    }
}

fn build_theme_from_resolved_tokens(
    resolved: ResolvedTokens,
    fallback: Option<&Theme>,
) -> anyhow::Result<Theme> {
    fn pick(name: &str, value: Option<Color>, fallback: Option<Color>) -> anyhow::Result<Color> {
        value
            .or(fallback)
            .ok_or_else(|| anyhow::anyhow!("CLI theme missing required color \"{}\"", name))
    }

    let fallback_color = |select: fn(&Theme) -> Color| fallback.map(select);
    macro_rules! pick_field {
        ($field:ident, $name:literal) => {
            pick($name, resolved.$field, fallback_color(|theme| theme.$field))?
        };
    }

    Ok(Theme {
        primary: pick_field!(primary, "primary"),
        success: pick_field!(success, "success"),
        warning: pick_field!(warning, "warning"),
        error: pick_field!(error, "error"),
        info: pick_field!(info, "info"),
        muted: pick_field!(muted, "textMuted"),
        background: pick_field!(background, "background"),
        border: pick_field!(border, "border"),
        background_panel: pick_field!(background_panel, "backgroundPanel"),
        background_element: pick_field!(background_element, "backgroundElement"),
        input_background: pick(
            "inputBackground",
            resolved.input_background.or(resolved.background_element),
            fallback_color(|theme| theme.input_background),
        )?,
        diff_added_fg: pick_field!(diff_added_fg, "diffAdded"),
        diff_removed_fg: pick_field!(diff_removed_fg, "diffRemoved"),
        diff_added_bg: pick_field!(diff_added_bg, "diffAddedBg"),
        diff_removed_bg: pick_field!(diff_removed_bg, "diffRemovedBg"),
        block_bg: pick_field!(block_bg, "backgroundPanel"),
        block_bg_hover: pick_field!(block_bg_hover, "backgroundElement"),
        block_border_active: pick_field!(block_border_active, "borderActive"),
        inline_icon: pick_field!(inline_icon, "accent"),
        command_text: pick_field!(command_text, "primary"),
        diff_hunk_header: pick_field!(diff_hunk_header, "diffHunkHeader"),
        diff_line_number: pick_field!(diff_line_number, "diffLineNumber"),
    })
}

fn readable_foreground_for(background: Color) -> Color {
    match background {
        Color::Reset => Color::Reset,
        Color::Black
        | Color::Red
        | Color::Green
        | Color::Blue
        | Color::Magenta
        | Color::DarkGray => Color::White,
        Color::Yellow
        | Color::Gray
        | Color::LightRed
        | Color::LightGreen
        | Color::LightYellow
        | Color::LightBlue
        | Color::LightMagenta
        | Color::LightCyan
        | Color::White
        | Color::Cyan => Color::Black,
        Color::Indexed(idx) => readable_foreground_for(idx_to_ansi16(idx)),
        Color::Rgb(r, g, b) => {
            let lum = relative_luminance(r, g, b);
            if lum > 0.36 {
                Color::Black
            } else {
                Color::White
            }
        }
    }
}

fn relative_luminance(r: u8, g: u8, b: u8) -> f64 {
    fn channel(v: u8) -> f64 {
        let v = v as f64 / 255.0;
        if v <= 0.03928 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    }

    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

fn to_ansi16(c: Color) -> Color {
    match c {
        Color::Reset => Color::Reset,
        Color::Black
        | Color::Red
        | Color::Green
        | Color::Yellow
        | Color::Blue
        | Color::Magenta
        | Color::Cyan
        | Color::Gray
        | Color::DarkGray
        | Color::LightRed
        | Color::LightGreen
        | Color::LightYellow
        | Color::LightBlue
        | Color::LightMagenta
        | Color::LightCyan
        | Color::White => c,
        Color::Indexed(idx) => idx_to_ansi16(idx),
        Color::Rgb(r, g, b) => rgb_to_ansi16(r, g, b),
    }
}

fn idx_to_ansi16(idx: u8) -> Color {
    // Basic mapping for 0-15.
    match idx {
        0 => Color::Black,
        1 => Color::Red,
        2 => Color::Green,
        3 => Color::Yellow,
        4 => Color::Blue,
        5 => Color::Magenta,
        6 => Color::Cyan,
        7 => Color::Gray,
        8 => Color::DarkGray,
        9 => Color::LightRed,
        10 => Color::LightGreen,
        11 => Color::LightYellow,
        12 => Color::LightBlue,
        13 => Color::LightMagenta,
        14 => Color::LightCyan,
        15 => Color::White,
        _ => Color::Gray,
    }
}

fn rgb_to_ansi16(r: u8, g: u8, b: u8) -> Color {
    // Simple luminance+dominant-channel approximation.
    let lum = (0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64) / 255.0;
    if lum < 0.08 {
        return Color::Black;
    }
    if lum > 0.92 {
        return Color::White;
    }

    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let sat = (max - min) as f64 / 255.0;
    let bright = lum > 0.6;

    if sat < 0.18 {
        return if bright { Color::Gray } else { Color::DarkGray };
    }

    let is_r = r == max;
    let is_g = g == max;
    let is_b = b == max;

    match (is_r, is_g, is_b, bright) {
        (true, true, false, false) => Color::Yellow,
        (true, true, false, true) => Color::LightYellow,
        (true, false, true, false) => Color::Magenta,
        (true, false, true, true) => Color::LightMagenta,
        (false, true, true, false) => Color::Cyan,
        (false, true, true, true) => Color::LightCyan,
        (true, false, false, false) => Color::Red,
        (true, false, false, true) => Color::LightRed,
        (false, true, false, false) => Color::Green,
        (false, true, false, true) => Color::LightGreen,
        (false, false, true, false) => Color::Blue,
        (false, false, true, true) => Color::LightBlue,
        _ => Color::Gray,
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) enum StyleKind {
    Primary,
    Success,
    Warning,
    Error,
    Info,
    Muted,
    Title,
    Border,
    DiffAdded,
    DiffRemoved,
    BlockBackground,
    BlockBackgroundHover,
    BlockBorderActive,
    InlineIcon,
    CommandText,
    DiffHunkHeader,
    DiffLineNumber,
}

/// Tool icon mapping — Unicode symbols inspired by opencode TUI
pub(super) fn tool_icon(tool_name: &str) -> &'static str {
    match tool_name {
        "Bash" | "bash_tool" | "run_terminal_cmd" => "$",
        "Read" | "read_file" | "read_file_tool" => "\u{2192}", // →
        "Write" | "write_file" | "write_file_tool" => "\u{2190}", // ←
        "Edit" | "search_replace" => "\u{2190}",               // ←
        "Delete" => "\u{00d7}",                                // ×
        "Grep" | "grep" => "\u{2731}",                         // ✱
        "Glob" | "codebase_search" => "\u{2731}",              // ✱
        "LS" | "list_dir" | "ls" => "\u{2192}",                // →
        "WebFetch" => "%",
        "WebSearch" => "\u{25c8}", // ◈
        "Task" | "AgentSpawn" => "#",
        "HmosCompilation" => "\u{2692}",
        "TodoWrite" => "\u{2699}", // ⚙
        "Skill" => "\u{2192}",     // →
        "Git" => "\u{2387}",       // ⎇
        "AskUserQuestion" => "?",
        "CreatePlan" => "\u{25b6}",                       // ▶
        "ReadLints" => "\u{25b3}",                        // △
        "GetFileDiff" => "\u{00b1}",                      // ±
        "IdeControl" => "\u{2318}",                       // ⌘
        "MermaidInteractive" => "\u{25c7}",               // ◇
        "ContextCompression" => "\u{21af}",               // ↯
        "AnalyzeImage" => "\u{25a3}",                     // ▣
        _ if tool_name.starts_with("mcp_") => "\u{2261}", // ≡
        _ => "\u{00b7}",                                  // ·
    }
}

// ======================= opencode-compatible theme.json =======================

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct OpencodeThemeJson {
    #[serde(rename = "$schema")]
    _schema: Option<String>,
    defs: Option<HashMap<String, ColorValueJson>>,
    theme: HashMap<String, ColorValueJson>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(untagged)]
enum ColorValueJson {
    Number(u8),
    String(String),
    Variant {
        dark: Box<ColorValueJson>,
        light: Box<ColorValueJson>,
    },
}

static BUILTIN_OPENCODE_THEMES: Lazy<HashMap<&'static str, OpencodeThemeJson>> = Lazy::new(|| {
    fn parse(id: &'static str, raw: &'static str) -> (&'static str, OpencodeThemeJson) {
        let json = serde_json::from_str::<OpencodeThemeJson>(raw)
            .unwrap_or_else(|e| panic!("Failed to parse built-in theme {}: {}", id, e));
        (id, json)
    }

    HashMap::from([
        parse(
            "openbitfun-cyber",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/themes/presets/openbitfun-cyber.json"
            )),
        ),
        parse(
            "openbitfun-dark",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/themes/presets/openbitfun-dark.json"
            )),
        ),
        parse(
            "openbitfun-ink-night",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/themes/presets/openbitfun-ink-night.json"
            )),
        ),
        parse(
            "openbitfun-light",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/themes/presets/openbitfun-light.json"
            )),
        ),
        parse(
            "openbitfun-midnight",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/themes/presets/openbitfun-midnight.json"
            )),
        ),
        parse(
            "openbitfun-tokyo-night",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/themes/presets/openbitfun-tokyo-night.json"
            )),
        ),
    ])
});

pub(crate) fn builtin_theme_ids() -> Vec<String> {
    let mut ids: Vec<String> = BUILTIN_OPENCODE_THEMES
        .keys()
        .map(|k| (*k).to_string())
        .collect();
    ids.sort_by_cached_key(|id| id.to_ascii_lowercase());
    ids
}

pub(crate) fn builtin_theme_json(id: &str) -> Option<&'static OpencodeThemeJson> {
    BUILTIN_OPENCODE_THEMES.get(id)
}

#[derive(Debug, Default)]
struct ResolvedTokens {
    primary: Option<Color>,
    success: Option<Color>,
    warning: Option<Color>,
    error: Option<Color>,
    info: Option<Color>,
    muted: Option<Color>,
    background: Option<Color>,
    border: Option<Color>,
    background_panel: Option<Color>,
    background_element: Option<Color>,
    input_background: Option<Color>,
    diff_added_fg: Option<Color>,
    diff_removed_fg: Option<Color>,
    diff_added_bg: Option<Color>,
    diff_removed_bg: Option<Color>,
    block_bg: Option<Color>,
    block_bg_hover: Option<Color>,
    block_border_active: Option<Color>,
    inline_icon: Option<Color>,
    command_text: Option<Color>,
    diff_hunk_header: Option<Color>,
    diff_line_number: Option<Color>,
}

fn resolve_opencode_theme(
    json: &OpencodeThemeJson,
    appearance: Appearance,
) -> anyhow::Result<ResolvedTokens> {
    let mode = if appearance.is_light() {
        "light"
    } else {
        "dark"
    };
    let defs = json.defs.clone().unwrap_or_default();

    let mut tokens = ResolvedTokens::default();

    tokens.primary = resolve_key(json, &defs, "primary", mode)?;
    tokens.success = resolve_key(json, &defs, "success", mode)?;
    tokens.warning = resolve_key(json, &defs, "warning", mode)?;
    tokens.error = resolve_key(json, &defs, "error", mode)?;
    tokens.info = resolve_key(json, &defs, "info", mode)?;
    tokens.muted = resolve_key(json, &defs, "textMuted", mode)?;
    tokens.background = resolve_key(json, &defs, "background", mode)?;
    tokens.border = resolve_key(json, &defs, "border", mode)?;
    tokens.background_panel = resolve_key(json, &defs, "backgroundPanel", mode)?;
    tokens.background_element = resolve_key(json, &defs, "backgroundElement", mode)?;
    tokens.input_background = resolve_key(json, &defs, "inputBackground", mode)?;

    tokens.diff_added_fg = resolve_key(json, &defs, "diffAdded", mode)?;
    tokens.diff_removed_fg = resolve_key(json, &defs, "diffRemoved", mode)?;
    tokens.diff_added_bg = resolve_key(json, &defs, "diffAddedBg", mode)?;
    tokens.diff_removed_bg = resolve_key(json, &defs, "diffRemovedBg", mode)?;

    tokens.block_bg = tokens.background_panel;
    tokens.block_bg_hover = tokens.background_element;

    tokens.block_border_active = resolve_key(json, &defs, "borderActive", mode)?.or(tokens.primary);
    tokens.inline_icon = resolve_key(json, &defs, "accent", mode)?.or(tokens.primary);
    tokens.command_text = tokens.primary;
    tokens.diff_hunk_header = resolve_key(json, &defs, "diffHunkHeader", mode)?;
    tokens.diff_line_number = resolve_key(json, &defs, "diffLineNumber", mode)?;

    Ok(tokens)
}

fn resolve_key(
    json: &OpencodeThemeJson,
    defs: &HashMap<String, ColorValueJson>,
    key: &str,
    mode: &str,
) -> anyhow::Result<Option<Color>> {
    let Some(v) = json.theme.get(key) else {
        return Ok(None);
    };
    let mut seen = HashSet::<String>::new();
    Ok(Some(resolve_color_value(json, defs, v, mode, &mut seen)?))
}

fn resolve_color_value(
    json: &OpencodeThemeJson,
    defs: &HashMap<String, ColorValueJson>,
    v: &ColorValueJson,
    mode: &str,
    seen: &mut HashSet<String>,
) -> anyhow::Result<Color> {
    match v {
        ColorValueJson::Number(n) => Ok(Color::Indexed(*n)),
        ColorValueJson::Variant { dark, light } => {
            if mode == "light" {
                resolve_color_value(json, defs, light, mode, seen)
            } else {
                resolve_color_value(json, defs, dark, mode, seen)
            }
        }
        ColorValueJson::String(s) => resolve_color_string(json, defs, s, mode, seen),
    }
}

fn resolve_color_string(
    json: &OpencodeThemeJson,
    defs: &HashMap<String, ColorValueJson>,
    s: &str,
    mode: &str,
    seen: &mut HashSet<String>,
) -> anyhow::Result<Color> {
    let t = s.trim();
    if t.eq_ignore_ascii_case("none") || t.eq_ignore_ascii_case("transparent") {
        return Ok(Color::Reset);
    }

    if let Some(hex) = t.strip_prefix('#') {
        if hex.len() == 6 {
            let r = u8::from_str_radix(&hex[0..2], 16)?;
            let g = u8::from_str_radix(&hex[2..4], 16)?;
            let b = u8::from_str_radix(&hex[4..6], 16)?;
            return Ok(Color::Rgb(r, g, b));
        } else if hex.len() == 8 {
            let r = u8::from_str_radix(&hex[0..2], 16)?;
            let g = u8::from_str_radix(&hex[2..4], 16)?;
            let b = u8::from_str_radix(&hex[4..6], 16)?;
            let a = u8::from_str_radix(&hex[6..8], 16)?;
            let base = if mode == "light" { 255 } else { 0 };
            return Ok(Color::Rgb(
                blend_alpha_channel(r, a, base),
                blend_alpha_channel(g, a, base),
                blend_alpha_channel(b, a, base),
            ));
        }
    }

    // Reference resolution: defs first, then theme keys.
    if !seen.insert(t.to_string()) {
        anyhow::bail!("Theme color reference cycle detected at \"{}\"", t);
    }

    if let Some(v) = defs.get(t) {
        return resolve_color_value(json, defs, v, mode, seen);
    }
    if let Some(v) = json.theme.get(t) {
        return resolve_color_value(json, defs, v, mode, seen);
    }

    anyhow::bail!("Theme color reference \"{}\" not found", t)
}

fn blend_alpha_channel(fg: u8, alpha: u8, bg: u8) -> u8 {
    let fg = fg as u16;
    let alpha = alpha as u16;
    let bg = bg as u16;
    (((fg * alpha) + (bg * (255 - alpha)) + 127) / 255) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_theme_ids_are_case_insensitive_ascending() {
        let ids = builtin_theme_ids();

        assert!(ids
            .windows(2)
            .all(|pair| pair[0].to_ascii_lowercase() <= pair[1].to_ascii_lowercase()));
    }

    #[test]
    fn builtin_themes_resolve_for_dark_and_light() {
        for id in builtin_theme_ids() {
            let json = builtin_theme_json(&id).expect("built-in theme id should resolve");
            Theme::dark()
                .apply_opencode_theme_json(json, Appearance::Dark)
                .unwrap_or_else(|err| panic!("failed to resolve dark theme {id}: {err}"));
            Theme::light()
                .apply_opencode_theme_json(json, Appearance::Light)
                .unwrap_or_else(|err| panic!("failed to resolve light theme {id}: {err}"));
        }
    }

    #[test]
    fn truecolor_defaults_are_backed_by_builtin_presets() {
        let dark = Theme::dark();
        let light = Theme::light();

        assert_eq!(dark.primary, Color::Rgb(96, 165, 250));
        assert_eq!(dark.command_text, dark.primary);
        assert_eq!(dark.background, Color::Rgb(14, 14, 16));
        assert_eq!(dark.background_panel, Color::Rgb(28, 28, 31));
        assert_eq!(dark.diff_line_number, Color::Rgb(133, 133, 133));
        assert_eq!(light.primary, Color::Rgb(71, 85, 105));
        assert_eq!(light.command_text, light.primary);
        assert_eq!(light.background, Color::Rgb(243, 243, 245));
        assert_eq!(light.background_panel, Color::Rgb(255, 255, 255));
        assert_eq!(light.warning, Color::Rgb(154, 101, 31));
        assert_eq!(light.diff_added_fg, Color::Rgb(63, 125, 84));
        assert_eq!(light.diff_removed_fg, Color::Rgb(159, 68, 68));
        assert_eq!(light.diff_line_number, Color::Rgb(100, 116, 139));
    }

    #[test]
    fn truecolor_defaults_keep_cli_surface_contrast() {
        let dark = Theme::dark();
        let light = Theme::light();

        for (label, fg, bg, min_ratio) in [
            ("dark primary", dark.primary, dark.background, 4.5),
            ("dark success", dark.success, dark.background, 4.5),
            ("dark warning", dark.warning, dark.background, 4.5),
            ("dark error", dark.error, dark.background, 4.5),
            ("dark muted", dark.muted, dark.background, 4.5),
            ("dark command", dark.command_text, dark.background, 4.5),
            ("dark command block", dark.command_text, dark.block_bg, 4.5),
            (
                "dark command block hover",
                dark.command_text,
                dark.block_bg_hover,
                4.5,
            ),
            (
                "dark diff line number",
                dark.diff_line_number,
                dark.background_panel,
                3.0,
            ),
            (
                "dark diff added",
                dark.diff_added_fg,
                dark.diff_added_bg,
                3.0,
            ),
            (
                "dark diff removed",
                dark.diff_removed_fg,
                dark.diff_removed_bg,
                3.0,
            ),
            ("light primary", light.primary, light.background, 4.5),
            ("light warning", light.warning, light.background, 4.0),
            ("light error", light.error, light.background, 3.0),
            ("light muted", light.muted, light.background, 4.0),
            ("light command", light.command_text, light.background, 4.0),
            (
                "light command block",
                light.command_text,
                light.block_bg,
                4.5,
            ),
            (
                "light command block hover",
                light.command_text,
                light.block_bg_hover,
                4.5,
            ),
            (
                "light diff line number",
                light.diff_line_number,
                light.background_panel,
                4.5,
            ),
            (
                "light diff added",
                light.diff_added_fg,
                light.diff_added_bg,
                4.0,
            ),
            (
                "light diff removed",
                light.diff_removed_fg,
                light.diff_removed_bg,
                4.0,
            ),
        ] {
            assert_contrast_at_least(label, fg, bg, min_ratio);
        }
    }

    #[test]
    fn partial_opencode_theme_json_keeps_base_theme_fallbacks() {
        let json = serde_json::from_str::<OpencodeThemeJson>(
            r##"{
                "theme": {
                    "primary": "#14b8a6"
                }
            }"##,
        )
        .unwrap();
        let base = Theme::dark();
        let resolved = base
            .apply_opencode_theme_json(&json, Appearance::Dark)
            .unwrap();

        assert_eq!(resolved.primary, Color::Rgb(20, 184, 166));
        assert_eq!(resolved.command_text, resolved.primary);
        assert_eq!(resolved.success, base.success);
        assert_eq!(resolved.background, base.background);
        assert_eq!(resolved.input_background, base.input_background);
    }

    #[test]
    fn eight_digit_hex_colors_are_supported() {
        let json = serde_json::from_str::<OpencodeThemeJson>(
            r##"{
                "theme": {
                    "primary": { "dark": "#ffffff80", "light": "#00000080" }
                }
            }"##,
        )
        .unwrap();

        let dark = Theme::dark()
            .apply_opencode_theme_json(&json, Appearance::Dark)
            .unwrap();
        let light = Theme::light()
            .apply_opencode_theme_json(&json, Appearance::Light)
            .unwrap();

        assert_eq!(dark.primary, Color::Rgb(128, 128, 128));
        assert_eq!(light.primary, Color::Rgb(127, 127, 127));
    }

    fn assert_contrast_at_least(label: &str, fg: Color, bg: Color, min_ratio: f64) {
        let ratio = contrast_ratio(fg, bg);
        assert!(
            ratio >= min_ratio,
            "{label} contrast {ratio:.2} is below {min_ratio:.2}"
        );
    }

    fn contrast_ratio(fg: Color, bg: Color) -> f64 {
        let fg = relative_luminance(fg);
        let bg = relative_luminance(bg);
        let lighter = fg.max(bg);
        let darker = fg.min(bg);
        (lighter + 0.05) / (darker + 0.05)
    }

    fn relative_luminance(color: Color) -> f64 {
        let (r, g, b) = match color {
            Color::Rgb(r, g, b) => (r, g, b),
            other => panic!("contrast test requires RGB color, got {other:?}"),
        };
        0.2126 * linear_rgb(r) + 0.7152 * linear_rgb(g) + 0.0722 * linear_rgb(b)
    }

    fn linear_rgb(channel: u8) -> f64 {
        let channel = f64::from(channel) / 255.0;
        if channel <= 0.04045 {
            channel / 12.92
        } else {
            ((channel + 0.055) / 1.055).powf(2.4)
        }
    }
}
