#!/usr/bin/env python3
"""Offline repair of session identities and storage damaged by OpenBitFun migrations."""

import argparse
import base64
import copy
import csv
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time


VERSION = 1
FINGERPRINT_KIND = "directory-layout-v1"
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")
CACHE_NAMES = ("product-search-v1.sqlite", "product-search-v1.sqlite-wal",
               "product-search-v1.sqlite-shm")
PROGRESS = None


class ProgressReporter:
    """CLI-only progress with periodic updates during blocking filesystem work."""
    def __init__(self, stream=None, interval=2.0):
        self.stream = stream if stream is not None else sys.stderr
        self.interval = interval
        self.started = time.monotonic()
        self.last_write = self.started
        self.message = "Starting"
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _write(self):
        now = time.monotonic()
        try:
            print("[Progress {:0.0f}s] {}".format(now - self.started, self.message),
                  file=self.stream, flush=True)
        except (OSError, ValueError):
            # Progress output must not interrupt a data repair if its stream closes.
            self.stopped.set()
        self.last_write = now

    def update(self, message, force=False):
        with self.lock:
            self.message = " ".join(str(message).split())
            if force or time.monotonic() - self.last_write >= self.interval:
                self._write()

    def _run(self):
        while not self.stopped.wait(self.interval):
            with self.lock:
                if time.monotonic() - self.last_write >= self.interval:
                    self._write()

    def start(self):
        self.update(self.message, force=True)
        self.thread.start()

    def stop(self):
        self.stopped.set()
        self.thread.join()


def report_progress(message, force=False):
    if PROGRESS is not None:
        PROGRESS.update(message, force)


