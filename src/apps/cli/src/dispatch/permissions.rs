use openbitfun_agent_runtime::user_questions::USER_INPUT_AVAILABLE_CONTEXT_KEY;
use serde_json::{Map, Value};

use crate::runtime::approval::{approval_metadata, CliApprovalPolicy};

use super::protocol::DispatchApprovalPolicy;

pub(crate) const REJECT_AND_REPORT_REASON: &str =
    "Dispatch permission policy rejected an action that requires confirmation";

pub(crate) const fn cli_policy(policy: DispatchApprovalPolicy) -> CliApprovalPolicy {
    match policy {
        DispatchApprovalPolicy::Auto => CliApprovalPolicy::ImmediateAllow,
        DispatchApprovalPolicy::RejectAndReport => CliApprovalPolicy::Reject,
        DispatchApprovalPolicy::Remote => CliApprovalPolicy::DisableAuto,
    }
}

pub(crate) fn metadata(policy: DispatchApprovalPolicy) -> Map<String, Value> {
    let mut metadata = approval_metadata(cli_policy(policy));
    // Dispatch persists permission replies, but its current wire has no user
    // question mailbox. A remote permission supervisor therefore cannot answer
    // AskUserQuestion. Use the Runtime's availability gate before a tool waits.
    metadata.insert(
        USER_INPUT_AVAILABLE_CONTEXT_KEY.to_string(),
        Value::Bool(false),
    );
    metadata
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_agent_runtime::sdk::AUTO_APPROVE_ASK_CONTEXT_KEY;

    #[test]
    fn dispatch_policy_uses_the_shared_invocation_metadata_contract() {
        let auto = metadata(DispatchApprovalPolicy::Auto);
        assert_eq!(
            auto.get(USER_INPUT_AVAILABLE_CONTEXT_KEY),
            Some(&Value::Bool(false))
        );
        assert_eq!(
            auto.get(AUTO_APPROVE_ASK_CONTEXT_KEY),
            Some(&Value::Bool(true))
        );

        let reject = metadata(DispatchApprovalPolicy::RejectAndReport);
        assert_eq!(
            reject.get(USER_INPUT_AVAILABLE_CONTEXT_KEY),
            Some(&Value::Bool(false))
        );
        assert_eq!(
            reject.get(AUTO_APPROVE_ASK_CONTEXT_KEY),
            Some(&Value::Bool(false))
        );
        assert_eq!(
            reject,
            approval_metadata(CliApprovalPolicy::Reject),
            "dispatch must not invent a second approval mechanism"
        );

        let remote = metadata(DispatchApprovalPolicy::Remote);
        assert_eq!(
            remote.get(USER_INPUT_AVAILABLE_CONTEXT_KEY),
            Some(&Value::Bool(false)),
            "remote permission supervision does not provide a user-question mailbox"
        );
        assert_eq!(
            remote.get(AUTO_APPROVE_ASK_CONTEXT_KEY),
            Some(&Value::Bool(false))
        );
    }
}
