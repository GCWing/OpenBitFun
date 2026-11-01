#!/usr/bin/env python3
"""One-time BitFun 0.2.x -> OpenBitFun 1.x market data migration.

Run this only against an offline copy of the production database and artifact
tree. The OpenBitFun services intentionally keep no legacy field aliases, so
the persisted JSON and Skin archives must be converted before first startup.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sqlite3
import tempfile
from typing import Any
import zipfile


CURRENT_VERSION_FIELD = "minOpenBitFunVersion"
RETIRED_VERSION_FIELDS = ("minBitfunVersion", "minOpenbitfunVersion")
OPENBITFUN_MINIMUM_VERSION = "1.0.0"
RETIRED_APPEARANCE_SCHEMA = "bitfun.appearance"
OPENBITFUN_APPEARANCE_SCHEMA = "openbitfun.appearance"
RETIRED_APPEARANCE_EXTENSION = "bitfun-appearance"
OPENBITFUN_APPEARANCE_EXTENSION = "openbitfun-appearance"
RETIRED_ARCHIVE_ROOT = "migrated-bitfun-v1"


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def load_object(raw: str, context: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{context} is not valid JSON: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"{context} must be a JSON object")
    return value


def migrate_version_field(value: dict[str, Any], context: str) -> bool:
    present_retired = [field for field in RETIRED_VERSION_FIELDS if field in value]
    if CURRENT_VERSION_FIELD in value:
        if present_retired:
            raise RuntimeError(
                f"{context} contains both {CURRENT_VERSION_FIELD} and {present_retired}"
            )
        return False
    if len(present_retired) != 1:
        raise RuntimeError(
            f"{context} must contain exactly one retired minimum-version field"
        )
    value.pop(present_retired[0])
    value[CURRENT_VERSION_FIELD] = OPENBITFUN_MINIMUM_VERSION
    return True


def migrate_json_column(
    connection: sqlite3.Connection,
    table: str,
    id_column: str,
    json_column: str,
) -> int:
    changed = 0
    rows = connection.execute(
        f"SELECT {id_column}, {json_column} FROM {table} ORDER BY {id_column}"
    ).fetchall()
    for row_id, raw in rows:
        value = load_object(raw, f"{table}.{json_column}[{row_id}]")
        if not migrate_version_field(value, f"{table}.{json_column}[{row_id}]"):
            continue
        connection.execute(
            f"UPDATE {table} SET {json_column} = ? WHERE {id_column} = ?",
            (compact_json(value), row_id),
        )
        changed += 1
    return changed


def ensure_offline_copy(database: Path, live_database: Path | None) -> None:
    database = database.resolve()
    if live_database is not None and database == live_database.resolve():
        raise RuntimeError("refusing to migrate the live database in place")
    if not database.is_file():
        raise RuntimeError(f"database does not exist: {database}")


def ensure_offline_artifacts(artifacts: Path, live_artifacts: Path | None) -> None:
    artifacts = artifacts.resolve()
    if live_artifacts is not None and artifacts == live_artifacts.resolve():
        raise RuntimeError("refusing to migrate the live artifact tree in place")
    if not artifacts.is_dir():
        raise RuntimeError(f"artifact directory does not exist: {artifacts}")


def connect_database(database: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(database)
    connection.execute("PRAGMA foreign_keys = ON")
    if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        connection.close()
        raise RuntimeError("database integrity_check failed before migration")
    return connection


def migrate_miniapp(database: Path, live_database: Path | None) -> None:
    ensure_offline_copy(database, live_database)
    connection = connect_database(database)
    try:
        connection.execute("BEGIN IMMEDIATE")
        submissions = migrate_json_column(
            connection, "submissions", "id", "metadata_json"
        )
        releases = migrate_json_column(connection, "releases", "id", "metadata_json")
        connection.commit()
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("database integrity_check failed after migration")
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
    print(f"MiniApp market migrated: submissions={submissions}, releases={releases}")


def validate_archive_name(name: str) -> None:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name:
        raise RuntimeError(f"unsafe Skin archive entry: {name}")


def write_migrated_skin_archive(source: Path, temporary_root: Path) -> tuple[Path, str, int, str]:
    source_stat = source.stat()
    temporary_root.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix="skin-v1-", suffix=".openbitfun-appearance", dir=temporary_root
    )
    os.close(file_descriptor)
    temporary = Path(temporary_name)
    manifest: dict[str, Any] | None = None
    try:
        with zipfile.ZipFile(source, "r") as incoming, zipfile.ZipFile(
            temporary, "w", allowZip64=True
        ) as outgoing:
            seen: set[str] = set()
            for entry in incoming.infolist():
                validate_archive_name(entry.filename)
                if entry.filename in seen:
                    raise RuntimeError(f"duplicate Skin archive entry: {entry.filename}")
                seen.add(entry.filename)
                content = incoming.read(entry)
                if entry.filename == "appearance.json":
                    manifest = load_object(content.decode("utf-8"), "appearance.json")
                    schema = manifest.get("schema")
                    if schema != RETIRED_APPEARANCE_SCHEMA:
                        raise RuntimeError(
                            f"appearance.json schema must be {RETIRED_APPEARANCE_SCHEMA}, found {schema!r}"
                        )
                    if manifest.get("schemaVersion") != 1:
                        raise RuntimeError("appearance.json schemaVersion must be 1")
                    manifest["schema"] = OPENBITFUN_APPEARANCE_SCHEMA
                    content = compact_json(manifest).encode("utf-8")
                outgoing.writestr(entry, content)
        if manifest is None:
            raise RuntimeError("Skin archive is missing appearance.json")
        digest = hashlib.sha256()
        size = 0
        with temporary.open("rb") as migrated:
            while chunk := migrated.read(1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
        os.chmod(temporary, source_stat.st_mode & 0o777)
        if hasattr(os, "chown") and os.geteuid() == 0:
            os.chown(temporary, source_stat.st_uid, source_stat.st_gid)
        return temporary, digest.hexdigest(), size, compact_json(manifest)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def skin_package_path(artifacts: Path, digest: str, extension: str) -> Path:
    return artifacts / "packages" / digest[:2] / f"{digest}.{extension}"


def ensure_directory_like(path: Path, reference: Path) -> None:
    if path.exists():
        return
    reference_stat = reference.stat()
    path.mkdir(parents=True)
    os.chmod(path, reference_stat.st_mode & 0o777)
    if hasattr(os, "chown") and os.geteuid() == 0:
        os.chown(path, reference_stat.st_uid, reference_stat.st_gid)


def review_bundle_hash(
    package_sha256: str,
    draft_json: str,
    package_meta_json: str,
    manifest_json: str,
    preview_sha256: str,
) -> str:
    metadata = compact_json(
        {
            "draft": json.loads(draft_json),
            "package": json.loads(package_meta_json),
            "manifest": json.loads(manifest_json),
        }
    )
    digest = hashlib.sha256()
    digest.update(package_sha256.encode())
    digest.update(b"\0")
    digest.update(metadata.encode())
    digest.update(b"\0")
    digest.update(preview_sha256.encode())
    return digest.hexdigest()


def migrate_skin_packages(
    connection: sqlite3.Connection,
    artifacts: Path,
) -> int:
    rows = connection.execute(
        """
        SELECT DISTINCT package_sha256
        FROM (
            SELECT package_sha256 FROM submissions WHERE package_sha256 IS NOT NULL
            UNION ALL
            SELECT package_sha256 FROM releases
        )
        ORDER BY package_sha256
        """
    ).fetchall()
    temporary_root = artifacts / ".migration-openbitfun-v1"
    migrated_packages = 0
    for (old_sha256,) in rows:
        old_path = skin_package_path(
            artifacts, old_sha256, RETIRED_APPEARANCE_EXTENSION
        )
        new_existing = skin_package_path(
            artifacts, old_sha256, OPENBITFUN_APPEARANCE_EXTENSION
        )
        if not old_path.is_file():
            if new_existing.is_file():
                continue
            raise RuntimeError(f"referenced Skin package is missing: {old_sha256}")
        temporary, new_sha256, new_size, manifest_json = write_migrated_skin_archive(
            old_path, temporary_root
        )
        new_path = skin_package_path(
            artifacts, new_sha256, OPENBITFUN_APPEARANCE_EXTENSION
        )
        ensure_directory_like(new_path.parent, old_path.parent)
        if new_path.exists():
            if hashlib.sha256(new_path.read_bytes()).hexdigest() != new_sha256:
                temporary.unlink(missing_ok=True)
                raise RuntimeError(f"Skin migration target hash mismatch: {new_path}")
            temporary.unlink(missing_ok=True)
        else:
            os.replace(temporary, new_path)

        connection.execute(
            """
            UPDATE submissions
            SET package_sha256 = ?, package_size = ?, manifest_json = ?
            WHERE package_sha256 = ?
            """,
            (new_sha256, new_size, manifest_json, old_sha256),
        )
        release_rows = connection.execute(
            """
            SELECT id, draft_json, package_meta_json, preview_sha256
            FROM releases WHERE package_sha256 = ? ORDER BY id
            """,
            (old_sha256,),
        ).fetchall()
        for release_id, draft_json, package_meta_json, preview_sha256 in release_rows:
            bundle_hash = review_bundle_hash(
                new_sha256,
                draft_json,
                package_meta_json,
                manifest_json,
                preview_sha256,
            )
            connection.execute(
                """
                UPDATE releases
                SET package_sha256 = ?, package_size = ?, manifest_json = ?, review_bundle_hash = ?
                WHERE id = ?
                """,
                (new_sha256, new_size, manifest_json, bundle_hash, release_id),
            )
        migrated_packages += 1
    return migrated_packages


def archive_retired_skin_packages(artifacts: Path) -> int:
    archive_root = artifacts / RETIRED_ARCHIVE_ROOT
    retired_paths = sorted(
        (artifacts / "packages").glob(f"*/*.{RETIRED_APPEARANCE_EXTENSION}")
    )
    archived = 0
    for source in retired_paths:
        relative = source.relative_to(artifacts)
        target = archive_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            if hashlib.sha256(target.read_bytes()).digest() != hashlib.sha256(
                source.read_bytes()
            ).digest():
                raise RuntimeError(f"retired Skin archive collision: {target}")
            source.unlink()
        else:
            os.replace(source, target)
        archived += 1
    return archived


def migrate_skin(
    database: Path,
    artifacts: Path,
    live_database: Path | None,
    live_artifacts: Path | None,
) -> None:
    ensure_offline_copy(database, live_database)
    ensure_offline_artifacts(artifacts, live_artifacts)
    connection = connect_database(database)
    try:
        connection.execute("BEGIN IMMEDIATE")
        submissions = migrate_json_column(connection, "submissions", "id", "draft_json")
        releases = migrate_json_column(connection, "releases", "id", "draft_json")
        packages = migrate_skin_packages(connection, artifacts)
        connection.commit()
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("database integrity_check failed after migration")
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
    archived = archive_retired_skin_packages(artifacts)
    print(
        "Skin market migrated: "
        f"submissions={submissions}, releases={releases}, "
        f"packages={packages}, retired_archives={archived}"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="market", required=True)
    for name in ("miniapp", "skin"):
        subparser = subparsers.add_parser(name)
        subparser.add_argument("--database", type=Path, required=True)
        subparser.add_argument(
            "--live-database",
            type=Path,
            help="Optional live path that the tool must refuse to modify",
        )
        if name == "skin":
            subparser.add_argument("--artifacts", type=Path, required=True)
            subparser.add_argument(
                "--live-artifacts",
                type=Path,
                help="Optional live artifact path that the tool must refuse to modify",
            )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.market == "miniapp":
        migrate_miniapp(args.database, args.live_database)
    else:
        migrate_skin(
            args.database,
            args.artifacts,
            args.live_database,
            args.live_artifacts,
        )


if __name__ == "__main__":
    main()
