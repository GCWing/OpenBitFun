"""Package the built MiniApp for OpenBitFun's local .bfminiapp importer."""

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


def main():
    app_root = Path(__file__).resolve().parent.parent
    repo_root = app_root.parents[2]
    modules = ["ui/core.js", "ui/i18n.js", "ui/main.js"]
    expected = "".join(
        f"/* {name} */\n{(app_root / 'source' / name).read_text(encoding='utf-8')}\n"
        for name in modules
    )
    if (app_root / "source/ui.js").read_text(encoding="utf-8") != expected:
        raise SystemExit("Source bundle is stale. Run node source/build.mjs first.")

    source_meta = json.loads((app_root / "meta.json").read_text(encoding="utf-8"))
    # Local packages use MarketPackageMeta. Identity and install timestamps belong
    # to the importing host; no source paths or user storage enter the package.
    fields = ["name", "description", "icon", "category", "tags", "version", "permissions", "i18n"]
    meta = {key: source_meta[key] for key in fields if key in source_meta}
    files = {"meta.json": json.dumps(meta, ensure_ascii=False, indent=2).encode("utf-8")}
    for name in ["index.html", "style.css", "ui.js", "worker.js", "esm_dependencies.json"]:
        files[f"source/{name}"] = (app_root / "source" / name).read_bytes()

    destination = repo_root / "output/miniapps/background-remover.bfminiapp"
    destination.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(destination, "w") as package:
        for name, content in files.items():
            entry = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            package.writestr(entry, content)
    print(f"Built {destination.name}")


if __name__ == "__main__":
    main()
