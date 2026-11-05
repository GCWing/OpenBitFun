from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, Mapping


SKILL_ROOT = Path(__file__).resolve().parents[3]
REFERENCES = Path(__file__).resolve().parents[1] / "references"
DEFAULT_PALETTE = REFERENCES / "default-palette.json"
DEFAULT_SURFACE_PLAN = REFERENCES / "surface-plan.json"
sys.path.insert(0, str(SKILL_ROOT / "scripts"))

import openbitfun_appearance as appearance  # noqa: E402
from build_support import atomic_write_json, read_json  # noqa: E402


PALETTE_SCHEMA = "openbitfun.appearance.cinematic-palette"
SURFACE_PLAN_SCHEMA = "openbitfun.appearance.style-surface-plan"
STYLE_ID = "cinematic-animated-wallpaper"
PALETTE_KEYS = {
    "background",
    "surface",
    "surfaceElevated",
    "text",
    "textSecondary",
    "textMuted",
    "textDisabled",
    "accent",
    "accentStrong",
    "accentContrast",
    "info",
    "success",
    "warning",
    "danger",
}
HEX_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")


class CinematicContractError(ValueError):
    pass


def load_palette(path: Path = DEFAULT_PALETTE) -> dict[str, Any]:
    palette = read_json(path)
    if palette.get("schema") != PALETTE_SCHEMA or palette.get("schemaVersion") != 1:
        raise CinematicContractError("Unsupported cinematic palette schema")
    palette_id = palette.get("id")
    if not isinstance(palette_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", palette_id):
        raise CinematicContractError("Palette id must use lowercase letters, digits, and hyphens")
    colors = palette.get("colors")
    if not isinstance(colors, dict):
        raise CinematicContractError("Palette colors must be an object")
    missing = sorted(PALETTE_KEYS - set(colors))
    extra = sorted(set(colors) - PALETTE_KEYS)
    if missing or extra:
        details = []
        if missing:
            details.append(f"missing: {', '.join(missing)}")
        if extra:
            details.append(f"unknown: {', '.join(extra)}")
        raise CinematicContractError("Invalid palette keys (" + "; ".join(details) + ")")
    invalid = sorted(key for key, value in colors.items() if not isinstance(value, str) or not HEX_PATTERN.fullmatch(value))
    if invalid:
        raise CinematicContractError(f"Palette colors must be six-digit hex values: {', '.join(invalid)}")
    return palette


def load_surface_plan(path: Path = DEFAULT_SURFACE_PLAN) -> dict[str, Any]:
    plan = read_json(path)
    if plan.get("schema") != SURFACE_PLAN_SCHEMA or plan.get("schemaVersion") != 1:
        raise CinematicContractError("Unsupported cinematic surface plan schema")
    if plan.get("scope") != "example-style-selection" or plan.get("styleId") != STYLE_ID:
        raise CinematicContractError("Cinematic surface plan must declare its example style scope")
    if not isinstance(plan.get("validatedAgainstRegistryRevision"), str):
        raise CinematicContractError("Cinematic surface plan must record its validated registry revision")
    if not isinstance(plan.get("components"), dict) or not isinstance(plan.get("scenes"), dict):
        raise CinematicContractError("Surface plan must define component and scene objects")
    return plan


def hex_rgb(value: str) -> tuple[int, int, int]:
    return int(value[1:3], 16), int(value[3:5], 16), int(value[5:7], 16)


def color_value(value: str, alpha: float = 1) -> dict[str, Any]:
    red, green, blue = hex_rgb(value)
    return {"kind": "rgb", "r": red, "g": green, "b": blue, "a": alpha}


def rgba(value: str, alpha: float, spaced: bool = True) -> str:
    red, green, blue = hex_rgb(value)
    separator = ", " if spaced else ","
    return f"rgba({red}{separator}{green}{separator}{blue}{separator}{alpha:.2f})"


def resolve_palette_values(value: Any, colors: Mapping[str, str]) -> Any:
    if isinstance(value, dict):
        if value.get("kind") == "palette":
            role = value.get("role")
            alpha = value.get("alpha", 1)
            if role not in colors:
                raise CinematicContractError(f"Unknown palette role in surface plan: {role}")
            if not isinstance(alpha, (int, float)) or isinstance(alpha, bool) or not 0 <= alpha <= 1:
                raise CinematicContractError(f"Invalid palette alpha for role {role}")
            return color_value(colors[role], float(alpha))
        return {key: resolve_palette_values(child, colors) for key, child in value.items()}
    if isinstance(value, list):
        return [resolve_palette_values(child, colors) for child in value]
    return value


def shadow(y: int, blur: int, spread: int, alpha: float) -> dict[str, Any]:
    return {
        "kind": "shadow",
        "x": {"kind": "zero"},
        "y": {"kind": "px", "value": y},
        "blur": {"kind": "px", "value": blur},
        "spread": {"kind": "px", "value": spread},
        "color": {"kind": "rgb", "r": 0, "g": 0, "b": 0, "a": alpha},
    }


def image_material(asset_id: str, background: str, alpha: float, role: str) -> dict[str, Any]:
    return {
        "visualRole": role,
        "style": {
            "backgroundColor": color_value(background, alpha),
            "backgroundImage": {"kind": "asset", "assetId": asset_id},
            "backgroundSize": "cover",
            "backgroundPosition": "center",
            "backgroundRepeat": "no-repeat",
            "borderColor": {"kind": "transparent"},
        },
    }


def build_materials(colors: Mapping[str, str]) -> dict[str, Any]:
    accent = colors["accent"]
    background = colors["background"]
    return {
        "transparent": {
            "visualRole": "continuous-surface",
            "style": {
                "backgroundColor": {"kind": "transparent"},
                "borderColor": {"kind": "transparent"},
            },
        },
        "workspace-art": {
            "visualRole": "workspace",
            "style": {"backgroundColor": {"kind": "transparent"}},
        },
        "sidebar-art": image_material("sidebar", background, 0.72, "panel"),
        "floating-art": image_material("floating", background, 0.34, "workspace"),
        "panel": {
            "visualRole": "panel",
            "style": {
                "backgroundColor": color_value(colors["surface"], 0.48),
                "backdropBlur": {"kind": "px", "value": 8},
                "borderColor": color_value(accent, 0.10),
            },
        },
        "card": {
            "visualRole": "card",
            "style": {
                "backgroundColor": color_value(colors["surfaceElevated"], 0.68),
                "backdropBlur": {"kind": "px", "value": 5},
                "borderColor": color_value(accent, 0.10),
                "boxShadow": [shadow(10, 28, -12, 0.48)],
            },
        },
        "control": {
            "visualRole": "control",
            "style": {
                "backgroundColor": color_value(colors["surfaceElevated"], 0.82),
                "backdropBlur": {"kind": "px", "value": 6},
                "borderColor": color_value(accent, 0.13),
            },
        },
        "detail-card": image_material("card-detail", background, 0.78, "card"),
        "portrait-card": image_material("card-portrait", background, 0.80, "card"),
        "dialog-art": {
            **image_material("dialog", background, 0.90, "dialog"),
            "style": {
                **image_material("dialog", background, 0.90, "dialog")["style"],
                "borderColor": color_value(accent, 0.12),
                "boxShadow": [shadow(18, 52, -16, 0.72)],
            },
        },
        "popup": {
            "visualRole": "popup",
            "style": {
                "backgroundColor": color_value(colors["surface"], 0.96),
                "borderColor": color_value(accent, 0.12),
            },
        },
        "code": {
            "visualRole": "content",
            "style": {
                "backgroundColor": {"kind": "hex", "value": background},
                "borderColor": {"kind": "transparent"},
            },
        },
    }


def build_renderers(colors: Mapping[str, str], appearance_id: str) -> dict[str, Any]:
    background = colors["background"]
    surface = colors["surface"]
    elevated = colors["surfaceElevated"]
    accent = colors["accent"]
    theme_tokens = {
        "--openbitfun-color-surface-canvas": rgba(background, 0.78),
        "--openbitfun-color-surface-panel": rgba(surface, 0.72),
        "--openbitfun-color-surface-tertiary": rgba(elevated, 0.76),
        "--openbitfun-color-surface-raised": rgba(elevated, 0.74),
        "--openbitfun-color-surface-scene": rgba(background, 0.08),
        "--openbitfun-color-surface-workbench": rgba(background, 0.08),
        "--openbitfun-color-surface-chrome": rgba(background, 0.18),
        "--openbitfun-color-surface-subtle": rgba(surface, 0.50),
        "--openbitfun-color-action-quiet-hover": rgba(surface, 0.58),
        "--openbitfun-color-action-neutral-surface": rgba(elevated, 0.66),
        "--openbitfun-color-action-neutral-surface-hover": rgba(elevated, 0.70),
        "--openbitfun-color-action-neutral-surface-pressed": rgba(elevated, 0.78),
        "--openbitfun-color-content-primary": colors["text"],
        "--openbitfun-color-content-secondary": colors["textSecondary"],
        "--openbitfun-color-content-muted": colors["textMuted"],
        "--openbitfun-color-content-disabled": colors["textDisabled"],
        "--openbitfun-color-accent-default": accent,
        "--openbitfun-color-accent-hover": colors["accentStrong"],
        "--openbitfun-color-border-subtle": rgba(accent, 0.08),
        "--openbitfun-color-border-default": rgba(accent, 0.12),
        "--openbitfun-color-border-strong": rgba(accent, 0.28),
        "--openbitfun-color-status-danger-content": colors["danger"],
        "--openbitfun-color-status-danger-surface": rgba(colors["danger"], 0.28),
        "--openbitfun-color-status-danger-border": rgba(colors["danger"], 0.38),
        "--openbitfun-color-status-warning-content": colors["warning"],
        "--openbitfun-color-status-success-content": colors["success"],
        "--openbitfun-color-status-info-content": colors["info"],
        "--openbitfun-color-scrollbar-thumb": rgba(accent, 0.22),
        "--openbitfun-color-scrollbar-thumb-hover": rgba(accent, 0.38),
    }
    widget_tokens = {
        "--openbitfun-color-surface-canvas": background,
        "--openbitfun-color-surface-panel": surface,
        "--openbitfun-color-surface-tertiary": elevated,
        "--openbitfun-color-surface-raised": elevated,
        "--openbitfun-color-surface-scene": background,
        "--openbitfun-color-content-primary": colors["text"],
        "--openbitfun-color-content-secondary": colors["textSecondary"],
        "--openbitfun-color-content-muted": colors["textMuted"],
        "--openbitfun-color-content-disabled": colors["textDisabled"],
        "--openbitfun-color-accent-default": accent,
        "--openbitfun-color-accent-hover": colors["accentStrong"],
        "--openbitfun-color-border-subtle": rgba(accent, 0.08, spaced=False),
        "--openbitfun-color-border-default": rgba(accent, 0.12, spaced=False),
        "--openbitfun-color-border-strong": rgba(accent, 0.28, spaced=False),
        "--openbitfun-color-surface-subtle": rgba(surface, 0.50, spaced=False),
        "--openbitfun-color-action-quiet-hover": rgba(surface, 0.58, spaced=False),
        "--openbitfun-color-action-neutral-surface": rgba(elevated, 0.66, spaced=False),
        "--openbitfun-color-action-neutral-surface-hover": rgba(elevated, 0.70, spaced=False),
        "--openbitfun-color-action-neutral-surface-pressed": rgba(elevated, 0.78, spaced=False),
    }
    return {
        "theme-tokens": {
            "version": 1,
            "settings": {
                "tokens": theme_tokens,
            },
        },
        "monaco": {
            "version": 1,
            "settings": {
                "id": appearance_id,
                "base": "vs-dark",
                "inherit": True,
                "rules": [
                    {"token": "comment", "foreground": colors["textDisabled"][1:], "fontStyle": "italic"},
                    {"token": "keyword", "foreground": accent[1:]},
                    {"token": "string", "foreground": colors["success"][1:]},
                    {"token": "number", "foreground": colors["warning"][1:]},
                ],
                "colors": {
                    "editor.background": background.upper(),
                    "editor.foreground": colors["text"].upper(),
                    "editorLineNumber.foreground": colors["textDisabled"].upper(),
                    "editorLineNumber.activeForeground": colors["textSecondary"].upper(),
                    "editor.selectionBackground": rgba(accent, 0.38),
                    "editor.inactiveSelectionBackground": rgba(accent, 0.24),
                    "editorCursor.foreground": accent.upper(),
                    "editorWidget.background": surface.upper(),
                    "editorHoverWidget.background": surface.upper(),
                },
            },
        },
        "xterm": {
            "version": 1,
            "settings": {
                "surfaces": {
                    name: {
                        "background": background,
                        "foreground": colors["text"],
                        "cursor": accent,
                        "selectionBackground": rgba(accent, 0.34),
                    }
                    for name in ("terminal", "output")
                },
            },
        },
        "mermaid": {
            "version": 1,
            "settings": {
                "mode": "dark",
                "palette": {
                    "nodeFill": elevated,
                    "nodeFillHover": surface,
                    "nodeText": colors["text"],
                    "nodeStroke": colors["accentStrong"],
                    "nodeStrokeHover": accent,
                    "clusterFill": background,
                    "clusterText": colors["textSecondary"],
                    "clusterStroke": colors["textDisabled"],
                    "edgeStroke": colors["accentStrong"],
                    "edgeLabelBackground": surface,
                    "edgeLabelText": colors["text"],
                    "noteFill": surface,
                    "noteText": colors["textSecondary"],
                    "noteStroke": colors["warning"],
                    "activationFill": elevated,
                    "activationStroke": accent,
                    "success": colors["success"],
                    "warning": colors["warning"],
                    "error": colors["danger"],
                    "errorBackground": surface,
                    "info": colors["info"],
                    "highlight": colors["accentStrong"],
                    "pieColors": [
                        accent,
                        colors["danger"],
                        colors["warning"],
                        colors["success"],
                        colors["info"],
                        colors["accentStrong"],
                        colors["textMuted"],
                        colors["textSecondary"],
                    ],
                },
            },
        },
        "generative-widget": {
            "version": 1,
            "settings": {
                "id": appearance_id,
                "mode": "dark",
                "vars": widget_tokens,
            },
        },
    }


def build_assets() -> dict[str, Any]:
    definitions = {
        "background": ("video", "video/webm", "assets/background.webm"),
        "floating": ("image", "image/webp", "assets/floating.webp"),
        "sidebar": ("image", "image/webp", "assets/sidebar.webp"),
        "card-detail": ("image", "image/webp", "assets/card-detail.webp"),
        "card-portrait": ("image", "image/webp", "assets/card-portrait.webp"),
        "dialog": ("image", "image/webp", "assets/dialog.webp"),
        "preview": ("image", "image/webp", "assets/preview.webp"),
    }
    return {
        asset_id: {
            "kind": kind,
            "mimeType": mime_type,
            "source": {"kind": "package", "path": path},
        }
        for asset_id, (kind, mime_type, path) in definitions.items()
    }


def build_manifest(
    *,
    appearance_id: str,
    name: str,
    version: str,
    mode: str,
    palette: Mapping[str, Any],
    surface_plan: Mapping[str, Any],
    author: str | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    colors = palette["colors"]
    manifest: dict[str, Any] = {
        "schema": "openbitfun.appearance",
        "schemaVersion": 2,
        "id": appearance_id,
        "name": name,
        "version": version,
        "mode": mode,
        "preview": {"kind": "asset", "assetId": "preview"},
        "requiredCapabilities": ["assets.v1", "background-media.v1"],
        "globals": {},
        "materials": build_materials(colors),
        "components": resolve_palette_values(surface_plan["components"], colors),
        "scenes": resolve_palette_values(surface_plan["scenes"], colors),
        "renderers": build_renderers(colors, appearance_id),
        "assets": build_assets(),
        "integrity": {"sha256": {}},
        "backgroundMedia": {
            "kind": "video",
            "assetId": "background",
            "posterAssetId": "preview",
            "fit": "cover",
            "position": "center",
        },
    }
    if author:
        manifest["author"] = author
    if description:
        manifest["description"] = description
    return manifest


def validate_manifest(manifest: Mapping[str, Any]) -> list[dict[str, str]]:
    validator = appearance.ManifestValidator(appearance.load_registry())
    validator.validate(dict(manifest))
    if validator.errors:
        formatted = appearance.format_issues(validator.errors)
        raise CinematicContractError(f"Generated cinematic manifest is invalid:\n{formatted}")
    return validator.warnings


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def scaffold_comparable_manifest(value: Mapping[str, Any]) -> dict[str, Any]:
    comparable = json.loads(json.dumps(value))
    comparable["integrity"] = {"sha256": {}}
    return comparable
