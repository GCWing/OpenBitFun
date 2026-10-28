"""POSIX target helper embedded by the workspace package transfer service."""
import contextlib
import fcntl
import hashlib
import json
import os
import shutil
import stat
import sys
import uuid
import zipfile

MANIFEST = ".openbitfun-package-manifest.json"


def plain_directory(path):
    if not os.path.lexists(path):
        os.mkdir(path, 0o700)
    if not stat.S_ISDIR(os.lstat(path).st_mode):
        raise ValueError("Skill cache path must be a directory without symbolic links: " + path)


def cache_directory(path, workspace):
    # The selected workspace may have ordinary symlink ancestors (for example
    # macOS /var and /tmp). Resolve only that trusted boundary, never a
    # repository-controlled component of the managed cache below it.
    workspace_parts = [part for part in workspace.split("/") if part]
    cache_parts = [part for part in path.split("/") if part]
    if (len(cache_parts) <= len(workspace_parts)
            or cache_parts[:len(workspace_parts)] != workspace_parts):
        raise ValueError("Skill package cache must be inside the selected remote workspace")
    current = os.path.realpath(workspace)
    if not os.path.isdir(current):
        raise ValueError("Selected remote workspace is not a directory")
    for component in cache_parts[len(workspace_parts):]:
        current = os.path.join(current, component)
        plain_directory(current)
    if os.stat(current).st_uid != os.geteuid():
        raise ValueError("Skill cache must be owned by the target user")


def manifest_entries(raw, expected_hash):
    if hashlib.sha256(raw).hexdigest() != expected_hash:
        raise ValueError("Skill package manifest checksum mismatch")
    data = json.loads(raw)
    if data.get("version") != 1:
        raise ValueError("Unsupported Skill package manifest version")
    entries = {}
    for entry in data["entries"]:
        name = entry["path"]
        if (not isinstance(name, str) or not name or name == MANIFEST
                or "\\" in name or "\0" in name or name.startswith("/")
                or any(part in ("", ".", "..") for part in name.split("/"))):
            raise ValueError("Invalid Skill package relative path")
        if name in entries or entry["kind"] not in ("file", "directory"):
            raise ValueError("Invalid or duplicate Skill package entry")
        if not isinstance(entry["mode"], int) or not 0 <= entry["mode"] <= 0o777:
            raise ValueError("Invalid Skill package permissions")
        entries[name] = entry
    return entries


def verify(root, digest):
    try:
        if not stat.S_ISDIR(os.lstat(root).st_mode):
            return False
        manifest_path = os.path.join(root, MANIFEST)
        if not stat.S_ISREG(os.lstat(manifest_path).st_mode):
            return False
        with open(manifest_path, "rb") as stream:
            entries = manifest_entries(stream.read(), digest)
        seen = set()
        def unreadable(error):
            raise error
        for directory, dirs, files in os.walk(root, followlinks=False, onerror=unreadable):
            for name in dirs + files:
                full = os.path.join(directory, name)
                relative = os.path.relpath(full, root).replace(os.sep, "/")
                if relative == MANIFEST:
                    continue
                expected = entries.get(relative)
                if expected is None:
                    return False
                metadata = os.lstat(full)
                if stat.S_IMODE(metadata.st_mode) != expected["mode"]:
                    return False
                if expected["kind"] == "directory":
                    if not stat.S_ISDIR(metadata.st_mode):
                        return False
                else:
                    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != expected["size"]:
                        return False
                    content_hash = hashlib.sha256()
                    with open(full, "rb") as stream:
                        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                            content_hash.update(chunk)
                    if content_hash.hexdigest() != expected["sha256"]:
                        return False
                seen.add(relative)
        return seen == set(entries)
    except (OSError, ValueError, KeyError, TypeError):
        return False


def unpack(archive, staging, digest):
    with zipfile.ZipFile(archive) as package:
        raw = package.read(MANIFEST)
        entries = manifest_entries(raw, digest)
        expected_names = {MANIFEST} | {
            name + ("/" if entry["kind"] == "directory" else "")
            for name, entry in entries.items()
        }
        names = package.namelist()
        if len(names) != len(expected_names) or set(names) != expected_names:
            raise ValueError("Skill package archive entries do not match its manifest")
        os.mkdir(staging, 0o700)
        for name, entry in sorted(entries.items()):
            path = os.path.join(staging, name)
            if entry["kind"] == "directory":
                os.makedirs(path, exist_ok=True)
            else:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with package.open(name) as source, open(path, "xb") as destination:
                    shutil.copyfileobj(source, destination, 1024 * 1024)
                os.chmod(path, entry["mode"])
        with open(os.path.join(staging, MANIFEST), "xb") as stream:
            stream.write(raw)
        for name, entry in sorted(entries.items(), reverse=True):
            if entry["kind"] == "directory":
                os.chmod(os.path.join(staging, name), entry["mode"])
    if not verify(staging, digest):
        raise ValueError("Extracted Skill package failed full integrity verification")


def main():
    action, cache, workspace, package_id, digest, upload_name = sys.argv[1:]
    for path in (cache, workspace):
        if (not path.startswith("/") or "\0" in path
                or any(part in (".", "..") for part in path.split("/"))):
            raise ValueError("Skill cache and workspace require absolute POSIX paths")
    for identifier in (package_id, digest):
        if len(identifier) != 64 or any(char not in "0123456789abcdef" for char in identifier):
            raise ValueError("Invalid Skill package identity")
    cache_directory(cache, workspace)
    parent = os.path.join(cache, package_id)
    plain_directory(parent)
    target = os.path.join(parent, digest)
    # The package lock serializes atomic publication across runtime processes.
    lock_path = os.path.join(parent, ".lock")
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if verify(target, digest):
            print(json.dumps({"path": target, "reused": True}))
            return
        if action == "check":
            print(json.dumps({"path": target, "reused": False}))
            return
        if action != "publish" or not upload_name.startswith(".upload-") or "/" in upload_name:
            raise ValueError("Invalid Skill package publication request")
        archive = os.path.join(parent, upload_name)
        if not stat.S_ISREG(os.lstat(archive).st_mode):
            raise ValueError("Skill package upload must be a regular file")
        staging = os.path.join(parent, ".staging-" + uuid.uuid4().hex)
        previous = os.path.join(parent, ".previous-" + uuid.uuid4().hex)
        moved_previous = False
        try:
            unpack(archive, staging, digest)
            if os.path.lexists(target):
                if not stat.S_ISDIR(os.lstat(target).st_mode):
                    raise ValueError("Existing Skill deployment is not a plain directory")
                os.rename(target, previous)
                moved_previous = True
            try:
                os.rename(staging, target)
            except BaseException:
                if moved_previous:
                    os.rename(previous, target)
                    moved_previous = False
                raise
            if moved_previous:
                # Publication already committed. Cleanup must not turn a valid
                # deployment into a reported failure (for example read-only dirs).
                with contextlib.suppress(OSError):
                    shutil.rmtree(previous)
        finally:
            if os.path.lexists(staging):
                with contextlib.suppress(OSError):
                    shutil.rmtree(staging)
            with contextlib.suppress(OSError):
                os.unlink(archive)
        print(json.dumps({"path": target, "reused": False}))


try:
    main()
except Exception as error:
    print("Skill package synchronization failed: " + str(error), file=sys.stderr)
    sys.exit(1)
