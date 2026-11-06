use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;
use tauri_runtime_cef::cef;
use tokio::sync::watch;

const MAX_PIXELS: usize = 24_000_000;
const DAMAGE_HISTORY: usize = 24;
const FRAME_MAGIC: u32 = 0x3152_534f;
const COMPRESSED_FRAME_MAGIC: u32 = 0x3352_534f;
const FRAME_HEADER_BYTES: usize = 52;
const MIN_COMPRESSED_PATCH_BYTES: usize = 256 * 1024;
const VIEWPORT_HISTORY: usize = 32;

#[derive(Clone, Copy, PartialEq)]
struct PaintViewport {
    logical: (i32, i32),
    scale: f32,
}

#[derive(Default)]
pub(super) struct ViewportHistory(VecDeque<PaintViewport>);

impl ViewportHistory {
    pub(super) fn requested(&mut self, logical: (i32, i32), scale: f32) {
        let viewport = PaintViewport { logical, scale };
        if self.0.back() == Some(&viewport) {
            return;
        }
        self.0.push_back(viewport);
        if self.0.len() > VIEWPORT_HISTORY {
            self.0.pop_front();
        }
    }

    pub(super) fn painted(&mut self, physical: (i32, i32), scale: f32) -> Option<(i32, i32)> {
        // Chromium can still be painting an earlier requested size while the
        // panel is moving. Match the frame to the size it was painted for.
        let index = self.0.iter().rposition(|viewport| {
            let (width, height) = viewport.logical;
            viewport.scale == scale
                && physical
                    == (
                        (width as f32 * scale).ceil() as i32,
                        (height as f32 * scale).ceil() as i32,
                    )
        })?;
        self.0.drain(..index);
        self.0.front().map(|viewport| viewport.logical)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Area {
    left: usize,
    top: usize,
    right: usize,
    bottom: usize,
}

impl Area {
    fn full(width: usize, height: usize) -> Self {
        Self {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        }
    }

    fn intersect(self, other: Self) -> Self {
        let left = self.left.max(other.left);
        let top = self.top.max(other.top);
        Self {
            left,
            top,
            right: self.right.min(other.right).max(left),
            bottom: self.bottom.min(other.bottom).max(top),
        }
    }

    fn union(self, other: Self) -> Self {
        if self.is_empty() {
            return other;
        }
        if other.is_empty() {
            return self;
        }
        Self {
            left: self.left.min(other.left),
            top: self.top.min(other.top),
            right: self.right.max(other.right),
            bottom: self.bottom.max(other.bottom),
        }
    }

    fn from_cef(rect: &cef::Rect) -> Self {
        Self {
            left: rect.x.max(0) as usize,
            top: rect.y.max(0) as usize,
            right: rect.x.saturating_add(rect.width.max(0)).max(0) as usize,
            bottom: rect.y.saturating_add(rect.height.max(0)).max(0) as usize,
        }
    }

    fn is_empty(self) -> bool {
        self.left >= self.right || self.top >= self.bottom
    }
}

pub(super) fn frame_byte_len(width: i32, height: i32) -> Option<usize> {
    let pixels = usize::try_from(width)
        .ok()?
        .checked_mul(usize::try_from(height).ok()?)?;
    (pixels > 0 && pixels <= MAX_PIXELS).then_some(pixels * 4)
}

#[derive(Default)]
struct Surface {
    width: usize,
    height: usize,
    pixels: Vec<u8>,
}

impl Surface {
    fn area(&self) -> Area {
        Area::full(self.width, self.height)
    }

    fn changed_area(&self, pixels: &[u8]) -> Area {
        const TILE_WIDTH: usize = 64;
        let stride = self.width * 4;
        let rows = self
            .pixels
            .chunks_exact(stride)
            .zip(pixels.chunks_exact(stride));
        let mut damage = Area {
            left: self.width,
            top: self.height,
            right: 0,
            bottom: 0,
        };
        for (y, (previous, next)) in rows.enumerate() {
            if previous == next {
                continue;
            }
            damage.top = damage.top.min(y);
            damage.bottom = y + 1;
            // Scan only outside the horizontal area already marked dirty.
            // Tile comparisons keep large same-size paints on slice memcmp.
            let tiles = previous
                .chunks(TILE_WIDTH * 4)
                .zip(next.chunks(TILE_WIDTH * 4));
            if let Some(tile) = tiles
                .clone()
                .take(damage.left.div_ceil(TILE_WIDTH))
                .position(|(old, new)| old != new)
            {
                damage.left = damage.left.min(tile * TILE_WIDTH);
            }
            if let Some(tile) = tiles
                .enumerate()
                .rev()
                .take_while(|(tile, _)| (tile + 1) * TILE_WIDTH > damage.right)
                .find_map(|(tile, (old, new))| (old != new).then_some(tile))
            {
                damage.right = ((tile + 1) * TILE_WIDTH).min(self.width);
            }
        }
        if damage.is_empty() {
            Area::default()
        } else {
            damage
        }
    }

    fn update(&mut self, width: usize, height: usize, pixels: &[u8], dirty: &[cef::Rect]) -> Area {
        if (self.width, self.height) != (width, height) {
            self.width = width;
            self.height = height;
            self.pixels.clear();
            self.pixels.extend_from_slice(pixels);
            return self.area();
        }
        let area = self.area();
        if dirty.is_empty()
            || (dirty.len() == 1 && Area::from_cef(&dirty[0]).intersect(area) == area)
        {
            let damage = self.changed_area(pixels);
            if !damage.is_empty() {
                self.pixels.copy_from_slice(pixels);
            }
            return damage;
        }
        let mut damage = Area::default();
        for rect in dirty {
            let rect = Area::from_cef(rect).intersect(area);
            if rect.is_empty() {
                continue;
            }
            for y in rect.top..rect.bottom {
                let row = (y * width + rect.left) * 4..(y * width + rect.right) * 4;
                self.pixels[row.clone()].copy_from_slice(&pixels[row]);
            }
            damage = damage.union(rect);
        }
        damage
    }
}

#[derive(Default)]
struct State {
    view: Surface,
    logical: (i32, i32),
    popup: Surface,
    popup_origin: Option<(i32, i32)>,
    popup_visible: bool,
    revision: u32,
    damage: VecDeque<(u32, Area)>,
    cursor: u32,
    caret: Option<(i32, i32)>,
    panel_origin: Option<(i32, i32)>,
}

impl State {
    fn popup_area(&self) -> Area {
        match self
            .popup_origin
            .filter(|_| self.popup_visible && !self.popup.pixels.is_empty())
        {
            Some((x, y)) => Area::from_cef(&cef::Rect {
                x,
                y,
                width: self.popup.width as i32,
                height: self.popup.height as i32,
            })
            .intersect(self.view.area()),
            None => Area::default(),
        }
    }

    fn payload(&self, after: u32, protocol: u8) -> Option<Vec<u8>> {
        if self.view.pixels.is_empty() || after == self.revision {
            return None;
        }
        let full = self.view.area();
        let consecutive = after != 0
            && after < self.revision
            && self
                .damage
                .front()
                .is_some_and(|(revision, _)| after >= revision.saturating_sub(1));
        let area = if protocol < 2 || !consecutive {
            full
        } else {
            self.damage
                .iter()
                .filter(|(revision, _)| *revision > after)
                .fold(Area::default(), |area, (_, dirty)| area.union(*dirty))
                .intersect(full)
        };
        let width = area.right - area.left;
        let height = area.bottom - area.top;
        let mut bytes = Vec::with_capacity(52 + width * height * 4);
        if protocol >= 2 {
            bytes.extend_from_slice(&FRAME_MAGIC.to_le_bytes());
        }
        for value in [
            self.revision,
            self.view.width as u32,
            self.view.height as u32,
            self.logical.0 as u32,
            self.logical.1 as u32,
        ] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        if protocol >= 2 {
            let (x, y) = self.caret.unwrap_or((-1, -1));
            for value in [
                area.left as u32,
                area.top as u32,
                width as u32,
                height as u32,
                self.cursor,
                x as u32,
                y as u32,
            ] {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }

        let popup = self.popup_area().intersect(area);
        if popup.is_empty() && area.left == 0 && area.right == self.view.width {
            let stride = self.view.width * 4;
            bytes.extend_from_slice(&self.view.pixels[area.top * stride..area.bottom * stride]);
            return Some(bytes);
        }
        for y in area.top..area.bottom {
            let offset = bytes.len();
            let start = (y * self.view.width + area.left) * 4;
            bytes.extend_from_slice(&self.view.pixels[start..start + width * 4]);
            if y >= popup.top && y < popup.bottom && !popup.is_empty() {
                let (popup_x, popup_y) = self.popup_origin.expect("visible popup has an origin");
                let src_start = ((y as i64 - i64::from(popup_y)) as usize * self.popup.width
                    + (popup.left as i64 - i64::from(popup_x)) as usize)
                    * 4;
                let dst_start = offset + (popup.left - area.left) * 4;
                let len = (popup.right - popup.left) * 4;
                for (src, dst) in self.popup.pixels[src_start..src_start + len]
                    .chunks_exact(4)
                    .zip(bytes[dst_start..dst_start + len].chunks_exact_mut(4))
                {
                    // CEF pixels are premultiplied BGRA. The browser viewport is opaque.
                    let inverse = 255 - u16::from(src[3]);
                    for channel in 0..3 {
                        dst[channel] = src[channel]
                            .saturating_add((u16::from(dst[channel]) * inverse / 255) as u8);
                    }
                }
            }
        }
        Some(bytes)
    }
}

#[derive(Clone, Copy, Serialize)]
pub(super) struct SurfaceUi {
    cursor: u32,
    caret: Option<(i32, i32)>,
}

pub(crate) struct FrameStream {
    state: Mutex<State>,
    revision: watch::Sender<u32>,
    send_ui: Option<Box<dyn Fn(SurfaceUi) + Send + Sync>>,
}

impl Default for FrameStream {
    fn default() -> Self {
        Self {
            state: Mutex::new(State::default()),
            revision: watch::channel(0).0,
            send_ui: None,
        }
    }
}

impl FrameStream {
    pub(super) fn new(send_ui: Option<Box<dyn Fn(SurfaceUi) + Send + Sync>>) -> Self {
        Self {
            send_ui,
            ..Self::default()
        }
    }

    pub(super) fn shared_texture(&self) -> bool {
        self.send_ui.is_some()
    }

    pub(super) fn publish_ui(&self) {
        if let Some(send_ui) = &self.send_ui {
            let ui = {
                let state = self.lock();
                SurfaceUi {
                    cursor: state.cursor,
                    caret: state.caret,
                }
            };
            send_ui(ui);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn publish(&self, state: &mut State, damage: Area) {
        if state.view.pixels.is_empty() {
            return;
        }
        let revision = state.revision.wrapping_add(1).max(1);
        if revision == 1 {
            state.damage.clear();
        }
        state.revision = revision;
        state.damage.push_back((revision, damage));
        if state.damage.len() > DAMAGE_HISTORY {
            state.damage.pop_front();
        }
        self.revision.send_replace(revision);
    }

    pub(super) fn view(
        &self,
        size: (i32, i32),
        logical: (i32, i32),
        pixels: &[u8],
        dirty: &[cef::Rect],
    ) {
        let mut state = self.lock();
        let resized = state.logical != logical
            || (state.view.width, state.view.height) != (size.0 as usize, size.1 as usize);
        if resized {
            state.popup = Surface::default();
            state.caret = None;
            state.damage.clear();
        }
        state.logical = logical;
        let damage = state.view.update(
            size.0 as usize,
            size.1 as usize,
            pixels,
            if resized { &[] } else { dirty },
        );
        // Chromium can repaint the same complete image after a bounds update.
        // Keep the consumer waiting for a new image instead of sending it twice.
        if resized || !damage.is_empty() {
            let damage = if resized { state.view.area() } else { damage };
            self.publish(&mut state, damage);
        }
    }

    pub(super) fn popup(&self, size: (i32, i32), pixels: &[u8], dirty: &[cef::Rect]) {
        let mut state = self.lock();
        if !state.popup_visible || state.popup_origin.is_none() {
            return;
        }
        let old = state.popup_area();
        state
            .popup
            .update(size.0 as usize, size.1 as usize, pixels, dirty);
        let damage = old.union(state.popup_area());
        self.publish(&mut state, damage);
    }

    pub(super) fn popup_visibility(&self, visible: bool) {
        let mut state = self.lock();
        let damage = state.popup_area();
        state.popup_visible = visible;
        if !visible {
            state.popup = Surface::default();
            state.popup_origin = None;
        }
        if !damage.is_empty() {
            self.publish(&mut state, damage);
        }
    }

    pub(super) fn popup_origin(&self, origin: (i32, i32)) {
        let mut state = self.lock();
        if state.popup_origin == Some(origin) {
            return;
        }
        let damage = state.popup_area();
        state.popup_origin = Some(origin);
        state.popup = Surface::default();
        if !damage.is_empty() {
            self.publish(&mut state, damage);
        }
    }

    pub(super) fn cursor(&self, cursor: u32) {
        let mut state = self.lock();
        if state.cursor != cursor {
            state.cursor = cursor;
            self.publish(&mut state, Area::default());
            drop(state);
            self.publish_ui();
        }
    }

    pub(super) fn caret(&self, caret: Option<(i32, i32)>) {
        let mut state = self.lock();
        if state.caret != caret {
            state.caret = caret;
            self.publish(&mut state, Area::default());
            drop(state);
            self.publish_ui();
        }
    }

    pub(super) fn set_panel_origin(&self, origin: (i32, i32)) {
        self.lock().panel_origin = Some(origin);
    }

    pub(super) fn panel_origin(&self) -> Option<(i32, i32)> {
        self.lock().panel_origin
    }

    pub(super) async fn next(&self, after: u32, protocol: u8) -> Vec<u8> {
        let mut revision = self.revision.subscribe();
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            revision.wait_for(|current| *current != after && *current != 0),
        )
        .await;
        let bytes = self.lock().payload(after, protocol).unwrap_or_default();
        compress_large_patch(bytes, protocol)
    }
}

fn compress_large_patch(mut bytes: Vec<u8>, protocol: u8) -> Vec<u8> {
    if protocol < 3 || bytes.len() < FRAME_HEADER_BYTES + MIN_COMPRESSED_PATCH_BYTES {
        return bytes;
    }
    let pixels = &bytes[FRAME_HEADER_BYTES..];
    // Fast Zstandard levels keep the CEF UI thread out of compression. Small
    // or already dense patches use the original binary frame format.
    let Ok(compressed) = zstd::bulk::compress(pixels, -5) else {
        return bytes;
    };
    if compressed.len() < pixels.len() / 2 {
        bytes[..4].copy_from_slice(&COMPRESSED_FRAME_MAGIC.to_le_bytes());
        bytes.truncate(FRAME_HEADER_BYTES);
        bytes.extend_from_slice(&compressed);
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intermediate_paints_remain_usable_while_the_splitter_is_moving() {
        let mut sizes = ViewportHistory::default();
        sizes.requested((401, 321), 1.25);
        sizes.requested((437, 321), 1.25);
        sizes.requested((455, 321), 1.25);
        assert_eq!(sizes.painted((502, 402), 1.25), Some((401, 321)));
        assert_eq!(sizes.painted((547, 402), 1.25), Some((437, 321)));
        assert_eq!(sizes.painted((502, 402), 1.25), None);
        assert_eq!(sizes.painted((569, 402), 1.25), Some((455, 321)));
        sizes.requested((455, 321), 2.0);
        assert_eq!(sizes.painted((569, 402), 2.0), None);
        assert_eq!(sizes.painted((910, 642), 2.0), Some((455, 321)));
    }

    #[test]
    fn coalesces_damage_and_repaints_the_area_exposed_by_a_popup() {
        let stream = FrameStream::default();
        let base = [0, 0, 80, 255].repeat(8);
        stream.view((4, 2), (2, 1), &base, &[]);
        stream.popup_origin((2, 0));
        stream.popup_visibility(true);
        stream.popup((2, 1), &[0, 160, 0, 255, 0, 160, 0, 255], &[]);
        let bytes = stream.lock().payload(1, 2).unwrap();
        let header = [
            FRAME_MAGIC,
            2,
            4,
            2,
            2,
            1,
            2,
            0,
            2,
            1,
            0,
            u32::MAX,
            u32::MAX,
        ];
        assert_eq!(&bytes[..52], &header.map(u32::to_le_bytes).concat());
        assert_eq!(&bytes[52..], &[0, 160, 0, 255, 0, 160, 0, 255]);
        stream.popup_visibility(false);
        let bytes = stream.lock().payload(2, 2).unwrap();
        assert_eq!(&bytes[52..], &base[8..16]);
        assert_eq!(&stream.lock().payload(0, 1).unwrap()[20..], &base);
    }

    #[test]
    fn a_consumer_that_missed_the_damage_history_receives_a_full_frame() {
        let stream = FrameStream::default();
        let base = [0, 0, 80, 255].repeat(8);
        stream.view((4, 2), (2, 1), &base, &[]);
        for cursor in 1..=DAMAGE_HISTORY as u32 + 1 {
            stream.cursor(cursor);
        }
        assert_eq!(&stream.lock().payload(1, 2).unwrap()[52..], &base);
        assert_eq!(
            stream
                .lock()
                .payload(DAMAGE_HISTORY as u32 + 1, 2)
                .unwrap()
                .len(),
            52
        );
        assert_eq!(frame_byte_len(-1, 2), None);
        assert_eq!(frame_byte_len(8192, 8192), None);
    }

    #[test]
    fn identical_full_paints_do_not_publish_duplicate_frames() {
        let stream = FrameStream::default();
        let mut pixels = [0, 0, 80, 255].repeat(8);
        let full = [cef::Rect {
            x: 0,
            y: 0,
            width: 4,
            height: 2,
        }];
        stream.view((4, 2), (2, 1), &pixels, &full);
        stream.view((4, 2), (2, 1), &pixels, &full);
        stream.view((4, 2), (2, 1), &pixels, &[]);
        assert!(stream.lock().payload(1, 2).is_none());

        pixels[0] = 42;
        stream.view((4, 2), (2, 1), &pixels, &full);
        assert_eq!(&stream.lock().payload(1, 2).unwrap()[52..], &pixels[..16]);
    }

    #[test]
    fn same_size_full_paint_transfers_only_changed_tiles() {
        let stream = FrameStream::default();
        let mut pixels = [0, 0, 80, 255].repeat(200 * 5);
        stream.view((200, 5), (200, 5), &pixels, &[]);
        pixels[(200 * 3 + 150) * 4] = 42;
        stream.view((200, 5), (200, 5), &pixels, &[]);
        let payload = stream.lock().payload(1, 2).unwrap();
        assert_eq!(
            &payload[24..40],
            &[128u32, 3, 64, 1].map(u32::to_le_bytes).concat()
        );
        assert_eq!(payload.len(), 52 + 64 * 4);
        assert_eq!(payload[52 + (150 - 128) * 4], 42);
    }

    #[test]
    fn version_three_compresses_large_patches_without_changing_legacy_responses() {
        let stream = FrameStream::default();
        let pixels = [5, 25, 85, 255].repeat(400 * 300);
        stream.view((400, 300), (200, 150), &pixels, &[]);
        let raw = stream.lock().payload(0, 2).unwrap();
        assert_eq!(compress_large_patch(raw.clone(), 2), raw);
        let packed = compress_large_patch(stream.lock().payload(0, 3).unwrap(), 3);
        assert_eq!(&packed[..4], &COMPRESSED_FRAME_MAGIC.to_le_bytes());
        assert_eq!(&packed[4..FRAME_HEADER_BYTES], &raw[4..FRAME_HEADER_BYTES]);
        assert_eq!(
            zstd::bulk::decompress(&packed[FRAME_HEADER_BYTES..], pixels.len()).unwrap(),
            pixels
        );
    }
}
