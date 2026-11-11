# OpenBitFun English Language Pack
# English (US) (en-US) Fluent Translation File

# ==================== General ====================
app-version = Version { $version }
loading = Loading...
welcome = Welcome to OpenBitFun

# ==================== Actions ====================
action-confirm = Confirm
action-cancel = Cancel
action-save = Save
action-delete = Delete
action-edit = Edit
action-create = Create
action-add = Add
action-remove = Remove
action-close = Close
action-open = Open
action-copy = Copy
action-paste = Paste
action-undo = Undo
action-redo = Redo
action-refresh = Refresh
action-search = Search
action-retry = Retry
action-stop = Stop
action-start = Start

# ==================== Status ====================
status-loading = Loading
status-saving = Saving
status-saved = Saved
status-success = Success
status-error = Error
status-warning = Warning
status-info = Info
status-pending = Pending
status-processing = Processing
status-completed = Completed
status-failed = Failed
status-cancelled = Cancelled
status-ready = Ready
status-connected = Connected
status-disconnected = Disconnected

# ==================== File ====================
file-not-found = File not found: { $path }
file-read-error = Failed to read file: { $path }
file-write-error = Failed to write file: { $path }
file-delete-error = Failed to delete file: { $path }
file-permission-denied = Permission denied: { $path }
file-already-exists = File already exists: { $path }
file-saved = File saved: { $path }
file-created = File created: { $path }
file-deleted = File deleted: { $path }

# ==================== Workspace ====================
workspace-opened = Workspace opened: { $path }
workspace-closed = Workspace closed
workspace-not-found = Workspace not found
workspace-open-error = Failed to open workspace

# ==================== Git ====================
git-not-repository = Current directory is not a Git repository
git-commit-success = Commit successful
git-push-success = Push successful
git-pull-success = Pull successful
git-clone-error = Failed to clone repository
git-commit-error = Commit failed
git-push-error = Push failed
git-pull-error = Pull failed
git-merge-conflict = Merge conflict exists
git-branch-created = Branch created: { $name }
git-branch-deleted = Branch deleted: { $name }
git-checkout-success = Switched to branch: { $name }

# ==================== AI ====================
ai-connection-error = Failed to connect to AI service
ai-api-key-invalid = Invalid API key
ai-model-not-found = Model not found: { $model }
ai-context-too-long = Context exceeds limit
ai-rate-limited = Rate limit exceeded
ai-generation-error = Failed to generate content
ai-thinking = Thinking...
ai-generating = Generating...

# ==================== Terminal ====================
terminal-created = Terminal created
terminal-closed = Terminal closed
terminal-create-error = Failed to create terminal
terminal-command-error = Failed to execute command
terminal-shell-not-found = Shell not found

# ==================== Config ====================
config-loaded = Configuration loaded
config-saved = Configuration saved
config-load-error = Failed to load configuration
config-save-error = Failed to save configuration
config-invalid = Invalid configuration format
config-reset = Configuration reset

# ==================== Snapshot ====================
snapshot-created = Snapshot created: { $name }
snapshot-restored = Snapshot restored: { $name }
snapshot-deleted = Snapshot deleted
snapshot-create-error = Failed to create snapshot
snapshot-restore-error = Failed to restore snapshot
snapshot-not-found = Snapshot not found

# ==================== I18n ====================
language-changed = Language changed to: { $language }
language-not-supported = Unsupported language: { $language }

# ==================== Notifications ====================
notification-copied = Copied to clipboard
notification-settings-saved = Settings saved
notification-connection-established = Connection established
notification-connection-lost = Connection lost

# ==================== Errors ====================
error-unknown = An unknown error occurred
error-network = Network error
error-timeout = Request timeout
error-server = Server error
error-unauthorized = Unauthorized
error-forbidden = Access forbidden

# ==================== Time ====================
time-just-now = just now
time-seconds-ago = { $count } { $count ->
    [one] second
   *[other] seconds
} ago
time-minutes-ago = { $count } { $count ->
    [one] minute
   *[other] minutes
} ago
time-hours-ago = { $count } { $count ->
    [one] hour
   *[other] hours
} ago
time-days-ago = { $count } { $count ->
    [one] day
   *[other] days
} ago
time-weeks-ago = { $count } { $count ->
    [one] week
   *[other] weeks
} ago
time-months-ago = { $count } { $count ->
    [one] month
   *[other] months
} ago
time-years-ago = { $count } { $count ->
    [one] year
   *[other] years
} ago
