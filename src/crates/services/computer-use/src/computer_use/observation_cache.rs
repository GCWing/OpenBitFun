//! Bounded observation references. This cache never owns input permission.
//! Like computer-use-rust's native State, each instance has a fresh namespace,
//! and every new AX observation invalidates the preceding node address space.

use openbitfun_agent_tools::computer_use_control::ObservationScope;
use std::collections::{hash_map::RandomState, VecDeque};
use std::hash::{BuildHasher, Hasher};

// Geometry only (no pixels). A bounded history permits interleaved screenshot
// and AX/view observations without retaining an entire task's capture history.
const RETAINED_IMAGES: usize = 16;

#[derive(Debug)]
pub(super) struct ObservationCache<G> {
    scope: Option<ObservationScope>,
    namespace: u64,
    revision: u64,
    application: Option<(i32, String)>,
    images: VecDeque<(String, G)>,
    latest: Option<G>,
}

impl<G> Default for ObservationCache<G> {
    fn default() -> Self {
        Self {
            scope: None,
            namespace: RandomState::new().build_hasher().finish(),
            revision: 0,
            application: None,
            images: VecDeque::new(),
            latest: None,
        }
    }
}

impl<G: Copy> ObservationCache<G> {
    pub(super) fn synchronize(&mut self, scope: &ObservationScope) -> bool {
        if self.scope.as_ref() == Some(scope) {
            return false;
        }
        self.clear();
        self.scope = Some(scope.clone());
        true
    }

    pub(super) fn clear(&mut self) {
        self.scope = None;
        self.application = None;
        self.clear_images();
    }

    pub(super) fn clear_images(&mut self) {
        self.images.clear();
        self.latest = None;
    }

    pub(super) fn record_image(&mut self, id: String, geometry: G) {
        self.images.retain(|(existing, _)| *existing != id);
        self.images.push_back((id, geometry));
        while self.images.len() > RETAINED_IMAGES {
            self.images.pop_front();
        }
        self.latest = Some(geometry);
    }

    pub(super) fn latest_image(&self) -> Option<G> {
        self.latest
    }

    pub(super) fn image(&self, id: Option<&str>) -> Result<G, String> {
        let geometry = match id {
            Some(id) => self
                .images
                .iter()
                .find(|(key, _)| key == id)
                .map(|(_, geometry)| *geometry),
            None => self.latest,
        };
        geometry.ok_or_else(|| "[STALE_CAPTURE] Unknown or expired screenshot_id; observe the authorized target again".into())
    }

    pub(super) fn record_application(&mut self, pid: i32) -> Result<String, String> {
        self.application = None;
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or("[OBSERVATION_EXHAUSTED] Create a new host observation cache")?;
        let id = format!("obs_{:016x}_{:x}", self.namespace, self.revision);
        self.application = Some((pid, id.clone()));
        Ok(id)
    }

    pub(super) fn validate_application(&self, pid: i32, id: &str) -> Result<(), String> {
        if id.is_empty()
            || self
                .application
                .as_ref()
                .is_none_or(|(current_pid, current_id)| *current_pid != pid || current_id != id)
        {
            return Err("[STALE_OBSERVATION] Node references belong to a different observation; read the target again before choosing an action".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope(revision: u64) -> ObservationScope {
        ObservationScope {
            generation: 1,
            target_revision: revision,
            target: Some("pid:12/window:34".into()),
        }
    }

    #[test]
    fn interleaved_images_are_bounded_without_changing_their_geometry() {
        let mut cache = ObservationCache::default();
        cache.synchronize(&scope(1));
        for index in 0..=RETAINED_IMAGES {
            cache.record_image(format!("shot_{index}"), index);
        }
        assert!(cache.image(Some("shot_0")).is_err());
        assert_eq!(cache.image(Some("shot_1")).unwrap(), 1);
        assert_eq!(cache.image(None).unwrap(), RETAINED_IMAGES);
        assert_eq!(cache.images.len(), RETAINED_IMAGES);
    }

    #[test]
    fn new_observation_invalidates_nodes_even_if_native_indices_and_content_are_identical() {
        let mut cache = ObservationCache::<u8>::default();
        cache.synchronize(&scope(1));
        let first = cache.record_application(12).unwrap();
        assert!(cache.validate_application(12, &first).is_ok());
        let second = cache.record_application(12).unwrap();
        assert_ne!(first, second);
        assert!(cache.validate_application(12, &first).is_err());
        assert!(cache.validate_application(13, &second).is_err());
        assert!(cache.validate_application(12, &second).is_ok());
    }

    #[test]
    fn stop_restart_and_return_to_same_target_cannot_restore_references() {
        let mut cache = ObservationCache::default();
        cache.synchronize(&scope(1));
        let old = cache.record_application(12).unwrap();
        cache.record_image("shot".into(), 7);
        assert!(!cache.synchronize(&scope(1)));
        assert_eq!(cache.image(Some("shot")).unwrap(), 7);
        assert!(cache.synchronize(&scope(3)));
        assert!(cache.validate_application(12, &old).is_err());
        assert!(cache.image(Some("shot")).is_err());
        let replacement = cache.record_application(12).unwrap();
        cache.clear();
        cache.synchronize(&scope(3));
        assert_ne!(replacement, cache.record_application(12).unwrap());
    }
}
