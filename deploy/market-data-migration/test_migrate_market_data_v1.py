#!/usr/bin/env python3

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import zipfile


SCRIPT = Path(__file__).with_name("migrate-market-data-v1.py")
SPEC = importlib.util.spec_from_file_location("migrate_market_data_v1", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
migration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(migration)


def compact_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


class MarketDataMigrationTest(unittest.TestCase):
    def test_miniapp_migrates_to_the_single_openbitfun_field_and_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            database = Path(temporary) / "market.sqlite"
            connection = sqlite3.connect(database)
            connection.executescript(
                """
                CREATE TABLE submissions (id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL);
                CREATE TABLE releases (id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL);
                """
            )
            connection.execute(
                "INSERT INTO submissions VALUES (?, ?)",
                (
                    "submission-1",
                    compact_json(
                        {"name": "示例", migration.RETIRED_VERSION_FIELDS[0]: "0.2.19"}
                    ),
                ),
            )
            connection.execute(
                "INSERT INTO releases VALUES (?, ?)",
                (
                    "release-1",
                    compact_json(
                        {"name": "示例", migration.RETIRED_VERSION_FIELDS[0]: "0.2.19"}
                    ),
                ),
            )
            connection.commit()
            connection.close()

            with contextlib.redirect_stdout(io.StringIO()):
                migration.migrate_miniapp(database, None)
                migration.migrate_miniapp(database, None)

            connection = sqlite3.connect(database)
            rows = connection.execute(
                "SELECT metadata_json FROM submissions UNION ALL SELECT metadata_json FROM releases"
            ).fetchall()
            connection.close()
            self.assertEqual(len(rows), 2)
            for (raw,) in rows:
                value = json.loads(raw)
                self.assertEqual(value["minOpenBitFunVersion"], "1.0.0")
                for retired_field in migration.RETIRED_VERSION_FIELDS:
                    self.assertNotIn(retired_field, value)

    def test_migration_refuses_the_live_database(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            database = Path(temporary) / "market.sqlite"
            database.touch()
            with self.assertRaisesRegex(RuntimeError, "live database"):
                migration.ensure_offline_copy(database, database)

    def test_skin_migration_refuses_the_live_artifact_tree(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            artifacts = Path(temporary) / "artifacts"
            artifacts.mkdir()
            with self.assertRaisesRegex(RuntimeError, "live artifact tree"):
                migration.ensure_offline_artifacts(artifacts, artifacts)

    def test_skin_rewrites_packages_hashes_and_review_bundles(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / "market.sqlite"
            artifacts = root / "artifacts"
            artifacts.mkdir()

            archive_bytes = io.BytesIO()
            retired_manifest = {
                "schema": migration.RETIRED_APPEARANCE_SCHEMA,
                "schemaVersion": 1,
                "id": "community.example",
                "name": "示例皮肤",
            }
            with zipfile.ZipFile(archive_bytes, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("appearance.json", compact_json(retired_manifest))
                archive.writestr("assets/token.txt", "asset")
            retired_bytes = archive_bytes.getvalue()
            retired_sha = hashlib.sha256(retired_bytes).hexdigest()
            retired_path = migration.skin_package_path(
                artifacts, retired_sha, migration.RETIRED_APPEARANCE_EXTENSION
            )
            retired_path.parent.mkdir(parents=True)
            retired_path.write_bytes(retired_bytes)

            draft = {
                "slug": "example-skin",
                "releaseNumber": 1,
                migration.RETIRED_VERSION_FIELDS[0]: "0.2.18",
            }
            package_meta = {
                "packageId": "community.example",
                "name": "示例皮肤",
                "mode": "dark",
                "packageVersion": "1.0.0",
            }
            preview_sha = "a" * 64
            connection = sqlite3.connect(database)
            connection.executescript(
                """
                CREATE TABLE submissions (
                    id TEXT PRIMARY KEY,
                    draft_json TEXT NOT NULL,
                    package_sha256 TEXT,
                    package_size INTEGER,
                    manifest_json TEXT
                );
                CREATE TABLE releases (
                    id TEXT PRIMARY KEY,
                    draft_json TEXT NOT NULL,
                    package_meta_json TEXT NOT NULL,
                    manifest_json TEXT NOT NULL,
                    package_sha256 TEXT NOT NULL,
                    package_size INTEGER NOT NULL,
                    preview_sha256 TEXT NOT NULL,
                    review_bundle_hash TEXT NOT NULL
                );
                """
            )
            connection.execute(
                "INSERT INTO submissions VALUES (?, ?, ?, ?, ?)",
                (
                    "submission-1",
                    compact_json(draft),
                    retired_sha,
                    len(retired_bytes),
                    compact_json(retired_manifest),
                ),
            )
            connection.execute(
                "INSERT INTO releases VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "release-1",
                    compact_json(draft),
                    compact_json(package_meta),
                    compact_json(retired_manifest),
                    retired_sha,
                    len(retired_bytes),
                    preview_sha,
                    "retired-review-hash",
                ),
            )
            connection.commit()
            connection.close()

            with contextlib.redirect_stdout(io.StringIO()):
                migration.migrate_skin(database, artifacts, None, None)
                migration.migrate_skin(database, artifacts, None, None)

            connection = sqlite3.connect(database)
            submission = connection.execute(
                "SELECT draft_json, package_sha256, package_size, manifest_json FROM submissions"
            ).fetchone()
            release = connection.execute(
                """
                SELECT draft_json, package_meta_json, manifest_json, package_sha256,
                       package_size, preview_sha256, review_bundle_hash
                FROM releases
                """
            ).fetchone()
            self.assertEqual(
                connection.execute("PRAGMA integrity_check").fetchone()[0], "ok"
            )
            connection.close()
            assert submission is not None and release is not None

            draft_json, new_sha, new_size, manifest_json = submission
            migrated_manifest = json.loads(manifest_json)
            self.assertEqual(json.loads(draft_json)["minOpenBitFunVersion"], "1.0.0")
            self.assertEqual(migrated_manifest["schema"], "openbitfun.appearance")
            self.assertNotEqual(new_sha, retired_sha)

            migrated_path = migration.skin_package_path(
                artifacts, new_sha, migration.OPENBITFUN_APPEARANCE_EXTENSION
            )
            self.assertTrue(migrated_path.is_file())
            self.assertEqual(
                hashlib.sha256(migrated_path.read_bytes()).hexdigest(), new_sha
            )
            self.assertEqual(migrated_path.stat().st_size, new_size)
            with zipfile.ZipFile(migrated_path) as archive:
                archived_manifest = json.loads(archive.read("appearance.json"))
            self.assertEqual(archived_manifest, migrated_manifest)

            (
                release_draft,
                release_package_meta,
                release_manifest,
                release_sha,
                release_size,
                release_preview_sha,
                release_review_hash,
            ) = release
            self.assertEqual(release_sha, new_sha)
            self.assertEqual(release_size, new_size)
            self.assertEqual(
                release_review_hash,
                migration.review_bundle_hash(
                    release_sha,
                    release_draft,
                    release_package_meta,
                    release_manifest,
                    release_preview_sha,
                ),
            )
            self.assertFalse(retired_path.exists())
            self.assertTrue(
                (
                    artifacts
                    / migration.RETIRED_ARCHIVE_ROOT
                    / retired_path.relative_to(artifacts)
                ).is_file()
            )
            self.assertEqual(
                list(
                    (artifacts / "packages").glob(
                        f"*/*.{migration.RETIRED_APPEARANCE_EXTENSION}"
                    )
                ),
                [],
            )


if __name__ == "__main__":
    unittest.main()
