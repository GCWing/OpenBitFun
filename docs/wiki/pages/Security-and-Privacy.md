[English] | [简体中文](安全与隐私) · [Home](Home)

# Security and privacy

## Data goes where the workflow requires

Core local work does not require uploading a whole project to an OpenBitFun account. Relevant prompts, files, images, and tool context may still go to your configured model provider or external services. Cloud speech, MCP, messaging platforms, market services, and Pages have separate data boundaries.

“Local-first” does not mean all processing is local. SSH workspaces keep runtime/session metadata on the host while workspace IO uses the target; Peer Device Mode and Dispatch execute on another host.

## Permissions and consequential actions

Use approval-oriented permissions for unfamiliar work. Full Access reduces prompts; it is not a sandbox or a guarantee of harmless behavior. Remembered rules are real authorization and should stay narrow.

Inspect the target, reversibility, credentials, and potential disclosure before approving file changes, commands, browser/computer actions, or extensions. OS permissions for microphone, screen capture, or input control are separate.

A request to research or draft is not permission to purchase, send a message, publish, or delete. Back up important data. Session rollback does not reverse all external effects.

## Remote traffic and endpoints

Paired payload content is encrypted end to end. Routing, timing, presence, and other connection metadata are not necessarily hidden. Model-provider traffic, Bot platforms, published Pages, and compromised devices do not acquire the same protection merely because a Relay is encrypted.

Trust the selected executing device and service deployment. Revoke stale devices/connections. Do not infer a guarantee of uptime, compliance, or data retention from a public Relay.

## Extensions

- Skills provide instructions; inspect their code/dependency requirements.
- MCP exposes external tools; limit the selected services and authority.
- Mini Apps request workspace/path access and may use Workers or models.
- Hooks execute commands; project Hooks are off by default and require review.
- Ecosystem discovery is not blanket approval to execute imported code.
- ACP processes have their own permissions and trust assumptions.

Review new permissions on updates. Keep copies and source configuration intact when an import cannot be parsed; do not reset user data to recover.

## Accounts, publishing, memory, and voice

Pages publishing is intentional disclosure; verify visibility and the final share link. Account-based device control requires configured services. Memory, session insights, and speech settings should be reviewed independently. Local transcription and cloud transcription have different data flows; realtime speech also depends on its configured provider.

For legacy migration, use [the migration flow](Getting-Started). Run it on the data-owning machine and inspect warnings instead of deleting old records.

## Report vulnerabilities privately

Follow the [security policy](https://github.com/GCWing/OpenBitFun/blob/v1.0.0/SECURITY.md) and [private vulnerability reporting](https://github.com/GCWing/OpenBitFun/security/advisories/new). Do not publish exploit details, keys, or personal records in an issue.

> Screenshot pending: S26 — permission request and remembered-rule scope.
