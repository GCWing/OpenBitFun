# Configuration contracts

Pure persisted configuration records, defaults, validation and conversion to
shared model DTOs. No filesystem, process, network, Tauri or Core dependencies.
Keep existing schema versions and tolerant field defaults. Core retains the
live ConfigProvider interface and re-exports the records from its old paths.
The ts feature preserves TypeScript export capability without enabling runtime.

`normalization` owns pure model-field validation, capability normalization,
reference reconciliation, and persisted-value recovery shared by startup and
offline migration. Recovery retains unusable model records disabled and returns
diagnostics; callers own persistence. Catalog/provider-dependent reasoning
validation remains in the runtime configuration provider.
Keep 0.2.x model-selector translations, such as `auto` to `primary`, in the
legacy migration adapter. Shared recovery handles invalid current model
references without recognizing historical selector aliases.

`protected_account_models` owns the pure persisted/exported compatibility codec
for explicit subscription account bindings. Keep the live model and approved
fingerprint intact; the legacy projection cannot resolve a provider-default
credential or send to a real provider. Keep enabled/capability/reference facts
so older reference normalization does not silently choose another model.
Supported source records restore before typed validation; unreadable or future
records remain preserved and blocked. Core owns atomic writes and retention of
opaque compatible-source fields. This codec is not a general external-config
importer and performs no credential or filesystem IO.
Provider-default WorkBuddy/ZCode records also use this downgrade boundary,
because earlier readers do not recognize their provider enum tags. Existing
provider-default records retain their original shape.

`account_pool` owns pure member validation and revision reconciliation for
configuration commits. Unchanged historical records remain readable. Member
or order changes advance the current policy epoch; ordinary stale writes fail,
while explicit imports/restores rebase onto the current generation. Core retains
candidate validation, atomic persistence, and subscriber publication.

`channel_routing` owns versioned explicit fallback-model membership and manual
member validation. It references existing model configurations without copying
credentials. Absent routing stays fixed. Reject duplicate/missing/nested members
and narrower input contracts; preserve unsupported persisted records and fail
closed at runtime rather than guessing a provider or dropping historical state.

Focused verification:

```bash
cargo test -p openbitfun-config-contracts --lib
```
