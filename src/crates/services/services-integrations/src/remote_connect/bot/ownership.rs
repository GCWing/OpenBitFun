//! A provider polling cursor must have exactly one process owner per product home.

use anyhow::{anyhow, Context, Result};
use fs2::FileExt;
use std::fs::{File, OpenOptions};
use std::path::Path;

pub struct BotListenerLease(File);

impl BotListenerLease {
    pub fn acquire(bot_type: &str) -> Result<Self> {
        let home = super::super::product_home_dir()
            .ok_or_else(|| anyhow!("Cannot determine the Remote Connect product home"))?;
        Self::acquire_in(&home, bot_type)
    }

    fn acquire_in(home: &Path, bot_type: &str) -> Result<Self> {
        if !matches!(bot_type, "weixin" | "telegram" | "feishu") {
            anyhow::bail!("Unknown bot type");
        }
        let directory = home.join("remote-connect-runtime");
        std::fs::create_dir_all(&directory).context("create bot runtime directory")?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join(format!("{bot_type}.lock")))
            .context("open bot listener ownership lock")?;
        file.try_lock_exclusive().map_err(|error| {
            anyhow!("bot_listener_in_use: Cannot acquire {bot_type} listener ownership. Stop that channel in the other Desktop or CLI host before starting it here: {error}")
        })?;
        Ok(Self(file))
    }
}

impl Drop for BotListenerLease {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_listener_consumes_each_channel_and_release_allows_restart() {
        let home = tempfile::tempdir().unwrap();
        let first = BotListenerLease::acquire_in(home.path(), "weixin").unwrap();
        assert!(BotListenerLease::acquire_in(home.path(), "weixin").is_err());
        let other = BotListenerLease::acquire_in(home.path(), "telegram").unwrap();
        drop(first);
        assert!(BotListenerLease::acquire_in(home.path(), "weixin").is_ok());
        drop(other);
    }
}
