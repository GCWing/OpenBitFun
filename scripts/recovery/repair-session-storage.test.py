"""Focused offline recovery tests; all data is created in temporary fixtures."""

import copy
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("repair-session-storage.py")
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("repair_session_storage", SCRIPT)
repair = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(repair)


class RepairTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="session-repair-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.home, self.user = self.base / "home", self.base / "user"
        self.home.mkdir()
        self.registry = {"format_version": 1, "product_id": "openbitfun", "workspaces": {}}
        self.workspaces = {}
        for name in ("GameOps", "武林手游", "天子编辑器"):
            root = self.base / "workspaces" / name
            root.mkdir(parents=True)
            wid = "local_" + hashlib.sha256(name.encode()).hexdigest()[:32]
            self.registry["workspaces"][wid] = {"id": wid, "rootPath": str(root),
                                               "workspaceKind": "normal", "name": name}
            self.workspaces[name] = (wid, root)
        self.save_registry()
        self.source_root = self.home / "projects" / "old-collided-slug" / "sessions"
        self.source_root.mkdir(parents=True)
        self.backup = self.base / "backup"

    def save_registry(self):
        repair.atomic_write(self.user / "data" / "workspace_data.json", repair.encoded(self.registry))

    def session(self, sid="session-one", workspace="GameOps", root=None, kind="standard"):
        wid, path = self.workspaces[workspace]
        directory = (root or self.source_root) / sid
        directory.mkdir(parents=True)
        meta = {"schema_version": 2, "sessionId": sid, "sessionName": workspace + " session",
                "workspaceId": wid, "projectWorkspaceId": wid, "workspacePath": str(path),
                "projectWorkspacePath": str(path), "workspaceHostname": "localhost",
                "executionTarget": {"kind": "local", "rootPath": str(path)},
                "sessionKind": kind, "lastActiveAt": 1234, "turnCount": 305,
                "agentType": "Cowork", "modelName": "deepseek-v4-flash", "createdAt": 1000,
                "messageCount": 1977, "toolCallCount": 5974, "status": "active",
                "customMetadata": {"unknownFutureField": True}}
        config = {"workspace_id": wid, "project_workspace_id": wid,
                  "workspace_path": str(path), "project_workspace_path": str(path),
                  "workspace_kind": "normal", "execution_target": meta["executionTarget"],
                  "permission_mode": "auto_approve"}
        self.write(directory / "metadata.json", meta)
        self.write(directory / "state.json", {"schema_version": 2, "config": config,
                                               "snapshot_session_id": None})
        for name in ("turns/turn-0001.json", "snapshots/context-0001.json",
                     "artifacts/attachments.bin", "prompt_cache.json", "token-anchors.json"):
            repair.atomic_write(directory / name, b"preserved bytes\x00\xff")
        (directory / "empty-directory").mkdir()
        return directory

    def write(self, path, value):
        repair.atomic_write(path, repair.encoded(value))

    def target_root(self, name="GameOps"):
        return self.home / "projects" / repair.runtime_key(self.workspaces[name][1]) / "sessions"

    def plan(self):
        return repair.make_plan(self.home, self.user)

    def snapshot(self, sid, file, inline=False):
        runtime = self.source_root.parent
        content = b"old file contents"
        md5 = hashlib.md5(content).hexdigest()
        category = "baselines" if sid.startswith("baseline_") else "metadata"
        value = {"snapshot_id": sid, "file_path": str(file), "content_hash": md5,
                 "compressed_content": [1, 2, 3] if inline else []}
        self.write(runtime / "snapshots" / category / (sid + ".json"), value)
        if not inline:
            repair.atomic_write(runtime / "snapshots" / "by_hash" / (md5 + ".snap"), content)

    def test_plan_and_index_reuse_metadata_reads(self):
        session, _, _ = self.assistant_fixture(move=True, old_paths=True)
        read_bytes = Path.read_bytes
        reads = []

        def tracked_read(path):
            reads.append(path)
            return read_bytes(path)

        with patch.object(Path, "read_bytes", tracked_read):
            plan = self.plan()
        self.assertEqual(len(plan["operations"]), 1, plan["diagnostics"])
        self.assertEqual(reads.count(session / "metadata.json"), 1)
        self.assertEqual(reads.count(session / "state.json"), 1)
        self.assertEqual(set(plan["operations"][0]["file_updates"]),
                         {"metadata.json", "state.json"})
        reads.clear()
        with patch.object(Path, "read_bytes", tracked_read):
            repair.index_bytes(session.parent)
        self.assertEqual(reads.count(session / "metadata.json"), 1)

    def test_before_after_fingerprints_share_directory_enumeration(self):
        session, _, _ = self.assistant_fixture(move=True, old_paths=True)
        with patch.object(repair, "directory_manifest", wraps=repair.directory_manifest) as scan:
            plan = self.plan()
        self.assertEqual(len(plan["operations"]), 1, plan["diagnostics"])
        self.assertEqual(scan.call_count, 1)
        self.assertEqual(scan.call_args.args[0], session)
        with patch.object(repair, "directory_manifest", wraps=repair.directory_manifest) as scan:
            repair.validate_plan(plan)
        self.assertEqual(scan.call_count, 1)

    def test_collision_apply_indexes_preservation_backup_resume_and_rollback(self):
        sessions = [self.session("session-" + str(i), name) for i, name in enumerate(self.workspaces)]
        before = {s.name: repair.directory_fingerprint(s) for s in sessions}
        self.write(self.source_root / "index.json", {"old": "raw legacy index"})
        repair.atomic_write(self.source_root / repair.CACHE_NAMES[0], b"old sqlite bytes")
        hidden = self.session("hidden", root=self.target_root(), kind="subagent")
        legacy_hidden = self.session("leaked", root=self.target_root())
        meta = repair.read_json(legacy_hidden / "metadata.json")
        meta.update({"createdBy": "session-parent", "sessionName": "Subagent: Review"})
        self.write(legacy_hidden / "metadata.json", meta)
        original_index = (self.source_root / "index.json").read_bytes()
        original_home = repair.directory_fingerprint(self.home)
        plan = self.plan()
        self.assertEqual(len(plan["operations"]), 3)
        self.assertEqual(repair.directory_fingerprint(self.home), original_home, "planning must be read-only")
        repair.apply_plan(plan, self.backup)
        for number, operation in enumerate(plan["operations"]):
            target = Path(operation["target"])
            self.assertFalse(Path(operation["source"]).exists())
            self.assertEqual(repair.directory_fingerprint(target), before[target.name])
            self.assertEqual(repair.directory_fingerprint(self.backup / "sessions" / str(number)), before[target.name])
        index = repair.read_json(self.target_root() / "index.json")
        self.assertEqual(index["metadata_file_count"], 3)
        self.assertEqual(len(index["sessions"]), 1)
        self.assertTrue(index["sessions"][0]["customMetadata"]["unknownFutureField"])
        self.assertNotIn("schema_version", index["sessions"][0])
        self.assertEqual(repair.read_json(self.source_root / "index.json")["sessions"], [])
        self.assertFalse((self.source_root / repair.CACHE_NAMES[0]).exists())
        repaired_home = repair.directory_fingerprint(self.home)
        repair.apply_plan(plan, self.backup)
        self.assertEqual(repair.directory_fingerprint(self.home), repaired_home, "completed rerun must be a no-op")
        repair.rollback(self.backup)
        self.assertEqual((self.source_root / "index.json").read_bytes(), original_index)
        self.assertEqual((self.source_root / repair.CACHE_NAMES[0]).read_bytes(), b"old sqlite bytes")
        for session in sessions:
            self.assertEqual(repair.directory_fingerprint(session), before[session.name])
        self.assertTrue(hidden.exists())
        self.assertEqual(repair.directory_fingerprint(self.home), original_home)
        repair.rollback(self.backup)
        self.assertEqual(repair.read_json(self.backup / "journal.json")["phase"], "rolled_back")

    def test_state_and_registry_disagreement_skipped(self):
        session = self.session()
        state = repair.read_json(session / "state.json")
        state["config"]["workspace_id"] = "local_other"
        self.write(session / "state.json", state)
        plan = self.plan()
        self.assertEqual(plan["operations"], [])
        self.assertIn("disagree", plan["diagnostics"][0]["reason"])
        state["config"]["workspace_id"] = self.workspaces["GameOps"][0]
        self.write(session / "state.json", state)
        self.registry["workspaces"][self.workspaces["GameOps"][0]]["rootPath"] = str(self.workspaces["武林手游"][1])
        self.save_registry()
        self.assertEqual(self.plan()["operations"], [])

    def test_legacy_path_and_metadata_only(self):
        session = self.session()
        meta = repair.read_json(session / "metadata.json")
        for field in ("workspaceId", "projectWorkspaceId"):
            meta.pop(field)
        self.write(session / "metadata.json", meta)
        (session / "state.json").unlink()
        self.assertEqual(len(self.plan()["operations"]), 1)
        wid, root = self.workspaces["GameOps"]
        self.registry["workspaces"]["duplicate"] = {"id": "duplicate", "rootPath": str(root)}
        self.save_registry()
        self.assertEqual(self.plan()["operations"], [])

    def test_legacy_aliases_hidden_sessions_and_metadata_snapshot_owner(self):
        session = self.session(kind="ephemeral_child")
        meta = repair.read_json(session / "metadata.json")
        meta["snapshotSessionId"] = "parent-history"
        for key in ("sessionId", "sessionName", "agentType", "modelName", "createdAt", "lastActiveAt",
                    "turnCount", "messageCount", "toolCallCount", "workspacePath", "workspaceId",
                    "sessionKind"):
            alias = repair.re.sub(r"([A-Z])", lambda m: "_" + m.group(1).lower(), key)
            meta[alias] = meta.pop(key)
        self.write(session / "metadata.json", meta)
        self.write(self.source_root.parent / "snapshots/operations/parent-history.json",
                   {"session_id": "parent-history", "turns": {}})
        plan = self.plan()
        self.assertEqual(len(plan["operations"]), 1)
        self.assertEqual(len(plan["operations"][0]["assets"]), 1)
        repair.apply_plan(plan, self.backup)
        index = repair.read_json(self.target_root() / "index.json")
        self.assertEqual(index["metadata_file_count"], 1)
        self.assertEqual(index["sessions"], [])
        self.assertEqual(repair.read_json(Path(plan["operations"][0]["target"]) / "metadata.json"), meta)
        repair.rollback(self.backup)

    def test_invalid_required_metadata_and_changed_index_block_repair(self):
        session = self.session()
        meta = repair.read_json(session / "metadata.json")
        invalid = dict(meta, turnCount="305")
        self.write(session / "metadata.json", invalid)
        self.assertEqual(self.plan()["operations"], [])
        self.write(session / "metadata.json", meta)
        plan = self.plan()
        repair.apply_plan(plan, self.backup)
        index = self.target_root() / "index.json"
        original = index.read_bytes()
        repair.atomic_write(index, b"changed by another writer")
        with self.assertRaises(ValueError):
            repair.apply_plan(plan, self.backup)
        with self.assertRaises(ValueError):
            repair.rollback(self.backup)
        self.assertEqual(index.read_bytes(), b"changed by another writer")
        repair.atomic_write(index, original)
        repair.rollback(self.backup)

    def test_remote_linked_worktree_and_missing_workspace_skip(self):
        for kind in ("remote", "worktree"):
            session = self.session("session-" + kind)
            state = repair.read_json(session / "state.json")
            state["config"]["workspace_kind"] = kind
            self.write(session / "state.json", state)
        missing = self.session("missing")
        shutil.rmtree(self.workspaces["GameOps"][1])
        (self.home / "remote_ssh").mkdir()
        plan = self.plan()
        self.assertFalse(plan["operations"])
        self.assertEqual(len(plan["diagnostics"]), 3)
        self.assertTrue(missing.exists())

    def test_destination_and_duplicate_conflicts(self):
        self.session()
        self.session(root=self.target_root())
        self.assertEqual(self.plan()["operations"], [])
        shutil.rmtree(self.target_root())
        self.session(root=self.home / "projects" / "another-slug" / "sessions")
        plan = self.plan()
        self.assertEqual(plan["operations"], [])
        self.assertTrue(all("Multiple source" in d["reason"] for d in plan["diagnostics"]))

    def test_malformed_neighbor_blocks_index_rebuild(self):
        self.session()
        bad = self.session("bad")
        repair.atomic_write(bad / "metadata.json", b"{not json}")
        self.assertEqual(self.plan()["operations"], [])
        shutil.rmtree(bad)
        self.session("bad", root=self.target_root())
        repair.atomic_write(self.target_root() / "bad" / "metadata.json", b"{not json}")
        self.assertEqual(self.plan()["operations"], [])

    def test_shared_snapshots_baselines_revert_inline_and_history(self):
        session = self.session()
        workspace = self.workspaces["GameOps"][1]
        self.snapshot("before-one", workspace / "one.txt")
        self.snapshot("after-one", workspace / "one.txt", inline=True)
        self.snapshot("baseline_one", workspace / "one.txt")
        self.snapshot("baseline_revert", workspace / "one.txt", inline=True)
        self.snapshot("baseline_unreferenced", workspace / "one.txt")
        self.snapshot("baseline_other", self.workspaces["武林手游"][1] / "two.txt")
        self.snapshot("revert-one", workspace / "one.txt", inline=True)
        runtime = self.source_root.parent
        history = runtime / "snapshots" / "operations" / "shared-history.json"
        self.write(history, {"session_id": "shared-history", "turns": {"0": {"operations": [
            {"before_snapshot_id": "before-one", "after_snapshot_id": "after-one"},
            {"before_snapshot_id": "baseline_one", "after_snapshot_id": "after-one"}]}}})
        state = repair.read_json(session / "state.json")
        state["snapshot_session_id"] = "shared-history"
        self.write(session / "state.json", state)
        self.write(session / "session-revert.json", {"schemaVersion": 1, "boundaryTurn": 2,
                                                   "workspaceCheckpoint": [{"path": str(workspace / "one.txt"),
                                                                            "snapshotId": "revert-one"},
                                                                           {"snapshotId": "baseline_revert"}]})
        plan = self.plan()
        self.assertEqual(len(plan["operations"]), 1)
        assets = plan["operations"][0]["assets"]
        self.assertTrue(any("baseline_one" in a["source"] for a in assets))
        self.assertTrue(any("baseline_revert" in a["source"] for a in assets))
        self.assertFalse(any("baseline_unreferenced" in a["source"] for a in assets))
        self.assertFalse(any("baseline_other" in a["source"] for a in assets))
        repair.apply_plan(plan, self.backup)
        repair.apply_plan(plan, self.backup)
        for asset in assets:
            self.assertEqual(Path(asset["source"]).read_bytes(), Path(asset["target"]).read_bytes())
        repair.rollback(self.backup)
        for asset in assets:
            self.assertTrue(Path(asset["source"]).exists())
            self.assertFalse(Path(asset["target"]).exists())

    def test_unreferenced_baselines_are_never_scanned_or_read(self):
        self.session()
        baselines = self.source_root.parent / "snapshots" / "baselines"
        unrelated = baselines / "baseline_unreferenced.json"
        repair.atomic_write(unrelated, b"invalid unrelated baseline JSON")
        iterdir, read_bytes = Path.iterdir, Path.read_bytes

        def guarded_iterdir(path):
            if path == baselines:
                self.fail("Workspace baselines must not be enumerated")
            return iterdir(path)

        def guarded_read(path):
            if path == unrelated:
                self.fail("Unreferenced baseline must not be read")
            return read_bytes(path)

        with patch.object(Path, "iterdir", guarded_iterdir), patch.object(Path, "read_bytes", guarded_read):
            plan = self.plan()
            self.assertEqual(len(plan["operations"]), 1, plan["diagnostics"])
            self.assertEqual(plan["operations"][0]["assets"], [])
            repair.apply_plan(plan, self.backup)
            repair.apply_plan(plan, self.backup)
            repair.rollback(self.backup)
        self.assertEqual(unrelated.read_bytes(), b"invalid unrelated baseline JSON")

    def test_missing_explicit_baseline_reference_blocks_repair(self):
        session = self.session()
        self.snapshot("baseline_one", self.workspaces["GameOps"][1] / "one.txt")
        self.write(session / "session-revert.json", {"snapshotId": "baseline_one"})
        plan = self.plan()
        self.assertEqual(len(plan["operations"]), 1, plan["diagnostics"])
        (self.source_root.parent / "snapshots/baselines/baseline_one.json").unlink()
        with self.assertRaisesRegex(ValueError, "Missing snapshot dependency"):
            repair.apply_plan(plan, self.backup)
        self.assertEqual(self.plan()["operations"], [])
        self.assertTrue(session.exists())

    def test_snapshot_conflict_and_missing_blob_skip(self):
        session = self.session()
        workspace = self.workspaces["GameOps"][1]
        self.snapshot("snap-one", workspace / "one.txt")
        self.write(session / "session-revert.json", {"snapshot_id": "snap-one"})
        plan = self.plan()
        asset = next(a for a in plan["operations"][0]["assets"] if a["target"].endswith("snap-one.json"))
        repair.atomic_write(Path(asset["target"]), b"conflicting snapshot")
        self.assertEqual(self.plan()["operations"], [])
        Path(asset["target"]).unlink()
        for blob in (self.source_root.parent / "snapshots" / "by_hash").iterdir():
            blob.unlink()
        self.assertEqual(self.plan()["operations"], [])

    def test_existing_identical_snapshot_preserved_by_rollback(self):
        session = self.session()
        self.snapshot("snap-one", self.workspaces["GameOps"][1] / "one.txt", inline=True)
        self.write(session / "session-revert.json", {"snapshot_id": "snap-one"})
        asset = self.plan()["operations"][0]["assets"][0]
        repair.atomic_write(Path(asset["target"]), Path(asset["source"]).read_bytes())
        plan = self.plan()
        self.assertTrue(plan["operations"][0]["assets"][0]["existed"])
        repair.apply_plan(plan, self.backup)
        repair.rollback(self.backup)
        self.assertTrue(Path(asset["target"]).exists())

    def test_stale_plan_registry_session_neighbor_target_and_crafted_path(self):
        session = self.session()
        plan = self.plan()
        repair.atomic_write(session / "new-turn.json", b"new")
        with self.assertRaises(ValueError):
            repair.apply_plan(plan, self.backup)
        (session / "new-turn.json").unlink()
        self.session("new-neighbor")
        with self.assertRaises(ValueError):
            repair.apply_plan(plan, self.backup)
        shutil.rmtree(self.source_root / "new-neighbor")
        self.registry["extra"] = True
        self.save_registry()
        with self.assertRaises(ValueError):
            repair.apply_plan(plan, self.backup)
        plan = self.plan()
        bad = copy.deepcopy(plan)
        bad["operations"][0]["target"] = str(self.base / "arbitrary-target")
        with self.assertRaises(ValueError):
            repair.apply_plan(bad, self.backup)
        self.session(root=self.target_root())
        with self.assertRaises(ValueError):
            repair.apply_plan(plan, self.backup)
        self.assertFalse(self.backup.exists())

    def test_resume_and_rollback_after_interrupted_move(self):
        session = self.session()
        self.write(self.source_root / "index.json", {"original": True})
        plan = self.plan()
        with patch.object(repair, "index_bytes", side_effect=OSError("simulated interruption")):
            with self.assertRaises(OSError):
                repair.apply_plan(plan, self.backup)
        self.assertFalse(session.exists())
        repair.apply_plan(plan, self.backup)
        self.assertEqual(len(repair.read_json(self.target_root() / "index.json")["sessions"]), 1)
        repair.rollback(self.backup)
        self.assertTrue(session.exists())
        self.assertEqual(repair.read_json(self.source_root / "index.json"), {"original": True})

    def test_rollback_directly_after_interrupted_index_write_and_resume_rollback(self):
        session = self.session()
        plan = self.plan()
        original = repair.atomic_write
        count = [0]

        def fail(path, data):
            if Path(path).name == "index.json" and self.home in Path(path).parents:
                count[0] += 1
                if count[0] == 2:
                    raise OSError("simulated interruption")
            return original(path, data)

        with patch.object(repair, "atomic_write", side_effect=fail):
            with self.assertRaises(OSError):
                repair.apply_plan(plan, self.backup)
        with patch.object(repair, "atomic_write", side_effect=OSError("rollback interruption")):
            with self.assertRaises(OSError):
                repair.rollback(self.backup)
        repair.rollback(self.backup)
        self.assertTrue(session.exists())

    def test_rollback_refuses_changes_after_application(self):
        self.session()
        plan = self.plan()
        repair.apply_plan(plan, self.backup)
        target = Path(plan["operations"][0]["target"])
        repair.atomic_write(target / "new-turn.json", b"new user data")
        with self.assertRaises(ValueError):
            repair.rollback(self.backup)
        (target / "new-turn.json").unlink()
        self.session("new-session", root=self.target_root())
        with self.assertRaises(ValueError):
            repair.rollback(self.backup)
        self.assertTrue(target.exists())

    def test_links_junction_attributes_and_backup_confinement(self):
        session = self.session()
        if os.name == "nt":
            # Junctions do not require Windows developer mode or symlink privileges.
            result = subprocess.run(["cmd", "/c", "mklink", "/J", str(session / "linked"),
                                     str(self.workspaces["GameOps"][1])], capture_output=True,
                                    creationflags=subprocess.CREATE_NO_WINDOW)
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            (session / "linked").symlink_to(self.workspaces["GameOps"][1], target_is_directory=True)
        self.addCleanup(lambda: (os.rmdir(session / "linked") if os.name == "nt"
                                 else (session / "linked").unlink())
                        if os.path.lexists(session / "linked") else None)
        self.assertEqual(self.plan()["operations"], [])
        with self.assertRaises(ValueError):
            repair.directory_fingerprint(session)
        if os.name == "nt":
            os.rmdir(session / "linked")
        else:
            (session / "linked").unlink()
        plan = self.plan()
        with self.assertRaises(ValueError):
            repair.apply_plan(plan, self.home / "backup")

    def test_cli_read_only_and_closed_confirmation(self):
        self.session()
        self.write(self.source_root / "index.json", {"sessions": []})
        before = repair.directory_fingerprint(self.home)
        output = self.base / "plan.json"
        result = subprocess.run([sys.executable, str(SCRIPT), "--home", str(self.home),
                                 "--user-root", str(self.user), "--plan", str(output)],
                                capture_output=True, **({"creationflags": subprocess.CREATE_NO_WINDOW}
                                                        if os.name == "nt" else {}))
        self.assertEqual(result.returncode, 0, result.stderr)
        progress = result.stderr.decode(errors="replace")
        self.assertIn("[Progress", progress)
        self.assertIn("Plan sessions in", progress)
        self.assertIn("1 / 1 completed", progress)
        self.assertNotIn(b"[Progress", result.stdout)
        self.assertEqual(repair.directory_fingerprint(self.home), before)
        self.assertEqual(len(repair.read_json(output)["operations"]), 1)
        with self.assertRaises(ValueError):
            repair.check_closed(False)
        if os.name == "nt":
            with patch.object(repair.subprocess, "run", return_value=subprocess.CompletedProcess(
                    [], 0, b'"openbitfun-cli.exe","1234"\n')):
                with self.assertRaises(ValueError):
                    repair.check_closed(True)

    def test_progress_refreshes_during_blocking_work_and_stops(self):
        refreshed = threading.Event()

        class RecordingStream(io.StringIO):
            def flush(stream):
                if stream.getvalue().count("[Progress") >= 2:
                    refreshed.set()

        output = RecordingStream()
        reporter = repair.ProgressReporter(output, interval=0.01)
        reporter.message = "Back up sessions: 0 / 1 completed; large-session"
        reporter.start()
        try:
            self.assertTrue(refreshed.wait(2), "Blocked work should still report progress")
        finally:
            reporter.stop()
        self.assertFalse(reporter.thread.is_alive())
        self.assertIn("large-session", output.getvalue())
        self.assertNotIn("1 / 1 completed", output.getvalue())

    def test_apply_and_rollback_progress_counts(self):
        self.session()
        plan = self.plan()
        output = io.StringIO()
        reporter = repair.ProgressReporter(output, interval=0)
        with patch.object(repair, "PROGRESS", reporter):
            repair.apply_plan(plan, self.backup)
            repair.rollback(self.backup)
        messages = output.getvalue()
        for stage in ("Validate sessions and snapshot dependencies", "Back up sessions",
                      "Repair sessions and copy referenced snapshots", "Restore sessions"):
            self.assertIn(stage + ": 0 / 1 completed", messages)
            self.assertIn(stage + ": 1 / 1 completed", messages)

    def test_snapshot_copy_interruption_and_unjournaled_destinations(self):
        session = self.session()
        self.snapshot("snap-one", self.workspaces["GameOps"][1] / "one.txt", inline=True)
        self.write(session / "session-revert.json", {"snapshot_id": "snap-one"})
        plan = self.plan()
        asset = plan["operations"][0]["assets"][0]
        original = repair.atomic_write

        def fail(path, data):
            if str(path) == asset["target"]:
                raise OSError("interrupted snapshot copy")
            return original(path, data)

        with patch.object(repair, "atomic_write", side_effect=fail):
            with self.assertRaises(OSError):
                repair.apply_plan(plan, self.backup)
        self.assertTrue(session.exists())
        repair.apply_plan(plan, self.backup)
        repair.rollback(self.backup)
        plan = self.plan()
        repair.atomic_write(Path(asset["target"]), Path(asset["source"]).read_bytes())
        with self.assertRaises(ValueError):
            repair.apply_plan(plan, self.base / "another-backup")
        self.assertTrue(session.exists())

    def test_rollback_resumes_after_one_of_multiple_moves_is_restored(self):
        sessions = [self.session("session-" + str(i), name) for i, name in enumerate(self.workspaces)]
        plan = self.plan()
        repair.apply_plan(plan, self.backup)
        original = Path.rename
        count = [0]

        def fail(path, destination):
            count[0] += 1
            if count[0] == 2:
                raise OSError("interrupted rollback rename")
            return original(path, destination)

        with patch.object(Path, "rename", new=fail):
            with self.assertRaises(OSError):
                repair.rollback(self.backup)
        repair.rollback(self.backup)
        self.assertTrue(all(s.exists() for s in sessions))

    def assistant_fixture(self, move=False, old_paths=False):
        home = self.base / ".openbitfun"
        home.mkdir()
        self.home = home
        self.source_root = home / "projects/old-collided-slug/sessions"
        self.source_root.mkdir(parents=True)
        root = home / "personal_assistant/workspace-assistant"
        root.mkdir(parents=True)
        wid = "local_" + repair.digest(("localhost\n" + str(root).replace("\\", "/")).encode())[:32]
        self.registry["workspaces"][wid] = {"id": wid, "rootPath": str(root), "workspaceKind": "assistant"}
        self.workspaces["Assistant"] = (wid, root)
        self.save_registry()
        session = self.session("assistant-session", "Assistant", root=None if move else self.target_root("Assistant"))
        alias_id, mapping = next(iter(repair.assistant_aliases(home, self.registry["workspaces"]).items()))
        for name in ("metadata.json", "state.json"):
            value = repair.read_json(session / name)
            container = value if name == "metadata.json" else value["config"]
            for key in (("workspaceId", "projectWorkspaceId") if name == "metadata.json"
                        else ("workspace_id", "project_workspace_id")):
                container[key] = alias_id
            if old_paths:
                for key in (("workspacePath", "projectWorkspacePath") if name == "metadata.json"
                            else ("workspace_path", "project_workspace_path")):
                    container[key] = mapping["old_path"]
                container["executionTarget" if name == "metadata.json" else "execution_target"]["rootPath"] = mapping["old_path"]
            self.write(session / name, value)
        return session, wid, alias_id

    def test_assistant_identity_only_repair_preserves_unknown_data_and_rollback_bytes(self):
        session, wid, alias = self.assistant_fixture()
        state = repair.read_json(session / "state.json")
        state["config"]["unknownFutureField"] = {"keep": True}
        self.write(session / "state.json", state)
        original = repair.directory_fingerprint(self.home)
        original_state = (session / "state.json").read_bytes()
        plan = self.plan()
        op = plan["operations"][0]
        self.assertEqual(op["source"], op["target"])
        self.assertEqual(set(op["file_updates"]), {"metadata.json", "state.json"})
        repair.apply_plan(plan, self.backup)
        self.assertEqual(repair.read_json(session / "state.json")["config"]["workspace_id"], wid)
        self.assertEqual(repair.read_json(session / "metadata.json")["workspaceId"], wid)
        self.assertEqual(repair.read_json(session / "state.json")["config"]["permission_mode"], "auto_approve")
        self.assertTrue(repair.read_json(session / "state.json")["config"]["unknownFutureField"]["keep"])
        self.assertEqual(self.plan()["operations"], [])
        repair.apply_plan(plan, self.backup)
        repair.rollback(self.backup)
        repair.rollback(self.backup)
        self.assertEqual(repair.directory_fingerprint(self.home), original)
        self.assertEqual((session / "state.json").read_bytes(), original_state)
        self.assertEqual(repair.read_json(session / "state.json")["config"]["workspace_id"], alias)

    def test_assistant_move_and_path_identity_updates_resume_partial_write(self):
        session, wid, _ = self.assistant_fixture(move=True, old_paths=True)
        original = repair.directory_fingerprint(self.home)
        plan = self.plan()
        target = Path(plan["operations"][0]["target"])
        atomic = repair.atomic_write

        def fail(path, data):
            if Path(path) == target / "state.json":
                raise OSError("interrupted after metadata rewrite")
            return atomic(path, data)

        with patch.object(repair, "atomic_write", side_effect=fail):
            with self.assertRaises(OSError):
                repair.apply_plan(plan, self.backup)
        self.assertFalse(session.exists())
        self.assertEqual(repair.read_json(target / "metadata.json")["workspaceId"], wid)
        repair.apply_plan(plan, self.backup)
        self.assertEqual(repair.read_json(target / "state.json")["config"]["workspace_id"], wid)
        repair.rollback(self.backup)
        self.assertEqual(repair.directory_fingerprint(self.home), original)

    def test_assistant_partial_write_can_rollback_directly(self):
        session, _, _ = self.assistant_fixture()
        before = repair.directory_fingerprint(self.home)
        plan = self.plan()
        atomic = repair.atomic_write

        def fail(path, data):
            if Path(path) == session / "state.json":
                raise OSError("identity write interruption")
            return atomic(path, data)

        with patch.object(repair, "atomic_write", side_effect=fail):
            with self.assertRaises(OSError):
                repair.apply_plan(plan, self.backup)
        repair.rollback(self.backup)
        self.assertEqual(repair.directory_fingerprint(self.home), before)

    def test_assistant_state_only_and_crafted_rewrite_refused(self):
        session, wid, _ = self.assistant_fixture()
        meta = repair.read_json(session / "metadata.json")
        meta.pop("workspaceId")
        meta.pop("projectWorkspaceId")
        self.write(session / "metadata.json", meta)
        plan = self.plan()
        self.assertEqual(set(plan["operations"][0]["file_updates"]), {"state.json"})
        self.assertEqual(plan["operations"][0]["identity_changes"][0]["file"], "state.json")
        crafted = copy.deepcopy(plan)
        state = repair.read_json(session / "state.json")
        state["config"]["permission_mode"] = "unsafe-replacement"
        crafted["operations"][0]["file_updates"]["state.json"]["after"] = repair.base64.b64encode(
            repair.encoded(state)).decode()
        with self.assertRaises(ValueError):
            repair.apply_plan(crafted, self.backup)
        self.assertFalse(self.backup.exists())
        repair.apply_plan(plan, self.backup)
        self.assertEqual(repair.read_json(session / "metadata.json"), meta)
        repair.rollback(self.backup)

    def test_identity_rollback_interruption_between_json_restores(self):
        session, _, _ = self.assistant_fixture()
        before = repair.directory_fingerprint(self.home)
        plan = self.plan()
        repair.apply_plan(plan, self.backup)
        atomic = repair.atomic_write

        def fail(path, data):
            if Path(path) == session / "state.json":
                raise OSError("interrupted restoring state")
            return atomic(path, data)

        with patch.object(repair, "atomic_write", side_effect=fail):
            with self.assertRaises(OSError):
                repair.rollback(self.backup)
        repair.rollback(self.backup)
        self.assertEqual(repair.directory_fingerprint(self.home), before)

    def test_assistant_arbitrary_id_and_different_path_not_guessed(self):
        session, _, alias = self.assistant_fixture()
        meta = repair.read_json(session / "metadata.json")
        state = repair.read_json(session / "state.json")
        meta["workspaceId"] = meta["projectWorkspaceId"] = "local_unrelated"
        state["config"]["workspace_id"] = state["config"]["project_workspace_id"] = "local_unrelated"
        self.write(session / "metadata.json", meta)
        self.write(session / "state.json", state)
        self.assertFalse(self.plan()["operations"])
        meta["workspaceId"] = meta["projectWorkspaceId"] = alias
        state["config"]["workspace_id"] = state["config"]["project_workspace_id"] = alias
        meta["workspacePath"] = str(self.workspaces["GameOps"][1])
        state["config"]["workspace_path"] = meta["workspacePath"]
        self.write(session / "metadata.json", meta)
        self.write(session / "state.json", state)
        self.assertFalse(self.plan()["operations"])

    def remote_fixture(self, legacy=False):
        wid, workspace = "remote_test", "/home/TestUser/游戏"
        self.registry["workspaces"][wid] = {"id": wid, "rootPath": workspace, "workspaceKind": "remote",
                                            "metadata": {"sshHost": "test-host", "connectionId": "ssh-user@test-host"}}
        self.save_registry()
        if legacy:
            root = self.home / "remote_ssh/test-host/home/TestUser/游戏/sessions"
        else:
            root = self.source_root
        session = self.session("remote-session", root=root)
        meta = repair.read_json(session / "metadata.json")
        state = repair.read_json(session / "state.json")
        meta.update(workspaceId=wid, projectWorkspaceId=wid, workspacePath=workspace,
                    projectWorkspacePath=workspace, workspaceHostname="test-host",
                    executionTarget={"kind": "local", "rootPath": workspace})
        state["config"].update(workspace_id=wid, project_workspace_id=wid, workspace_path=workspace,
                               project_workspace_path=workspace, workspace_kind="remote",
                               remote_ssh_host="test-host", remote_connection_id="ssh-user@test-host",
                               execution_target=meta["executionTarget"])
        self.write(session / "metadata.json", meta)
        self.write(session / "state.json", state)
        return session, wid, workspace

    def test_remote_posix_identity_directory_move_and_legacy_mirror(self):
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                session, wid, workspace = self.remote_fixture(legacy)
                before = repair.directory_fingerprint(self.home)
                plan = self.plan()
                self.assertEqual(len(plan["operations"]), 1, plan["diagnostics"])
                op = plan["operations"][0]
                expected = repair.digest(b"runtime-remote\0test-host\0" + workspace.encode())[:24]
                self.assertEqual(Path(op["target"]).parent.parent.name, expected)
                self.assertEqual(op["file_updates"], {})
                with patch.object(repair, "runtime_key", side_effect=AssertionError("No local fallback")):
                    repair.apply_plan(plan, self.backup)
                self.assertEqual(repair.directory_fingerprint(Path(op["target"])), op["sha256"])
                self.assertEqual(self.plan()["operations"], [])
                repair.rollback(self.backup)
                self.assertEqual(repair.directory_fingerprint(self.home), before)
                shutil.rmtree(self.backup)
                shutil.rmtree(session)

    def test_remote_connection_scoped_snapshots_preserved(self):
        session, wid, workspace = self.remote_fixture(legacy=True)
        identity = ["test-host", workspace, "ssh-user@test-host"]
        scope = repair.digest(repair.json.dumps(identity, ensure_ascii=False, separators=(",", ":")).encode())
        snapshots = session.parent.parent / "snapshots/workspace-identities" / scope
        self.write(snapshots / "operations/remote-session.json", {
            "session_id": session.name, "turns": {"0": {"operations": [
                {"before_snapshot_id": "baseline_remote", "after_snapshot_id": "snap-remote"}]}}})
        self.write(snapshots / "metadata/snap-remote.json", {
            "snapshot_id": "snap-remote", "file_path": workspace + "/file.txt",
            "compressed_content": [1], "content_hash": "a" * 32})
        self.write(snapshots / "baselines/baseline_remote.json", {
            "snapshot_id": "baseline_remote", "file_path": workspace + "/file.txt",
            "compressed_content": [1], "content_hash": "b" * 32})
        self.write(snapshots / "baselines/baseline_unreferenced.json", {
            "snapshot_id": "baseline_unreferenced", "file_path": workspace + "/file.txt",
            "compressed_content": [1], "content_hash": "c" * 32})
        self.write(session / "session-revert.json", {"workspaceCheckpoint": [{"snapshotId": "snap-remote"}]})
        other = session.parent.parent / "snapshots/workspace-identities/unrelated-profile"
        self.write(other / "metadata/private.json", {"keep": True})
        before = repair.directory_fingerprint(self.home)
        plan = self.plan()
        self.assertEqual(len(plan["operations"]), 1, plan["diagnostics"])
        assets = plan["operations"][0]["assets"]
        self.assertEqual(len(assets), 3)
        self.assertFalse(any("baseline_unreferenced" in a["source"] for a in assets))
        self.assertTrue(all(scope in a["target"] for a in assets))
        repair.apply_plan(plan, self.backup)
        for a in assets:
            self.assertEqual(Path(a["source"]).read_bytes(), Path(a["target"]).read_bytes())
        self.assertTrue((other / "metadata/private.json").exists())
        repair.rollback(self.backup)
        self.assertEqual(repair.directory_fingerprint(self.home), before)

    def test_remote_same_path_other_host_case_and_connection_conflicts(self):
        session, wid, _ = self.remote_fixture()
        meta = repair.read_json(session / "metadata.json")
        state = repair.read_json(session / "state.json")
        for field, wrong in (("remote_ssh_host", "another-host"),
                             ("workspace_path", "/home/testuser/游戏"),
                             ("remote_connection_id", "ssh-other@test-host")):
            broken = copy.deepcopy(state)
            broken["config"][field] = wrong
            self.write(session / "state.json", broken)
            self.assertFalse(self.plan()["operations"])
        self.write(session / "state.json", state)
        remote = self.registry["workspaces"][wid]
        self.registry["workspaces"]["remote_another"] = dict(remote, id="remote_another",
                                                             metadata={"sshHost": "another-host"})
        self.save_registry()
        for key in ("workspaceId", "projectWorkspaceId"):
            meta.pop(key)
        for key in ("workspace_id", "project_workspace_id"):
            state["config"].pop(key)
        self.write(session / "metadata.json", meta)
        self.write(session / "state.json", state)
        self.assertEqual(self.plan()["operations"][0]["workspace_id"], wid)


if __name__ == "__main__":
    unittest.main()