def progress_items(items, stage, total=None):
    """Report completed counts without enumerating filesystem entries twice."""
    if PROGRESS is None:
        yield from items
        return
    if total is None:
        try:
            total = len(items)
        except TypeError:
            pass
    count = 0

    def status(detail=""):
        counter = "{} / {}".format(count, total) if total is not None else str(count)
        return "{}: {} completed{}".format(stage, counter, "; " + detail if detail else "")

    report_progress(status(), force=True)
    for item in items:
        detail = item.get("source", item.get("path", "")) if isinstance(item, dict) else str(item)
        report_progress(status(detail))
        yield item
        count += 1
    report_progress(status(), force=True)


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def read_json(path):
    return json.loads(Path(path).read_bytes().decode("utf-8-sig"))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def linked(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def safe_path(path, root):
    """Reject path escapes and all symlink/junction ancestors, including the root."""
    path, root = Path(os.path.abspath(path)), Path(os.path.abspath(root))
    path.relative_to(root)
    for part in (path,) + tuple(path.parents):
        if os.path.lexists(part) and linked(part):
            raise ValueError("Linked/reparse path is unsupported: {}".format(part))
    return path


def file_hash(path):
    safe_path(path, Path(path).parent)
    if not Path(path).is_file():
        raise ValueError("Not a regular file: {}".format(path))
    hasher = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def optional_hash(path):
    return file_hash(path) if os.path.lexists(path) else None


def directory_manifest(root, overrides=None):
    root = safe_path(root, root)
    if not root.is_dir():
        raise ValueError("Not a directory: {}".format(root))
    def fail(error):
        raise error

    manifest = []
    for current, dirs, files in os.walk(root, followlinks=False, onerror=fail):
        dirs.sort()
        for name in sorted(dirs + files):
            path = safe_path(Path(current) / name, root)
            relative = path.relative_to(root).as_posix()
            if path.is_dir():
                manifest.append(["directory", relative])
            else:
                size = (len(overrides[relative]) if overrides and relative in overrides
                        else path.stat().st_size)
                manifest.append(["file", relative, size])
    return manifest


def directory_fingerprint(root, overrides=None):
    """Fingerprint layout and file sizes without reading session content."""
    return digest(encoded(directory_manifest(root, overrides)))


def directory_fingerprint_pair(root, before_overrides=None, after_overrides=None):
    """Compute before/after fingerprints from one directory enumeration."""
    manifest = directory_manifest(root)

    def with_overrides(overrides):
        if not overrides:
            return manifest
        return [
            ["file", item[1], len(overrides[item[1]])]
            if item[0] == "file" and item[1] in overrides else item
            for item in manifest
        ]

    return (digest(encoded(with_overrides(before_overrides))),
            digest(encoded(with_overrides(after_overrides))))


def atomic_write(path, data):
    path = safe_path(path, Path(path).parent)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".repair-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def normalized(value):
    if not isinstance(value, str) or not value:
        raise ValueError("Missing or invalid workspace path")
    return os.path.normcase(os.path.normpath(value))


def runtime_key(root):
    path = Path(root)
    if not path.is_absolute() or not path.is_dir():
        raise ValueError("Workspace must be an existing absolute directory: {}".format(root))
    text = os.path.realpath(root)
    if text.startswith("\\\\?\\UNC\\"):
        text = "\\\\" + text[8:]
    elif text.startswith("\\\\?\\"):
        text = text[4:]
    return digest(b"runtime-local\0" + text.replace("\\", "/").encode("utf-8"))[:24]


def remote_path(value):
    if not isinstance(value, str) or not value.startswith("/") or "\0" in value:
        raise ValueError("Remote workspace path must be absolute POSIX")
    value = re.sub(r"/+", "/", value.replace("\\", "/"))
    if any(part in (".", "..") for part in value.split("/")):
        raise ValueError("Ambiguous remote workspace path")
    return value.rstrip("/") or "/"


def record_host(record):
    host = record.get("metadata", {}).get("sshHost")
    if not isinstance(host, str) or not host.strip():
        raise ValueError("Remote registry record has no SSH host")
    return host.strip().lower()


def record_runtime_key(record):
    if record.get("workspaceKind") == "remote":
        return digest(b"runtime-remote\0" + record_host(record).encode("utf-8") + b"\0"
                      + remote_path(record["rootPath"]).encode("utf-8"))[:24]
    return runtime_key(record["rootPath"])


def assistant_aliases(home, records):
    """Only accept IDs derived from the exact pre-brand-rename assistant path."""
    aliases = {}
    if home.name != ".openbitfun":
        return aliases
    for wid, record in records.items():
        if record.get("workspaceKind") != "assistant":
            continue
        root = Path(record["rootPath"])
        try:
            relative = root.relative_to(home / "personal_assistant")
        except ValueError:
            continue
        old_path = home.with_name(".bitfun") / "personal_assistant" / relative
        old_id = "local_" + digest(("localhost\n" + str(old_path).replace("\\", "/")).encode("utf-8"))[:32]
        if old_id in records:
            continue
        if old_id in aliases:
            raise ValueError("Ambiguous legacy assistant identity")
        aliases[old_id] = {"id": wid, "old_path": str(old_path), "new_path": record["rootPath"]}
    return aliases


def registry(user_root):
    path = safe_path(user_root / "data" / "workspace_data.json", user_root)
    data = read_json(path)
    if data.get("format_version") != 1 or data.get("product_id") != "openbitfun":
        raise ValueError("Unsupported workspace registry format")
    records = data.get("workspaces")
    if not isinstance(records, dict):
        raise ValueError("Workspace registry has no workspaces map")
    for key, record in records.items():
        if not isinstance(record, dict) or record.get("id", key) != key:
            raise ValueError("Invalid workspace registry record: {}".format(key))
    return records, file_hash(path)


def metadata(directory, raw=None):
    value = raw if raw is not None else read_json(safe_path(directory / "metadata.json", directory))
    if isinstance(value, dict):
        # These are the legacy aliases consumed by the product's SessionMetadata.
        fields = ("sessionId", "sessionName", "agentType", "modelName", "createdAt", "lastActiveAt",
                  "turnCount", "messageCount", "toolCallCount", "workspacePath", "projectWorkspacePath",
                  "workspaceId", "executionTarget", "workspaceHostname", "sessionKind", "createdBy")
        value = value.copy()
        for key in fields:
            alias = re.sub(r"([A-Z])", lambda m: "_" + m.group(1).lower(), key)
            if alias in value:
                if key in value and value[key] != value[alias]:
                    raise ValueError("Conflicting metadata field aliases: {}".format(key))
                value[key] = value.pop(alias)
    if not isinstance(value, dict) or value.get("sessionId") != directory.name:
        raise ValueError("Metadata session ID does not match directory: {}".format(directory))
    if value.get("schema_version", 2) != 2:
        raise ValueError("Unsupported metadata schema: {}".format(directory))
    if not isinstance(value.get("sessionName"), str):
        raise ValueError("Missing session name: {}".format(directory))
    for field in ("agentType", "modelName"):
        if not isinstance(value.get(field), str):
            raise ValueError("Missing/invalid metadata field: {}".format(field))
    for field in ("createdAt", "lastActiveAt", "turnCount", "messageCount", "toolCallCount"):
        if type(value.get(field)) is not int or value[field] < 0:
            raise ValueError("Missing/invalid metadata field: {}".format(field))
    if value.get("status") not in ("active", "archived", "completed"):
        raise ValueError("Missing/invalid metadata status")
    if value.get("sessionKind", "standard") not in ("standard", "subagent", "ephemeral_child"):
        raise ValueError("Unsupported session kind: {}".format(directory))
    return value


def owner(directory, records, aliases=None, documents=None):
    documents = copy.deepcopy(documents) if documents is not None else {
        "metadata.json": read_json(directory / "metadata.json")}
    state_path = safe_path(directory / "state.json", directory)
    if "state.json" not in documents and state_path.exists():
        documents["state.json"] = read_json(state_path)
    if not isinstance(documents["metadata.json"], dict) or not isinstance(documents.get("state.json", {}), dict):
        raise ValueError("Metadata/state must be JSON objects")
    if not isinstance(documents.get("state.json", {}).get("config", {}), dict):
        raise ValueError("Session config must be a JSON object")
    # Normalize proven migrated assistant identities before comparing metadata/state.
    for alias_id, mapping in (aliases or {}).items():
        raw_meta = documents["metadata.json"]
        config = documents.get("state.json", {}).get("config", {})
        containers = ((raw_meta, ("workspaceId", "workspace_id", "projectWorkspaceId", "project_workspace_id"),
                       ("workspacePath", "workspace_path", "projectWorkspacePath", "project_workspace_path")),
                      (config, ("workspace_id", "project_workspace_id"),
                       ("workspace_path", "project_workspace_path")))
        relevant = any(c.get(k) == alias_id for c, keys, _ in containers for k in keys)
        relevant |= any(c.get(k) and normalized(c[k]) == normalized(mapping["old_path"])
                        for c, _, keys in containers for k in keys)
        if not relevant:
            continue
        for container, id_keys, path_keys in containers:
            if not isinstance(container, dict):
                raise ValueError("Invalid session identity container")
            for key in id_keys:
                if container.get(key) == alias_id:
                    container[key] = mapping["id"]
            for key in path_keys:
                if container.get(key) and normalized(container[key]) == normalized(mapping["old_path"]):
                    container[key] = mapping["new_path"]
            for key in ("executionTarget", "execution_target"):
                target = container.get(key)
                if isinstance(target, dict):
                    for path_key in ("rootPath", "root_path"):
                        if target.get(path_key) and normalized(target[path_key]) == normalized(mapping["old_path"]):
                            target[path_key] = mapping["new_path"]
    meta = metadata(directory, documents["metadata.json"])
    state = documents.get("state.json", {})
    if not isinstance(state, dict) or state.get("schema_version", 2) != 2:
        raise ValueError("Unsupported session state")
    config = state.get("config", {})
    if not isinstance(config, dict):
        raise ValueError("Session config is not an object")
    snapshot_ids = [meta.get(key) for key in ("snapshotSessionId", "sandboxSessionId", "sandbox_session_id")]
    snapshot_ids.append(state.get("snapshot_session_id"))
    snapshot_ids = {sid for sid in snapshot_ids if sid is not None}
    if len(snapshot_ids) > 1:
        raise ValueError("Metadata/state snapshot session IDs disagree")
    state = dict(state, snapshot_session_id=next(iter(snapshot_ids), None))
    values = {}
    is_remote = (config.get("workspace_kind") == "remote"
                 or str(meta.get("workspaceId") or "").startswith("remote_")
                 or str(config.get("workspace_id") or "").startswith("remote_")
                 or meta.get("workspaceHostname") not in (None, "", "localhost")
                 or config.get("remote_ssh_host") not in (None, "", "localhost"))
    path_normalize = remote_path if is_remote else normalized
    fields = ("workspaceId", "projectWorkspaceId", "workspacePath", "projectWorkspacePath",
              "workspaceKind", "workspaceHostname", "executionTarget")
    state_keys = ("workspace_id", "project_workspace_id", "workspace_path", "project_workspace_path",
                  "workspace_kind", "remote_ssh_host", "execution_target")
    for key, state_key in zip(fields, state_keys):
        first, second = meta.get(key), config.get(state_key)
        if first is not None and second is not None:
            left, right = (path_normalize(first), path_normalize(second)) if key.endswith("Path") else (first, second)
            if left != right:
                raise ValueError("Metadata/state disagree on {}".format(key))
        values[key] = first if first is not None else second
    if values["workspaceKind"] not in (None, "normal", "assistant", "remote"):
        raise ValueError("Worktree workspace requires manual repair")
    wid = values["workspaceId"]
    project_id = values["projectWorkspaceId"]
    root = values["workspacePath"]
    project_path = values["projectWorkspacePath"]
    if project_id and wid and project_id != wid:
        raise ValueError("Linked worktree session requires manual repair")
    if root and project_path and path_normalize(root) != path_normalize(project_path):
        raise ValueError("Execution/project workspace paths differ")
    wid, root = project_id or wid, project_path or root
    if wid:
        if wid not in records:
            raise ValueError("Unknown workspace ID: {}".format(wid))
        record = records[wid]
    else:
        matches = [(key, item) for key, item in records.items()
                   if root and item.get("rootPath")
                   and (item.get("workspaceKind") == "remote") == is_remote
                   and path_normalize(item["rootPath"]) == path_normalize(root)
                   and (not is_remote or record_host(item) == str(values["workspaceHostname"]).strip().lower())]
        if len(matches) != 1:
            raise ValueError("Legacy path does not identify exactly one workspace")
        wid, record = matches[0]
    if record.get("workspaceKind", "normal") not in ("normal", "assistant", "remote"):
        raise ValueError("Worktree registry record requires manual repair")
    if (record.get("workspaceKind") == "remote") != is_remote:
        raise ValueError("Session and registry disagree on local/remote identity")
    if is_remote:
        if str(values["workspaceHostname"]).strip().lower() != record_host(record):
            raise ValueError("Session and registry SSH hosts disagree")
        connection = config.get("remote_connection_id")
        expected_connection = record.get("metadata", {}).get("connectionId")
        canonical = lambda value: re.sub(r"(:[0-9]+)$", "", value) if value and value.startswith("ssh-") and "@" in value else value
        if connection and expected_connection and canonical(connection) != canonical(expected_connection):
            raise ValueError("Session and registry SSH connections disagree")
        state["repair_remote_identity"] = [record_host(record), remote_path(record["rootPath"]),
                                            canonical(connection or expected_connection)]
    if root and path_normalize(root) != path_normalize(record["rootPath"]):
        raise ValueError("Session identity disagrees with registry path")
    target = values["executionTarget"]
    if target is not None:
        if not isinstance(target, dict) or target.get("kind") != "local":
            raise ValueError("Unsupported execution target")
        if path_normalize(target.get("rootPath", target.get("root_path"))) != path_normalize(record["rootPath"]):
            raise ValueError("Execution target disagrees with registry")
    state["repair_documents"] = documents
    return wid, record["rootPath"], meta, state


def catalog(root, metadata_cache=None):
    result = {}
    if not root.exists():
        safe_path(root, root)
        return result
    safe_path(root, root)
    for directory in progress_items(sorted(root.iterdir()), "Read catalog {}".format(root)):
        safe_path(directory, root)
        if directory.is_dir() and (directory / "metadata.json").exists():
            if not SAFE_ID.fullmatch(directory.name):
                raise ValueError("Unsupported session directory name: {}".format(directory))
            path = safe_path(directory / "metadata.json", directory)
            raw = path.read_bytes()
            document = json.loads(raw.decode("utf-8-sig"))
            entry = metadata(directory, document)
            if metadata_cache is not None:
                metadata_cache[directory] = (raw, document, entry)
            result[directory.name] = digest(raw)
    return result


def index_bytes(root):
    entries = []
    metadata_cache = {}
    files = catalog(root, metadata_cache)
    for sid in files:
        entry = metadata_cache[root / sid][2].copy()
        entry.pop("schema_version", None)
        hidden = entry.get("sessionKind") in ("subagent", "ephemeral_child")
        hidden |= (str(entry.get("createdBy", "")).startswith("session-")
                   and entry["sessionName"].startswith("Subagent: "))
        if not hidden:
            entries.append(entry)
    entries.sort(key=lambda item: item.get("lastActiveAt", 0), reverse=True)
    return encoded({"schema_version": 2, "updated_at": int(time.time() * 1000),
                    "metadata_file_count": len(files), "sessions": entries})


def references(value):
    found = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if key in ("snapshot_id", "snapshotId", "before_snapshot_id", "after_snapshot_id") and child:
                if not isinstance(child, str) or not SAFE_ID.fullmatch(child):
                    raise ValueError("Invalid snapshot reference")
                found.add(child)
            else:
                found.update(references(child))
    elif isinstance(value, list):
        for child in value:
            found.update(references(child))
    return found


def snapshot_assets(source, target, state, snapshot_relative=None, include_revert=True):
    """Copy session histories and their explicit snapshot dependencies only."""
    source_runtime, target_runtime = source.parent.parent, target.parent.parent
    remote = state.get("repair_remote_identity")
    if remote and snapshot_relative is None:
        if not remote[2]:
            evidence_dir = source if source.exists() else target
            revert = evidence_dir / "session-revert.json"
            if (source_runtime / "snapshots/workspace-identities").exists() or (
                    revert.exists() and references(read_json(revert))):
                raise ValueError("Remote snapshot dependencies require an SSH connection ID")
            return []
        scope = digest(json.dumps(remote, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        relative = Path("snapshots") / "workspace-identities" / scope
        return snapshot_assets(source, target, state, relative, True)
    snapshot_root = source_runtime / (snapshot_relative or Path("snapshots"))
    assets = {}

    def add(path):
        path = safe_path(path, source_runtime)
        if not path.is_file():
            raise ValueError("Missing snapshot dependency: {}".format(path))
        destination = safe_path(target_runtime / path.relative_to(source_runtime), target_runtime)
        sha, old = file_hash(path), optional_hash(destination)
        if old is not None and old != sha:
            raise ValueError("Snapshot destination conflict: {}".format(destination))
        assets[str(destination)] = {"source": str(path), "target": str(destination),
                                    "sha256": sha, "existed": old is not None}
        return read_json(path) if path.suffix == ".json" else None

    ids = set()
    for sid in {source.name, state.get("snapshot_session_id") or source.name}:
        if not isinstance(sid, str) or not SAFE_ID.fullmatch(sid):
            raise ValueError("Unsupported snapshot session ID")
        history = snapshot_root / "operations" / (sid + ".json")
        safe_path(history, source_runtime)
        if history.exists():
            data = add(history)
            if data.get("session_id") != sid:
                raise ValueError("Snapshot history session ID mismatch")
            ids.update(references(data))
    evidence_dir = source if source.exists() else target
    revert = evidence_dir / "session-revert.json"
    if include_revert and revert.exists():
        ids.update(references(read_json(safe_path(revert, evidence_dir))))
    for sid in sorted(ids):
        category = "baselines" if sid.startswith("baseline_") else "metadata"
        data = add(snapshot_root / category / (sid + ".json"))
        if data.get("snapshot_id") != sid:
            raise ValueError("Snapshot metadata ID mismatch")
        content_hash = data.get("content_hash")
        if not isinstance(content_hash, str) or not re.fullmatch(r"[0-9a-f]{32}", content_hash):
            raise ValueError("Unsupported snapshot content hash")
        blob = snapshot_root / "by_hash" / (content_hash + ".snap")
        safe_path(blob, source_runtime)
        if blob.exists():
            add(blob)
        elif not data.get("compressed_content"):
            raise ValueError("Missing snapshot content: {}".format(sid))
    return sorted(assets.values(), key=lambda item: item["target"])


def planned_updates(directory, repaired_documents, originals=None):
    updates = {}
    for filename, value in repaired_documents.items():
        before, original = (originals[filename] if originals is not None else
                            ((directory / filename).read_bytes(), read_json(directory / filename)))
        if original != value:
            after = encoded(value)
            updates[filename] = {"before": base64.b64encode(before).decode("ascii"),
                                 "after": base64.b64encode(after).decode("ascii")}
    return updates


def update_bytes(operation, side):
    return {name: base64.b64decode(update[side], validate=True)
            for name, update in operation.get("file_updates", {}).items()}


def identity_changes(directory, repaired_documents, originals=None):
    changes = []

    def compare(filename, path, before, after):
        if isinstance(before, dict) and isinstance(after, dict):
            for key in sorted(set(before) | set(after)):
                compare(filename, path + [key], before.get(key), after.get(key))
        elif before != after:
            changes.append({"file": filename, "field": ".".join(path), "before": before, "after": after})

    for filename, after in repaired_documents.items():
        before = originals[filename][1] if originals is not None else read_json(directory / filename)
        compare(filename, [], before, after)
    return changes


def sessions_roots(home):
    projects = safe_path(home / "projects", home)
    if projects.exists():
        for runtime in sorted(projects.iterdir()):
            yield runtime / "sessions"
    remote = safe_path(home / "remote_ssh", home)
    if remote.exists():
        def fail(error):
            raise error
        for current, dirs, _ in os.walk(remote, followlinks=False, onerror=fail):
            for name in dirs:
                safe_path(Path(current) / name, home)
            if Path(current).name == "sessions":
                yield Path(current)
                dirs[:] = []


def make_plan(home, user_root):
    report_progress("Plan: reading workspace registry", force=True)
    home, user_root = safe_path(home, home), safe_path(user_root, user_root)
    records, registry_sha = registry(user_root)
    aliases = assistant_aliases(home, records)
    operations, diagnostics, catalogs = [], [], {}
    catalog_cache = {}
    metadata_cache = {}

    def cached_catalog(root):
        key = str(root)
        if key not in catalog_cache:
            catalog_cache[key] = catalog(root, metadata_cache)
        return catalog_cache[key]

    projects = safe_path(home / "projects", home)
    if home.exists():
        for sessions in progress_items(sessions_roots(home), "Plan runtime directories"):
            runtime = sessions.parent
            try:
                safe_path(runtime, home)
                if not sessions.is_dir():
                    continue
                # A malformed neighbor must not disappear from a rebuilt index.
                catalogs[str(sessions)] = cached_catalog(sessions)
                session_dirs = [path for path in sorted(sessions.iterdir()) if path.is_dir()]
                for number, source in enumerate(progress_items(session_dirs, "Plan sessions in {}".format(sessions))):
                    try:
                        safe_path(source, sessions)
                        if not (source / "metadata.json").exists():
                            raise ValueError("Session directory has no metadata.json")
                        raw, document, _ = metadata_cache[source]
                        originals = {"metadata.json": (raw, document)}
                        state_path = safe_path(source / "state.json", source)
                        if state_path.exists():
                            raw = state_path.read_bytes()
                            originals["state.json"] = (raw, json.loads(raw.decode("utf-8-sig")))
                        documents = {name: item[1] for name, item in originals.items()}
                        wid, workspace, meta, state = owner(source, records, aliases, documents)
                        updates = planned_updates(source, state["repair_documents"], originals)
                        target = safe_path(projects / record_runtime_key(records[wid]) / "sessions" / source.name, home)
                        if target == source and not updates:
                            diagnostics.append({"source": str(source), "status": "correct"})
                            continue
                        if target != source and os.path.lexists(target):
                            raise ValueError("Destination session already exists: {}".format(target))
                        catalogs[str(target.parent)] = cached_catalog(target.parent)
                        report_progress("Plan sessions: {} / {} completed; fingerprint and snapshot references for {}".format(
                            number, len(session_dirs), source))
                        before_fingerprint, repaired_fingerprint = directory_fingerprint_pair(
                            source, None, update_bytes({"file_updates": updates}, "after"))
                        operations.append({"source": str(source), "target": str(target),
                                           "session_id": source.name, "session_name": meta["sessionName"],
                                           "workspace_id": wid, "workspace_path": workspace,
                                           "sha256": before_fingerprint, "file_updates": updates,
                                           "identity_changes": identity_changes(source, state["repair_documents"], originals),
                                           "repaired_sha256": repaired_fingerprint,
                                           "assets": snapshot_assets(source, target, state)})
                    except (OSError, ValueError, TypeError, KeyError) as error:
                        diagnostics.append({"source": str(source), "status": "skipped", "reason": str(error)})
            except (OSError, ValueError, TypeError, KeyError) as error:
                diagnostics.append({"source": str(runtime), "status": "skipped", "reason": str(error)})
    report_progress("Plan: checking destination and snapshot conflicts", force=True)
    duplicates = {}
    asset_targets = {}
    for operation in operations:
        duplicates.setdefault(operation["target"], []).append(operation)
        for asset in operation["assets"]:
            asset_targets.setdefault(asset["target"], set()).add(asset["sha256"])
    accepted = []
    for operation in operations:
        reason = None
        if len(duplicates[operation["target"]]) > 1:
            reason = "Multiple source sessions claim the same destination"
        elif any(len(asset_targets[a["target"]]) > 1 for a in operation["assets"]):
            reason = "Conflicting shared snapshot dependencies in this plan"
        if reason:
            diagnostics.append({"source": operation["source"], "status": "skipped", "reason": reason})
        else:
            accepted.append(operation)
    affected = {str(Path(o[key]).parent) for o in accepted for key in ("source", "target")}
    return {"version": VERSION, "fingerprint_kind": FINGERPRINT_KIND,
            "home": str(home), "user_root": str(user_root),
            "registry_sha256": registry_sha, "operations": accepted, "diagnostics": diagnostics,
            "catalogs": {key: catalogs[key] for key in sorted(affected)}}


def validate_plan(plan):
    report_progress("Validate: reading plan and workspace registry", force=True)
    if plan.get("version") != VERSION:
        raise ValueError("Unsupported repair plan version; generate a new plan with this script")
    if plan.get("fingerprint_kind") != FINGERPRINT_KIND:
        raise ValueError("This plan uses legacy full-content fingerprints; generate a new plan")
    home, user_root = Path(plan["home"]), Path(plan["user_root"])
    if not home.is_absolute() or not user_root.is_absolute():
        raise ValueError("Plan roots must be absolute")
    safe_path(home, home)
    records, sha = registry(user_root)
    aliases = assistant_aliases(home, records)
    if sha != plan["registry_sha256"]:
        raise ValueError("Workspace registry changed; generate a new plan")
    targets, sources, affected = set(), set(), set()
    for operation in progress_items(plan["operations"], "Validate sessions and snapshot dependencies"):
        source, target = Path(operation["source"]), Path(operation["target"])
        safe_path(source, home)
        safe_path(target, home / "projects")
        sid = operation["session_id"]
        if not SAFE_ID.fullmatch(sid) or source.name != sid or source.parent.name != "sessions":
            raise ValueError("Invalid source session path")
        if source.parent.parent.parent != home / "projects" and home / "remote_ssh" not in source.parents:
            raise ValueError("Invalid source runtime root")
        record = records[operation["workspace_id"]]
        if record["rootPath"] != operation["workspace_path"]:
            raise ValueError("Plan workspace disagrees with registry")
        expected = home / "projects" / record_runtime_key(record) / "sessions" / sid
        if target != expected or str(target) in targets or str(source) in sources:
            raise ValueError("Invalid or duplicate destination")
        targets.add(str(target))
        sources.add(str(source))
        affected.update((str(source.parent), str(target.parent)))
        evidence_dir = source if source.exists() else target
        documents = {"metadata.json": read_json(evidence_dir / "metadata.json")}
        if (evidence_dir / "state.json").exists():
            documents["state.json"] = read_json(evidence_dir / "state.json")
        for name, before in update_bytes(operation, "before").items():
            if name not in ("metadata.json", "state.json") or name not in documents:
                raise ValueError("Invalid identity update path")
            documents[name] = json.loads(before.decode("utf-8-sig"))
        wid, root, _, state = owner(evidence_dir, records, aliases, documents)
        if wid != operation["workspace_id"] or root != operation["workspace_path"]:
            raise ValueError("Plan disagrees with session identity")
        before = update_bytes(operation, "before")
        after = update_bytes(operation, "after")
        for name, document in documents.items():
            repaired = state["repair_documents"][name]
            if name in after:
                if document == repaired or after[name] != encoded(repaired):
                    raise ValueError("Invalid assistant identity rewrite")
            elif document != repaired:
                raise ValueError("Missing assistant identity rewrite")
        if source == target and not after:
            raise ValueError("Plan has no repair action")
        before_fingerprint, repaired_fingerprint = directory_fingerprint_pair(
            evidence_dir, before, after)
        if before_fingerprint != operation["sha256"]:
            raise ValueError("Session changed since planning")
        if repaired_fingerprint != operation["repaired_sha256"]:
            raise ValueError("Invalid repaired session fingerprint")
        actual_assets = snapshot_assets(source, target, state)
        # Existing identical copies are expected during resume.
        comparable = lambda items: [{k: v for k, v in a.items() if k != "existed"} for a in items]
        if comparable(actual_assets) != comparable(operation["assets"]):
            raise ValueError("Snapshot dependencies changed since planning")
    if affected != set(plan["catalogs"]):
        raise ValueError("Invalid affected catalogs")
    return home


def expected_catalogs(plan):
    result = {key: dict(value) for key, value in plan["catalogs"].items()}
    for operation in plan["operations"]:
        source, target = Path(operation["source"]), Path(operation["target"])
        sha = result[str(source.parent)].pop(source.name)
        if "metadata.json" in operation.get("file_updates", {}):
            sha = digest(update_bytes(operation, "after")["metadata.json"])
        result[str(target.parent)][target.name] = sha
    return result


def mutation_directories(plan):
    projects = Path(plan["home"]) / "projects"
    directories = set()
    paths = [Path(o["target"]).parent for o in plan["operations"]]
    paths.extend(Path(a["target"]).parent for o in plan["operations"] for a in o["assets"])
    for path in paths:
        while path != projects:
            safe_path(path, projects)
            directories.add(str(path))
            path = path.parent
    return directories


def check_sessions(plan, resume=False):
    expected = {key: dict(value) for key, value in plan["catalogs"].items()}
    for operation in progress_items(plan["operations"], "Check session locations and identities"):
        source, target = Path(operation["source"]), Path(operation["target"])
        if source == target and source.exists():
            location = source
        elif source.exists() and not target.exists():
            location = source
        elif resume and target.exists() and not source.exists():
            location = target
            sha = expected[str(source.parent)].pop(source.name)
            expected[str(target.parent)][target.name] = sha
        else:
            raise ValueError("Session source/destination conflict: {}".format(source))
        before, after = update_bytes(operation, "before"), update_bytes(operation, "after")
        for name in before:
            raw = (location / name).read_bytes()
            if raw != before[name] and (not resume or raw != after[name]):
                raise ValueError("Session identity file changed: {}".format(location / name))
        if directory_fingerprint(location, before) != operation["sha256"]:
            raise ValueError("Session changed since planning: {}".format(location))
        if "metadata.json" in before:
            expected[str(location.parent)][location.name] = file_hash(location / "metadata.json")
    for root, value in expected.items():
        if catalog(Path(root)) != value:
            raise ValueError("Session catalog changed since planning: {}".format(root))


def check_closed(confirmed):
    if not confirmed:
        raise ValueError("Close all OpenBitFun Desktop/CLI hosts, then pass --confirm-closed")
    if os.name == "nt":
        result = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True,
                                creationflags=subprocess.CREATE_NO_WINDOW, check=True)
        for row in csv.reader(result.stdout.decode(errors="replace").splitlines()):
            if row and re.fullmatch(r"(?:openbitfun|bitfun)(?:[-_].*)?\.exe", row[0], re.I):
                raise ValueError("OpenBitFun process is still running: {}".format(row[0]))


class RepairLock:
    def __init__(self, home):
        self.path = safe_path(home / ".session-storage-repair.lock", home)

    def __enter__(self):
        with self.path.open("x", encoding="utf-8") as stream:
            stream.write(str(os.getpid()))
        return self

    def __exit__(self, *_):
        self.path.unlink()


def outside_data(path, plan):
    path = safe_path(path, path)
    for root in (Path(plan["home"]), Path(plan["user_root"])):
        # Disallow either containment direction (backup must not contain data either).
        if path == root or root in path.parents or path in root.parents:
            raise ValueError("Plan/backup path must be outside product data: {}".format(path))
    return path


def save_journal(backup, journal):
    atomic_write(backup / "journal.json", encoded(journal))


def prepare_backup(plan, backup):
    backup.mkdir(parents=True, exist_ok=False)
    atomic_write(backup / "plan.json", encoded(plan))
    # A prepared journal only appears after every full-session backup is verified.
    for index, operation in enumerate(progress_items(plan["operations"], "Back up sessions")):
        destination = backup / "sessions" / str(index)
        destination.parent.mkdir(exist_ok=True)
        shutil.copytree(operation["source"], destination)
        if directory_fingerprint(destination) != operation["sha256"]:
            raise ValueError("Backup verification failed")
    controls = []
    for root in progress_items(plan["catalogs"], "Back up indexes and search caches"):
        for name in ("index.json",) + CACHE_NAMES:
            path = safe_path(Path(root) / name, Path(plan["home"]))
            old = optional_hash(path)
            entry = {"path": str(path), "old": old, "new": old,
                     "backup": "controls/{}.bin".format(len(controls)), "pending": None}
            if old is not None:
                atomic_write(backup / entry["backup"], path.read_bytes())
                if file_hash(backup / entry["backup"]) != old:
                    raise ValueError("Control-file backup verification failed")
            controls.append(entry)
    journal = {"version": VERSION, "plan_sha256": digest(encoded(plan)), "phase": "prepared",
               "controls": controls, "asset_writes": [],
               "created_directories": sorted(path for path in mutation_directories(plan)
                                             if not Path(path).exists())}
    save_journal(backup, journal)
    return journal


def load_backup(backup, plan):
    report_progress("Resume: reading backup journal", force=True)
    journal = read_json(safe_path(backup / "journal.json", backup))
    if journal.get("version") != VERSION or journal["plan_sha256"] != digest(encoded(plan)):
        raise ValueError("Backup belongs to another plan")
    if journal["phase"] not in ("prepared", "indexing", "completed", "rolling_back", "rolled_back"):
        raise ValueError("Unsupported backup journal phase")
    if not set(journal["created_directories"]) <= mutation_directories(plan):
        raise ValueError("Invalid created-directory journal")
    for index, operation in enumerate(progress_items(plan["operations"], "Verify session backups")):
        if directory_fingerprint(safe_path(backup / "sessions" / str(index), backup)) != operation["sha256"]:
            raise ValueError("Session backup changed or is incomplete")
    expected_paths = {str(Path(root) / name) for root in plan["catalogs"]
                      for name in ("index.json",) + CACHE_NAMES}
    if {entry["path"] for entry in journal["controls"]} != expected_paths:
        raise ValueError("Invalid backup control paths")
    for entry in journal["controls"]:
        if entry["old"] is not None:
            if file_hash(safe_path(backup / entry["backup"], backup)) != entry["old"]:
                raise ValueError("Control-file backup changed")
        if entry["pending"] is not None:
            if file_hash(safe_path(backup / entry["pending"], backup)) != entry["new"]:
                raise ValueError("Pending index changed")
    assets = {a["target"] for o in plan["operations"] for a in o["assets"] if not a["existed"]}
    if not set(journal["asset_writes"]) <= assets:
        raise ValueError("Invalid asset journal")
    return journal


def check_controls(journal, home):
    for entry in journal["controls"]:
        sha = optional_hash(safe_path(entry["path"], home))
        if sha not in (entry["old"], entry["new"]):
            raise ValueError("Index/search cache changed after repair: {}".format(entry["path"]))


def apply_plan(plan, backup):
    home = validate_plan(plan)
    backup = outside_data(backup, plan)
    with RepairLock(home):
        resume = backup.exists()
        if resume:
            journal = load_backup(backup, plan)
            if journal["phase"] in ("rolling_back", "rolled_back"):
                raise ValueError("This backup is being/has been rolled back; generate a new plan")
        check_sessions(plan, resume)
        if not resume:
            # Reject changed snapshot destinations even if they now match the source.
            for operation in plan["operations"]:
                for asset in operation["assets"]:
                    if (optional_hash(asset["target"]) is not None) != asset["existed"]:
                        raise ValueError("Snapshot destination changed; generate a new plan")
            journal = prepare_backup(plan, backup)
        check_controls(journal, home)
        if journal["phase"] == "completed":
            report_progress("Repair: verifying previously completed repair", force=True)
            if any(not Path(o["target"]).exists() for o in plan["operations"]):
                raise ValueError("Completed repair session locations changed")
            if any(directory_fingerprint(Path(o["target"])) != o["repaired_sha256"] for o in plan["operations"]):
                raise ValueError("Completed session identity changed")
            for entry in journal["controls"]:
                if optional_hash(entry["path"]) != entry["new"]:
                    raise ValueError("Completed repair controls changed")
            for target in journal["asset_writes"]:
                assets = [a for o in plan["operations"] for a in o["assets"] if a["target"] == target]
                if optional_hash(target) != assets[0]["sha256"]:
                    raise ValueError("Completed repair snapshot copies changed")
            return
        for operation in progress_items(plan["operations"], "Repair sessions and copy referenced snapshots"):
            for asset in operation["assets"]:
                path = safe_path(asset["target"], home)
                old = optional_hash(path)
                if old is not None:
                    if old != asset["sha256"]:
                        raise ValueError("Snapshot copy changed: {}".format(path))
                    if not asset["existed"] and str(path) not in journal["asset_writes"]:
                        raise ValueError("Unjournaled snapshot destination appeared")
                    continue
                if asset["existed"]:
                    raise ValueError("Existing snapshot disappeared")
                if str(path) not in journal["asset_writes"]:
                    journal["asset_writes"].append(str(path))
                    save_journal(backup, journal)
                atomic_write(path, Path(asset["source"]).read_bytes())
                if file_hash(path) != asset["sha256"]:
                    raise ValueError("Snapshot copy verification failed")
            source, target = Path(operation["source"]), Path(operation["target"])
            if source != target and source.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                source.rename(target)
            for name, data in update_bytes(operation, "after").items():
                if (target / name).read_bytes() != data:
                    atomic_write(target / name, data)
        if journal["phase"] == "prepared":
            for number, entry in enumerate(progress_items(journal["controls"], "Prepare repaired indexes")):
                if Path(entry["path"]).name == "index.json":
                    data = index_bytes(Path(entry["path"]).parent)
                    entry["pending"] = "pending/{}.json".format(number)
                    atomic_write(backup / entry["pending"], data)
                    entry["new"] = digest(data)
                else:
                    entry["new"] = None
            journal["phase"] = "indexing"
            save_journal(backup, journal)
        for entry in progress_items(journal["controls"], "Write indexes and clear search caches"):
            path = safe_path(entry["path"], home)
            if entry["pending"]:
                atomic_write(path, (backup / entry["pending"]).read_bytes())
            elif path.exists():
                path.unlink()
        report_progress("Repair: verifying repaired catalogs", force=True)
        if any(catalog(Path(root)) != value for root, value in expected_catalogs(plan).items()):
            raise ValueError("Session catalog changed during repair")
        check_sessions(plan, True)
        journal["phase"] = "completed"
        save_journal(backup, journal)


def rollback(backup):
    report_progress("Rollback: reading backup plan", force=True)
    backup = safe_path(backup, backup)
    plan = read_json(backup / "plan.json")
    home = validate_plan(plan)
    outside_data(backup, plan)
    with RepairLock(home):
        journal = load_backup(backup, plan)
        check_sessions(plan, True)
        check_controls(journal, home)
        by_target = {a["target"]: a for o in plan["operations"] for a in o["assets"]}
        for target in journal["asset_writes"]:
            sha = optional_hash(safe_path(target, home))
            if sha is not None and sha != by_target[target]["sha256"]:
                raise ValueError("Copied snapshot changed; rollback refused: {}".format(target))
        journal["phase"] = "rolling_back"
        save_journal(backup, journal)
        for operation in progress_items(reversed(plan["operations"]), "Restore sessions",
                                        total=len(plan["operations"])):
            source, target = Path(operation["source"]), Path(operation["target"])
            location = target if target.exists() else source
            for name, data in update_bytes(operation, "before").items():
                if (location / name).read_bytes() != data:
                    atomic_write(location / name, data)
            if source != target and target.exists():
                source.parent.mkdir(parents=True, exist_ok=True)
                target.rename(source)
        for entry in progress_items(journal["controls"], "Restore indexes and search caches"):
            path = safe_path(entry["path"], home)
            if entry["old"] is not None:
                atomic_write(path, (backup / entry["backup"]).read_bytes())
            elif path.exists():
                path.unlink()
        for target in progress_items(journal["asset_writes"], "Remove snapshot copies created by repair"):
            path = safe_path(target, home)
            if path.exists():
                path.unlink()
        for directory in sorted(journal["created_directories"], key=lambda p: len(Path(p).parts), reverse=True):
            path = safe_path(directory, home)
            try:
                path.rmdir()
            except FileNotFoundError:
                pass
            except OSError as error:
                if error.errno not in (errno.ENOTEMPTY, errno.EEXIST):
                    raise
        journal["phase"] = "rolled_back"
        save_journal(backup, journal)


def default_user_root():
    if os.name == "nt":
        return Path(os.environ["APPDATA"]) / "openbitfun"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "openbitfun"
    return Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "openbitfun"


def main():
    global PROGRESS
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, help="Product data root (default: ~/.openbitfun)")
    parser.add_argument("--user-root", type=Path, help="Config root containing data/workspace_data.json")
    parser.add_argument("--plan", type=Path, help="Output plan, or existing plan with --apply")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true", help="Apply an existing plan")
    mode.add_argument("--rollback", type=Path, metavar="BACKUP_DIR", help="Roll back a repair")
    parser.add_argument("--backup-dir", type=Path, help="New backup directory; same directory to resume")
    parser.add_argument("--confirm-closed", action="store_true", help="Confirm all data-owning hosts are stopped")
    args = parser.parse_args()
    PROGRESS = ProgressReporter()
    PROGRESS.start()
    try:
        if args.rollback:
            report_progress("Rollback: checking that OpenBitFun hosts are stopped", force=True)
            check_closed(args.confirm_closed)
            rollback(args.rollback.absolute())
            print("Rollback completed; backup retained.")
        elif args.apply:
            if not args.plan or not args.backup_dir:
                parser.error("--apply requires --plan and --backup-dir")
            report_progress("Repair: checking that OpenBitFun hosts are stopped", force=True)
            check_closed(args.confirm_closed)
            plan = read_json(args.plan)
            apply_plan(plan, args.backup_dir.absolute())
            print("Repair completed: {} sessions. Backup: {}".format(len(plan["operations"]), args.backup_dir))
        else:
            if not args.plan:
                parser.error("--plan is required")
            home = args.home or Path(os.environ.get("OPENBITFUN_HOME", str(Path.home() / ".openbitfun")))
            user_root = args.user_root or Path(os.environ.get("OPENBITFUN_USER_ROOT") or default_user_root())
            plan = make_plan(home.absolute(), user_root.absolute())
            output = outside_data(args.plan.absolute(), plan)
            if output.exists():
                raise ValueError("Plan output already exists; choose a new filename")
            report_progress("Plan: writing {}".format(output), force=True)
            atomic_write(output, encoded(plan))
            print("Read-only plan: {} repairs, {} skipped, {} already correct.".format(
                len(plan["operations"]), sum(d["status"] == "skipped" for d in plan["diagnostics"]),
                sum(d["status"] == "correct" for d in plan["diagnostics"])))
            for operation in plan["operations"]:
                preview = " ".join(operation["session_name"].split())
                preview = preview[:80] + ("..." if len(preview) > 80 else "")
                print("REPAIR {}: {} -> {}; identity files: {}".format(
                    preview, operation["source"], operation["target"],
                    ", ".join(operation["file_updates"]) or "none"))
            print("Review diagnostics and operations in {} before applying.".format(output))
        return 0
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        print("ERROR: {}".format(error), file=sys.stderr)
        return 1
    finally:
        PROGRESS.stop()
        PROGRESS = None


if __name__ == "__main__":
    sys.exit(main())
