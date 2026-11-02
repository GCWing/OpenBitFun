//! Creative Harness
//!
//! Owns product-creation capabilities that intentionally do not appear in the
//! default tool manifests of general coding, office, or assistant modes.

use crate::agentic::agents::{
    standard_harness_tools, standard_harness_user_context_policy, Agent, UserContextPolicy,
};
use async_trait::async_trait;

pub struct CreativeHarness {
    default_tools: Vec<String>,
}

impl Default for CreativeHarness {
    fn default() -> Self {
        Self::new()
    }
}

impl CreativeHarness {
    pub fn new() -> Self {
        let mut default_tools = standard_harness_tools();
        default_tools.push("ComputerUse".to_string());
        default_tools.extend(
            [
                "DesktopCard",
                "InitMiniApp",
                "FinalizeMiniApp",
                "PublishMiniApp",
                "FrontendWorkbench",
            ]
            .into_iter()
            .map(str::to_string),
        );
        Self { default_tools }
    }
}

#[async_trait]
impl Agent for CreativeHarness {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "Creative"
    }

    fn name(&self) -> &str {
        "Creative"
    }

    fn description(&self) -> &str {
        "Creative Harness for videos, decks, prototypes, and web design with on-demand creative skills, building MiniApps, and customizing the OpenBitFun interface"
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "creative_mode"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn user_context_policy(&self) -> UserContextPolicy {
        standard_harness_user_context_policy()
    }

    fn is_readonly(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::CreativeHarness;
    use crate::agentic::agents::Agent;

    #[test]
    fn creative_mode_owns_product_creation_tools() {
        let tools = CreativeHarness::new().default_tools();
        for tool in [
            "InitMiniApp",
            "FinalizeMiniApp",
            "PublishMiniApp",
            "FrontendWorkbench",
        ] {
            assert!(tools.contains(&tool.to_string()), "missing {tool}");
        }
    }

    #[test]
    fn creative_mode_can_operate_the_app_it_built() {
        // Building a MiniApp without being able to open and use it leaves the
        // Agent driving a copy in a headless browser instead of the app the
        // user is watching.
        let tools = CreativeHarness::new().default_tools();
        assert!(tools.contains(&"MiniAppBrowser".to_string()));
    }

    #[test]
    fn creative_prompt_has_its_own_persistent_cache_identity() {
        let mode = CreativeHarness::new();
        assert_eq!(mode.prompt_template_name(None), "creative_mode");
        let prompt = crate::agentic::agents::get_embedded_prompt("creative_mode").unwrap();
        assert!(prompt.contains("OpenBitFunControl"));
        assert!(prompt
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .contains("installed client"));
        assert!(prompt.contains("FrontendWorkbench"));
    }

    #[test]
    fn creative_prompt_routes_remote_creative_skills_without_bundling_them() {
        let prompt = crate::agentic::agents::get_embedded_prompt("creative_mode").unwrap();
        for repository in [
            "https://github.com/feitangyuan/onetake",
            "https://github.com/heygen-com/hyperframes",
            "https://github.com/alchaincyf/huashu-design",
            "https://github.com/leonxlnx/taste-skill",
            "https://github.com/emilkowalski/skills",
        ] {
            assert!(prompt.contains(repository), "missing {repository}");
        }
        assert!(prompt.contains("not bundled"));
        assert!(prompt.contains("`WebFetch`"));
        assert!(prompt.contains("`ExecCommand`"));
    }
}
