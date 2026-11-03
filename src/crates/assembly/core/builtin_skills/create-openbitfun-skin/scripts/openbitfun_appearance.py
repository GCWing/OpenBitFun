#!/usr/bin/env python3
"""Build, validate, inspect, and query OpenBitFun Appearance packages."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable, Mapping, Sequence


SCHEMA = "openbitfun.appearance"
SCHEMA_VERSION = 2
REGISTRY_PATH = Path(__file__).resolve().parent.parent / "references" / "appearance-registry.json"
MANIFEST_NAME = "appearance.json"
MAX_ARCHIVE_BYTES = 96 * 1024 * 1024
MAX_EXPANDED_BYTES = 128 * 1024 * 1024
MAX_MANIFEST_BYTES = 256 * 1024
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_VIDEO_BYTES = 64 * 1024 * 1024
MAX_PREVIEW_BYTES = 4 * 1024 * 1024
MAX_ENTRIES = 64
MAX_DIMENSION = 16_384
MAX_PIXELS = 50_000_000

ID_PATTERN = re.compile(r"^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$")
VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
REFERENCE_PATTERN = re.compile(
    r"^globals\.(colors|lengths|numbers|durations|easings|shadows)\.[a-z][a-zA-Z0-9.-]*$"
)
ASSET_PATH_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_./-]*$")
FORBIDDEN_RENDERER_TEXT = re.compile(r"(?:https?://|javascript:|data:|url\s*\(|</?[a-z]|[{};])", re.I)
COLOR_STRING_PATTERN = re.compile(
    r"^(?:transparent|#[0-9a-f]{3,8}|rgba?\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)|hsla?\([^)]+\))$",
    re.I,
)
MONACO_COLOR_PATTERN = re.compile(
    r"^(?:#[0-9a-f]{3,8}|rgba?\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$",
    re.I,
)
MONACO_TOKEN_COLOR_PATTERN = re.compile(
    r"^(?:[0-9a-f]{6}|[0-9a-f]{8}|#[0-9a-f]{3,8}|rgba?\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$",
    re.I,
)
FONT_STYLE_PATTERN = re.compile(r"^(?:|italic|bold|underline|strikethrough)(?: (?:italic|bold|underline|strikethrough))*$")
CSS_TOKEN_FORBIDDEN = re.compile(r"(?:url\s*\(|var\s*\(|expression\s*\(|[;{}<>])", re.I)
WIDGET_SAFE_VALUE = re.compile(r"^(?!.*(?:https?://|javascript:|data:|url\s*\(|[{};@\\]))[\w\s#.,%()'\"+\-/*]+$", re.I)

STYLE_PROPERTIES = {
    "backgroundColor", "backgroundImage", "color", "caretColor", "accentColor",
    "textDecorationColor", "borderColor", "borderTopColor", "backgroundSize",
    "backgroundPosition", "backgroundRepeat", "backgroundImages", "backgroundSizes",
    "backgroundPositions", "backgroundRepeats", "backgroundBlendModes",
    "borderRightColor", "borderBottomColor", "borderLeftColor", "borderWidth",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "borderStyle", "borderRadius", "borderTopLeftRadius", "borderTopRightRadius",
    "borderBottomRightRadius", "borderBottomLeftRadius", "boxSizing", "outlineColor",
    "outlineWidth", "outlineOffset", "outlineStyle", "boxShadow", "opacity",
    "textAlign", "verticalAlign", "textIndent",
    "textDecoration", "textTransform", "textOverflow", "whiteSpace", "wordBreak",
    "overflowWrap", "display", "flexDirection", "flexWrap", "flexGrow", "flexShrink",
    "flexBasis", "alignItems", "alignContent", "alignSelf", "justifyContent",
    "justifySelf", "justifyItems", "placeItems", "placeContent", "order",
    "gridTemplateColumns", "gridTemplateRows", "gridAutoFlow", "gridColumnSpan",
    "gridRowSpan", "gap", "rowGap", "columnGap", "width", "minWidth", "maxWidth",
    "height", "minHeight", "maxHeight", "padding", "paddingBlock", "paddingInline",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "margin",
    "marginBlock", "marginInline", "marginTop", "marginRight", "marginBottom",
    "marginLeft", "position", "insetBlock", "insetInline", "top", "right", "bottom",
    "left", "zIndex", "aspectRatio", "overflow", "overflowX", "overflowY", "cursor",
    "transition", "transform", "filter", "backdropBlur", "objectFit", "objectPosition",
    "mixBlendMode", "isolation",
}

PAINT_PROPERTIES = {
    "backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition",
    "backgroundRepeat", "backgroundImages", "backgroundSizes", "backgroundPositions",
    "backgroundRepeats", "backgroundBlendModes", "color", "caretColor", "accentColor",
    "textDecorationColor", "borderColor", "borderTopColor", "borderRightColor",
    "borderBottomColor", "borderLeftColor", "borderWidth", "borderTopWidth",
    "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderStyle",
    "borderRadius", "borderTopLeftRadius", "borderTopRightRadius",
    "borderBottomRightRadius", "borderBottomLeftRadius", "outlineColor", "outlineWidth",
    "outlineOffset", "outlineStyle", "boxShadow", "opacity",
    "textAlign", "verticalAlign", "textIndent", "textDecoration", "textTransform",
    "textOverflow", "whiteSpace", "wordBreak", "overflowWrap", "cursor", "transition",
    "transform", "filter", "backdropBlur", "objectFit", "objectPosition",
    "mixBlendMode", "isolation",
}
CONTROL_PROPERTIES = PAINT_PROPERTIES | {
    "display", "flexDirection", "flexWrap", "alignItems", "alignContent",
    "justifyContent", "boxSizing", "width", "minWidth", "maxWidth", "height",
    "minHeight", "maxHeight", "padding", "paddingBlock", "paddingInline", "paddingTop",
    "paddingRight", "paddingBottom", "paddingLeft", "gap", "rowGap", "columnGap",
    "flexGrow", "flexShrink", "flexBasis", "alignSelf", "aspectRatio",
}
CONTAINER_PROPERTIES = CONTROL_PROPERTIES | {
    "justifySelf", "justifyItems", "placeItems", "placeContent", "gridTemplateColumns",
    "gridTemplateRows", "gridAutoFlow", "gridColumnSpan", "gridRowSpan", "margin",
    "marginBlock", "marginInline", "marginTop", "marginRight", "marginBottom",
    "marginLeft", "overflow", "overflowX", "overflowY",
}
LAYOUT_PROPERTIES = CONTAINER_PROPERTIES | {
    "order", "position", "insetBlock", "insetInline", "top", "right", "bottom",
    "left", "zIndex",
}
PROPERTY_PROFILES = {
    "paint": PAINT_PROPERTIES,
    "control": CONTROL_PROPERTIES,
    "container": CONTAINER_PROPERTIES,
    "layout": LAYOUT_PROPERTIES,
    "overlay": LAYOUT_PROPERTIES,
}
VISUAL_ROLES = {
    "workspace", "continuous-surface", "panel", "toolbar", "card", "control",
    "popup", "dialog", "divider", "content", "decoration",
}

COLOR_PROPERTIES = {
    "backgroundColor", "color", "caretColor", "accentColor", "textDecorationColor",
    "borderColor", "borderTopColor", "borderRightColor", "borderBottomColor",
    "borderLeftColor", "outlineColor",
}
LENGTH_PROPERTIES = {
    "borderWidth", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
    "borderLeftWidth", "borderRadius", "outlineWidth", "outlineOffset",
    "borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius",
    "borderBottomLeftRadius", "textIndent", "gap", "rowGap",
    "columnGap", "width", "minWidth", "maxWidth", "height", "minHeight", "maxHeight",
    "padding", "paddingBlock", "paddingInline", "paddingTop", "paddingRight",
    "paddingBottom", "paddingLeft", "margin", "marginBlock", "marginInline", "marginTop",
    "marginRight", "marginBottom", "marginLeft", "flexBasis", "insetBlock", "insetInline",
    "top", "right", "bottom", "left", "backdropBlur",
}
NUMBER_PROPERTIES = {
    "opacity", "flexGrow", "flexShrink", "gridColumnSpan",
    "gridRowSpan", "zIndex", "order",
}

ENUM_VALUES: dict[str, set[str]] = {
    "borderStyle": {"none", "solid", "dashed", "dotted"},
    "outlineStyle": {"none", "solid", "dashed", "dotted"},
    "backgroundSize": {"auto", "cover", "contain"},
    "backgroundPosition": {"center", "top", "right", "bottom", "left"},
    "backgroundRepeat": {"repeat", "repeat-x", "repeat-y", "no-repeat"},
    "boxSizing": {"content-box", "border-box"},
    "textAlign": {"left", "center", "right", "start", "end"},
    "verticalAlign": {"baseline", "sub", "super", "text-top", "text-bottom", "middle", "top", "bottom"},
    "textDecoration": {"none", "underline", "line-through"},
    "textTransform": {"none", "uppercase", "lowercase", "capitalize"},
    "textOverflow": {"clip", "ellipsis"},
    "whiteSpace": {"normal", "nowrap", "pre", "pre-wrap", "pre-line"},
    "wordBreak": {"normal", "break-all", "keep-all", "break-word"},
    "overflowWrap": {"normal", "break-word", "anywhere"},
    "display": {"block", "inline", "inline-block", "flex", "inline-flex", "grid"},
    "flexDirection": {"row", "row-reverse", "column", "column-reverse"},
    "flexWrap": {"nowrap", "wrap", "wrap-reverse"},
    "alignItems": {"stretch", "flex-start", "center", "flex-end", "baseline"},
    "alignContent": {"stretch", "flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"},
    "alignSelf": {"auto", "stretch", "flex-start", "center", "flex-end", "baseline"},
    "justifyContent": {"flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"},
    "justifySelf": {"auto", "stretch", "start", "center", "end"},
    "justifyItems": {"auto", "normal", "stretch", "start", "center", "end"},
    "placeItems": {"normal", "stretch", "start", "center", "end"},
    "placeContent": {"normal", "stretch", "start", "center", "end", "space-between", "space-around", "space-evenly"},
    "gridAutoFlow": {"row", "column", "dense", "row dense", "column dense"},
    "position": {"static", "relative", "absolute", "fixed", "sticky"},
    "overflow": {"visible", "hidden", "clip", "auto", "scroll"},
    "overflowX": {"visible", "hidden", "clip", "auto", "scroll"},
    "overflowY": {"visible", "hidden", "clip", "auto", "scroll"},
    "cursor": {"default", "pointer", "text", "move", "grab", "grabbing", "wait", "not-allowed"},
    "objectFit": {"fill", "contain", "cover", "none", "scale-down"},
    "objectPosition": {"center", "top", "right", "bottom", "left"},
    "mixBlendMode": {"normal", "multiply", "screen", "overlay", "darken", "lighten", "soft-light", "hard-light"},
    "isolation": {"auto", "isolate"},
}

BACKGROUND_SIZE_VALUES = {"auto", "cover", "contain"}
BACKGROUND_POSITION_VALUES = {"center", "top", "right", "bottom", "left"}
BACKGROUND_REPEAT_VALUES = {"repeat", "repeat-x", "repeat-y", "no-repeat"}
BACKGROUND_BLEND_VALUES = {"normal", "multiply", "screen", "overlay", "darken", "lighten", "soft-light", "hard-light"}
TRANSITION_PROPERTIES = {
    "all", "background-color", "background-position", "border-color", "border-radius",
    "box-shadow", "color", "filter", "gap", "height", "margin", "opacity", "padding",
    "width", "transform",
}
XTERM_COLOR_KEYS = {
    "background", "foreground", "cursor", "cursorAccent", "selectionBackground",
    "selectionForeground", "selectionInactiveBackground", "black", "red", "green",
    "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed",
    "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
}
MERMAID_KEYS = [
    "nodeFill", "nodeFillHover", "nodeText", "nodeStroke", "nodeStrokeHover",
    "clusterFill", "clusterText", "clusterStroke", "edgeStroke", "edgeLabelBackground",
    "edgeLabelText", "noteFill", "noteText", "noteStroke", "activationFill",
    "activationStroke", "success", "warning", "error", "errorBackground", "info",
    "highlight", "pieColors",
]
MIME_BY_EXTENSION = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm",
}


class AppearanceError(Exception):
    pass


def is_record(value: Any) -> bool:
    return isinstance(value, dict)


def finite_number(value: Any, minimum: float, maximum: float) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and minimum <= value <= maximum


def load_registry() -> dict[str, Any]:
    try:
        registry = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AppearanceError(f"Could not load bundled Appearance registry: {error}") from error
    if registry.get("schema") != "openbitfun.appearance.registry" or registry.get("schemaVersion") != 2:
        raise AppearanceError("Bundled Appearance registry has an unsupported schema")
    return registry


def known_keys(value: Mapping[str, Any], allowed: Iterable[str], path: str, error: Callable[[str, str, str], None]) -> None:
    allowed_set = set(allowed)
    for key in value:
        if key not in allowed_set:
            error(key if path == "$" else f"{path}.{key}", "UNKNOWN_FIELD", f"Unknown field: {key}")


class ManifestValidator:
    def __init__(self, registry: Mapping[str, Any]):
        self.registry = registry
        self.components = {item["id"]: item for item in registry.get("components", [])}
        self.scenes = {item["id"]: item for item in registry.get("scenes", [])}
        self.renderers = set(registry.get("renderers", []))
        self.theme_tokens = set(registry.get("themeTokenNames", []))
        self.scoped_theme_tokens = set(registry.get("scopedThemeTokenNames", []))
        self.theme_scope_ids = set(registry.get("themeScopeIds", []))
        self.widget_vars = set(registry.get("widgetVariableNames", []))
        self.errors: list[dict[str, str]] = []
        self.warnings: list[dict[str, str]] = []

    def error(self, path: str, code: str, message: str) -> None:
        self.errors.append({"path": path, "code": code, "message": message})

    def warning(self, path: str, code: str, message: str) -> None:
        self.warnings.append({"path": path, "code": code, "message": message})

    def validate(self, value: Any) -> list[dict[str, str]]:
        self.errors = []
        self.warnings = []
        if not is_record(value):
            self.error("$", "INVALID_PACKAGE", "Appearance package must be an object")
            return self.errors
        known_keys(value, [
            "schema", "schemaVersion", "id", "name", "author", "description", "version", "mode",
            "preview", "backgroundMedia", "requiredCapabilities", "globals", "materials", "components", "scenes", "renderers",
            "assets", "integrity",
        ], "$", self.error)
        if value.get("schema") != SCHEMA:
            self.error("schema", "INVALID_SCHEMA", f"Schema must be {SCHEMA}")
        if value.get("schemaVersion") != SCHEMA_VERSION:
            self.error("schemaVersion", "UNSUPPORTED_SCHEMA_VERSION", f"Schema version must be {SCHEMA_VERSION}")
        self.validate_id(value.get("id"), "id")
        name = value.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 100:
            self.error("name", "INVALID_NAME", "Name must be between 1 and 100 characters")
        for field, limit in (("author", 100), ("description", 500)):
            field_value = value.get(field)
            if field_value is not None and (not isinstance(field_value, str) or len(field_value) > limit):
                self.error(field, f"INVALID_{field.upper()}", f"Invalid {field}")
        version = value.get("version")
        if not isinstance(version, str) or not VERSION_PATTERN.fullmatch(version):
            self.error("version", "INVALID_VERSION", "Version must use semantic version syntax")
        if value.get("mode") not in ("light", "dark"):
            self.error("mode", "INVALID_MODE", "Mode must be light or dark")
        capabilities = value.get("requiredCapabilities")
        if capabilities is not None:
            supported = {"components.v1", "scenes.v1", "renderers.v1", "assets.v1", "background-media.v1"}
            if not isinstance(capabilities, list):
                self.error("requiredCapabilities", "INVALID_CAPABILITIES", "Required capabilities must be an array")
            else:
                for index, capability in enumerate(capabilities):
                    if capability not in supported:
                        self.error(f"requiredCapabilities.{index}", "UNSUPPORTED_CAPABILITY", f"Unsupported capability: {capability}")
        self.validate_globals(value.get("globals"), "globals")
        self.validate_materials(value.get("materials"), "materials")
        self.validate_surfaces(value.get("components"), "components", self.components, value.get("materials"))
        self.validate_surfaces(value.get("scenes"), "scenes", self.scenes, value.get("materials"))
        self.validate_renderers(value.get("renderers"))
        self.validate_assets(value.get("assets"))
        self.validate_preview(value.get("preview"), value.get("assets"))
        self.validate_background_media(value.get("backgroundMedia"), value.get("assets"))
        self.validate_video_asset_usage(
            value.get("backgroundMedia"),
            value.get("assets"),
            value.get("requiredCapabilities"),
        )
        self.validate_asset_references(value)
        self.validate_integrity(value.get("integrity"), value.get("assets"))
        self.audit_cascade_usage(value.get("components"), value.get("scenes"))
        self.validate_reference_graph(value)
        return self.errors

    def validate_id(self, value: Any, path: str) -> None:
        if not isinstance(value, str) or len(value) > 100 or not ID_PATTERN.fullmatch(value):
            self.error(path, "INVALID_ID", "Id must be a lowercase dotted or dashed identifier")

    def validate_globals(self, value: Any, path: str) -> None:
        if value is None:
            return
        if not is_record(value):
            self.error(path, "INVALID_GLOBALS", "Globals must be an object")
            return
        validators = {
            "colors": self.validate_color,
            "lengths": self.validate_length,
            "numbers": self.validate_number,
            "durations": self.validate_duration,
            "easings": self.validate_easing,
            "shadows": self.validate_shadow,
        }
        for group, entries in value.items():
            validator = validators.get(group)
            if validator is None:
                self.error(f"{path}.{group}", "UNKNOWN_GLOBAL_GROUP", f"Unknown global token group: {group}")
                continue
            if not is_record(entries):
                self.error(f"{path}.{group}", "INVALID_TOKEN_GROUP", "Token group must be an object")
                continue
            for token_id, token in entries.items():
                self.validate_id(token_id, f"{path}.{group}.{token_id}")
                validator(token, f"{path}.{group}.{token_id}")

    def validate_materials(self, value: Any, path: str) -> None:
        if value is None:
            return
        if not is_record(value):
            self.error(path, "INVALID_MATERIALS", "Materials must be an object")
            return
        for material_id, definition in value.items():
            self.validate_id(material_id, f"{path}.{material_id}")
            material_path = f"{path}.{material_id}"
            if not is_record(definition) or not is_record(definition.get("style")):
                self.error(material_path, "INVALID_MATERIAL", "Material must contain a style object")
                continue
            known_keys(definition, ["style", "visualRole"], material_path, self.error)
            visual_role = definition.get("visualRole")
            if visual_role is not None and visual_role not in VISUAL_ROLES:
                self.error(f"{material_path}.visualRole", "INVALID_VISUAL_ROLE", f"Unknown visual role {visual_role}")
            self.validate_style(definition["style"], f"{material_path}.style", None)

    def validate_surfaces(self, value: Any, path: str, descriptors: Mapping[str, Any], materials: Any) -> None:
        if value is None:
            return
        if not is_record(value):
            self.error(path, "INVALID_SURFACES", "Surface definitions must be an object")
            return
        for surface_id, surface in value.items():
            descriptor = descriptors.get(surface_id)
            if descriptor is None:
                self.error(f"{path}.{surface_id}", "UNKNOWN_SURFACE", f"No registered appearance contract for {surface_id}")
                continue
            self.validate_surface(surface, f"{path}.{surface_id}", descriptor, materials)

    def validate_surface(self, value: Any, path: str, descriptor: Mapping[str, Any], materials: Any) -> None:
        if not is_record(value) or not is_record(value.get("parts")):
            self.error(path, "INVALID_SURFACE", "Surface must contain a parts object")
            return
        known_keys(value, ["parts"], path, self.error)
        parts = {part["id"]: part for part in descriptor.get("parts", [])}
        facets = {facet["id"]: facet for facet in descriptor.get("facets", [])}
        states = {state["id"] for state in descriptor.get("states", [])}
        for part_id, rule in value["parts"].items():
            part_path = f"{path}.parts.{part_id}"
            part = parts.get(part_id)
            if part is None:
                self.error(part_path, "UNKNOWN_PART", f"Unknown part {part_id}")
                continue
            if not is_record(rule):
                self.error(part_path, "INVALID_PART_RULE", "Part rule must be an object")
                continue
            known_keys(
                rule,
                ["cascade", "materials", "decorationIntent", "base", "facets", "states", "contexts"],
                part_path,
                self.error,
            )
            if rule.get("cascade") is not None and rule.get("cascade") not in ("normal", "override"):
                self.error(f"{part_path}.cascade", "INVALID_CASCADE", "Cascade must be normal or override")
            decoration_intent = rule.get("decorationIntent")
            if decoration_intent is not None and decoration_intent not in ("flat", "separator", "framed"):
                self.error(
                    f"{part_path}.decorationIntent",
                    "INVALID_DECORATION_INTENT",
                    "Decoration intent must be flat, separator, or framed",
                )
            allowed = part.get("allowedProperties") or PROPERTY_PROFILES.get(part.get("propertyProfile", "container"))
            material_ids = rule.get("materials")
            material_styles: list[Mapping[str, Any]] = []
            if material_ids is not None:
                if not isinstance(material_ids, list) or not 1 <= len(material_ids) <= 8:
                    self.error(
                        f"{part_path}.materials",
                        "INVALID_MATERIAL_LIST",
                        "Materials must contain between 1 and 8 material ids",
                    )
                else:
                    for index, material_id in enumerate(material_ids):
                        material_path = f"{part_path}.materials.{index}"
                        if not isinstance(material_id, str) or not is_record(materials) or material_id not in materials:
                            self.error(material_path, "UNKNOWN_MATERIAL", f"Unknown material {material_id}")
                            continue
                        definition = materials[material_id]
                        if is_record(definition) and is_record(definition.get("style")):
                            material_styles.append(definition["style"])
                            self.validate_style(definition["style"], material_path, allowed)
            self.validate_style(rule.get("base"), f"{part_path}.base", allowed)
            effective_base: dict[str, Any] = {}
            for material_style in material_styles:
                effective_base.update(material_style)
            if is_record(rule.get("base")):
                effective_base.update(rule["base"])
            self.audit_part_visual_semantics(effective_base, rule, part, part_path)
            if rule.get("facets") is not None:
                if not is_record(rule["facets"]):
                    self.error(f"{part_path}.facets", "INVALID_FACETS", "Facets must be an object")
                else:
                    for facet_id, options in rule["facets"].items():
                        facet = facets.get(facet_id)
                        if facet is None:
                            self.error(f"{part_path}.facets.{facet_id}", "UNKNOWN_FACET", f"Unknown facet {facet_id}")
                            continue
                        if not is_record(options):
                            self.error(f"{part_path}.facets.{facet_id}", "INVALID_FACET_OPTIONS", "Facet options must be an object")
                            continue
                        for option, style in options.items():
                            if option not in facet.get("values", []):
                                self.error(f"{part_path}.facets.{facet_id}.{option}", "UNKNOWN_FACET_VALUE", f"Unknown {facet_id} value {option}")
                                continue
                            style_path = f"{part_path}.facets.{facet_id}.{option}"
                            self.validate_style(style, style_path, allowed)
                            if is_record(style):
                                self.audit_part_visual_semantics(style, rule, part, style_path)
            if rule.get("states") is not None:
                if not is_record(rule["states"]):
                    self.error(f"{part_path}.states", "INVALID_STATES", "States must be an object")
                else:
                    for state_id, style in rule["states"].items():
                            if state_id not in states:
                                self.error(f"{part_path}.states.{state_id}", "UNKNOWN_STATE", f"Unknown state {state_id}")
                                continue
                            style_path = f"{part_path}.states.{state_id}"
                            self.validate_style(style, style_path, allowed)
                            if is_record(style):
                                self.audit_part_visual_semantics(style, rule, part, style_path)
            if rule.get("contexts") is not None:
                if not isinstance(rule["contexts"], list):
                    self.error(f"{part_path}.contexts", "INVALID_CONTEXTS", "Contexts must be an array")
                else:
                    for index, context in enumerate(rule["contexts"]):
                        context_path = f"{part_path}.contexts.{index}"
                        if not is_record(context) or not is_record(context.get("when")):
                            self.error(context_path, "INVALID_CONTEXT", "Context must contain a when object")
                            continue
                        known_keys(context, ["when", "style"], context_path, self.error)
                        known_keys(context["when"], ["facets", "states"], f"{context_path}.when", self.error)
                        self.validate_condition(context["when"], context_path, facets, states)
                        style_path = f"{context_path}.style"
                        self.validate_style(context.get("style"), style_path, allowed)
                        if is_record(context.get("style")):
                            self.audit_part_visual_semantics(context["style"], rule, part, style_path)

    def validate_condition(self, value: Mapping[str, Any], path: str, facets: Mapping[str, Any], states: set[str]) -> None:
        if value.get("facets") is not None:
            if not is_record(value["facets"]):
                self.error(f"{path}.when.facets", "INVALID_CONDITION_FACETS", "Condition facets must be an object")
            else:
                for facet_id, option in value["facets"].items():
                    facet = facets.get(facet_id)
                    if facet is None or not isinstance(option, str) or option not in facet.get("values", []):
                        self.error(f"{path}.when.facets.{facet_id}", "INVALID_CONDITION_FACET", f"Invalid facet condition {facet_id}={option}")
        if value.get("states") is not None:
            if not isinstance(value["states"], list):
                self.error(f"{path}.when.states", "INVALID_CONDITION_STATES", "Condition states must be an array")
            else:
                for index, state in enumerate(value["states"]):
                    if not isinstance(state, str) or state not in states:
                        self.error(f"{path}.when.states.{index}", "INVALID_CONDITION_STATE", f"Invalid state condition {state}")

    def validate_style(self, value: Any, path: str, allowed_properties: Sequence[str] | None) -> None:
        if value is None:
            return
        if not is_record(value):
            self.error(path, "INVALID_STYLE", "Style must be an object")
            return
        allowed = set(allowed_properties) if allowed_properties is not None else STYLE_PROPERTIES
        self.validate_background_layers(value, path)
        if value.get("borderStyle") is not None and value.get("borderWidth") is None:
            self.warning(
                path,
                "BORDER_WIDTH_NORMALIZED",
                "Border style without a global width is normalized to zero before side widths are applied",
            )
        if (value.get("outlineWidth") is not None or value.get("outlineColor") is not None) and value.get("outlineStyle") is None:
            self.warning(
                path,
                "OUTLINE_STYLE_NORMALIZED",
                "Outline width/color without a style is normalized to solid",
            )
        for prop, prop_value in value.items():
            prop_path = f"{path}.{prop}"
            if prop not in STYLE_PROPERTIES or prop not in allowed:
                self.error(prop_path, "UNSUPPORTED_STYLE_PROPERTY", f"Style property {prop} is not allowed")
                continue
            if prop in COLOR_PROPERTIES:
                self.validate_color(prop_value, prop_path)
            elif prop in LENGTH_PROPERTIES:
                self.validate_length(prop_value, prop_path)
            elif prop in NUMBER_PROPERTIES:
                self.validate_number(prop_value, prop_path)
            elif prop == "backgroundImage":
                self.validate_asset_reference(prop_value, prop_path)
            elif prop == "backgroundImages":
                if not isinstance(prop_value, list) or not 1 <= len(prop_value) <= 8:
                    self.error(prop_path, "INVALID_BACKGROUND_IMAGES", "Background images must contain between 1 and 8 package asset references")
                else:
                    for index, asset in enumerate(prop_value):
                        self.validate_asset_reference(asset, f"{prop_path}.{index}")
            elif prop == "backgroundSizes":
                if not isinstance(prop_value, list):
                    self.error(prop_path, "INVALID_BACKGROUND_SIZES", "Background sizes must be an array")
                else:
                    for index, item in enumerate(prop_value):
                        self.validate_background_size(item, f"{prop_path}.{index}")
            elif prop == "backgroundPositions":
                if not isinstance(prop_value, list):
                    self.error(prop_path, "INVALID_BACKGROUND_POSITIONS", "Background positions must be an array")
                else:
                    for index, item in enumerate(prop_value):
                        self.validate_background_position(item, f"{prop_path}.{index}")
            elif prop == "backgroundRepeats":
                self.validate_string_array(prop_value, prop_path, BACKGROUND_REPEAT_VALUES, "INVALID_BACKGROUND_REPEATS")
            elif prop == "backgroundBlendModes":
                self.validate_string_array(prop_value, prop_path, BACKGROUND_BLEND_VALUES, "INVALID_BACKGROUND_BLEND_MODES")
            elif prop == "boxShadow":
                if not isinstance(prop_value, list):
                    self.error(prop_path, "INVALID_SHADOW_LIST", "Box shadow must be an array")
                else:
                    for index, shadow in enumerate(prop_value):
                        self.validate_shadow(shadow, f"{prop_path}.{index}")
            elif prop == "transition":
                self.validate_transition(prop_value, prop_path)
            elif prop == "transform":
                self.validate_transform(prop_value, prop_path)
            elif prop in ("gridTemplateColumns", "gridTemplateRows"):
                self.validate_grid_template(prop_value, prop_path)
            elif prop == "aspectRatio":
                self.validate_ratio(prop_value, prop_path)
            elif prop == "filter":
                self.validate_filter(prop_value, prop_path)
            elif str(prop_value) not in ENUM_VALUES.get(prop, set()):
                self.error(prop_path, "INVALID_ENUM_VALUE", f"Invalid value for {prop}")

    def validate_background_layers(self, style: Mapping[str, Any], path: str) -> None:
        layered = ["backgroundSizes", "backgroundPositions", "backgroundRepeats", "backgroundBlendModes"]
        singular = ["backgroundImage", "backgroundSize", "backgroundPosition", "backgroundRepeat"]
        images = style.get("backgroundImages")
        if images is None:
            for key in layered:
                if style.get(key) is not None:
                    self.error(f"{path}.{key}", "BACKGROUND_LAYERS_REQUIRE_IMAGES", f"{key} requires backgroundImages")
            return
        for key in singular:
            if style.get(key) is not None:
                self.error(f"{path}.{key}", "CONFLICTING_BACKGROUND_FIELDS", f"{key} cannot be combined with backgroundImages")
        if isinstance(images, list):
            for key in layered:
                values = style.get(key)
                if isinstance(values, list) and len(values) != len(images):
                    self.error(f"{path}.{key}", "BACKGROUND_LAYER_COUNT_MISMATCH", f"{key} must contain exactly {len(images)} entries")

    def validate_asset_reference(self, value: Any, path: str) -> None:
        if not is_record(value) or value.get("kind") != "asset" or not isinstance(value.get("assetId"), str) or not ID_PATTERN.fullmatch(value["assetId"]):
            self.error(path, "INVALID_ASSET_REFERENCE", "Background image must be a package asset reference")

    def validate_background_size(self, value: Any, path: str) -> None:
        if isinstance(value, str) and value in BACKGROUND_SIZE_VALUES:
            return
        if not is_record(value) or value.get("kind") != "backgroundSize":
            self.error(path, "INVALID_BACKGROUND_SIZE", "Background size must be auto, cover, contain, or a structured size")
            return
        known_keys(value, ["kind", "width", "height"], path, self.error)
        self.validate_background_dimension(value.get("width"), f"{path}.width")
        if value.get("height") is not None:
            self.validate_background_dimension(value["height"], f"{path}.height")

    def validate_background_position(self, value: Any, path: str) -> None:
        if isinstance(value, str) and value in BACKGROUND_POSITION_VALUES:
            return
        if not is_record(value) or value.get("kind") != "backgroundPosition":
            self.error(path, "INVALID_BACKGROUND_POSITION", "Background position must be a keyword or structured x/y position")
            return
        known_keys(value, ["kind", "x", "y"], path, self.error)
        self.validate_background_position_coordinate(value.get("x"), f"{path}.x")
        self.validate_background_position_coordinate(value.get("y"), f"{path}.y")

    def validate_background_dimension(self, value: Any, path: str) -> None:
        if self.validate_reference(value, "lengths", path) or (is_record(value) and value.get("kind") == "zero"):
            return
        if is_record(value) and value.get("kind") in ("px", "rem", "em", "ch", "vw", "vh", "percent") and finite_number(value.get("value"), 0, 10000):
            return
        if is_record(value) and value.get("kind") == "lengthKeyword" and value.get("value") == "auto":
            return
        self.error(path, "INVALID_BACKGROUND_DIMENSION", "Background dimensions must be non-negative lengths, auto, or references")

    def validate_background_position_coordinate(self, value: Any, path: str) -> None:
        if self.validate_reference(value, "lengths", path) or (is_record(value) and value.get("kind") == "zero"):
            return
        if is_record(value) and value.get("kind") in ("px", "rem", "em", "ch", "vw", "vh", "percent") and finite_number(value.get("value"), -10000, 10000):
            return
        self.error(path, "INVALID_BACKGROUND_POSITION_COORDINATE", "Background position coordinates must be lengths or references")

    def validate_string_array(self, value: Any, path: str, allowed: set[str], code: str) -> None:
        if not isinstance(value, list):
            self.error(path, code, "Value must be an array")
            return
        for index, item in enumerate(value):
            if not isinstance(item, str) or item not in allowed:
                self.error(f"{path}.{index}", code, f"Unsupported value {item}")

    def validate_reference(self, value: Any, expected_group: str, path: str) -> bool:
        if not is_record(value) or value.get("kind") != "ref" or not isinstance(value.get("path"), str):
            return False
        if not REFERENCE_PATTERN.fullmatch(value["path"]):
            return False
        if not value["path"].startswith(f"globals.{expected_group}."):
            self.error(path, "REFERENCE_TYPE_MISMATCH", f"Reference must target globals.{expected_group}")
        return True

    def validate_color(self, value: Any, path: str) -> None:
        if self.validate_reference(value, "colors", path):
            return
        if not is_record(value):
            self.error(path, "INVALID_COLOR", "Color must be a structured color value")
            return
        if value.get("kind") == "transparent":
            return
        if value.get("kind") == "hex" and isinstance(value.get("value"), str) and re.fullmatch(r"#[0-9a-f]{3,8}", value["value"], re.I) and len(value["value"]) in (4, 5, 7, 9):
            return
        if value.get("kind") == "rgb" and all(finite_number(value.get(key), 0, 255) for key in ("r", "g", "b")) and (value.get("a") is None or finite_number(value.get("a"), 0, 1)):
            return
        if value.get("kind") == "hsl" and finite_number(value.get("h"), 0, 360) and finite_number(value.get("s"), 0, 100) and finite_number(value.get("l"), 0, 100) and (value.get("a") is None or finite_number(value.get("a"), 0, 1)):
            return
        self.error(path, "INVALID_COLOR", "Invalid structured color value")

    def validate_length(self, value: Any, path: str) -> None:
        if self.validate_reference(value, "lengths", path) or (is_record(value) and value.get("kind") == "zero"):
            return
        if is_record(value) and value.get("kind") in ("px", "rem", "em", "ch", "vw", "vh", "percent") and finite_number(value.get("value"), -10000, 10000):
            return
        if is_record(value) and value.get("kind") == "lengthKeyword" and value.get("value") in ("auto", "min-content", "max-content", "fit-content"):
            return
        self.error(path, "INVALID_LENGTH", "Length must be a structured unit, keyword, zero, or reference value")

    def validate_number(self, value: Any, path: str) -> None:
        if self.validate_reference(value, "numbers", path):
            return
        if is_record(value) and value.get("kind") == "number" and finite_number(value.get("value"), -10000, 10000):
            return
        self.error(path, "INVALID_NUMBER", "Number must be a structured number or reference value")

    def validate_duration(self, value: Any, path: str) -> None:
        if self.validate_reference(value, "durations", path):
            return
        if is_record(value) and value.get("kind") == "ms" and finite_number(value.get("value"), 0, 10000):
            return
        self.error(path, "INVALID_DURATION", "Duration must be a structured millisecond or reference value")

    def validate_easing(self, value: Any, path: str) -> None:
        if self.validate_reference(value, "easings", path):
            return
        if is_record(value) and value.get("kind") == "easing" and value.get("value") in ("linear", "standard", "decelerate", "accelerate"):
            return
        self.error(path, "INVALID_EASING", "Easing must be a supported structured easing value")

    def validate_shadow(self, value: Any, path: str) -> None:
        if self.validate_reference(value, "shadows", path) or (is_record(value) and value.get("kind") == "none"):
            return
        if not is_record(value) or value.get("kind") != "shadow":
            self.error(path, "INVALID_SHADOW", "Shadow must be a structured shadow, none, or reference value")
            return
        self.validate_length(value.get("x"), f"{path}.x")
        self.validate_length(value.get("y"), f"{path}.y")
        self.validate_length(value.get("blur"), f"{path}.blur")
        if value.get("spread") is not None:
            self.validate_length(value["spread"], f"{path}.spread")
        self.validate_color(value.get("color"), f"{path}.color")
        if value.get("inset") is not None and not isinstance(value["inset"], bool):
            self.error(f"{path}.inset", "INVALID_SHADOW_INSET", "Shadow inset must be boolean")

    def validate_transition(self, value: Any, path: str) -> None:
        if not isinstance(value, list) or len(value) > 12:
            self.error(path, "INVALID_TRANSITION", "Transition must be an array with at most 12 items")
            return
        for index, item in enumerate(value):
            item_path = f"{path}.{index}"
            if not is_record(item) or item.get("property") not in TRANSITION_PROPERTIES:
                self.error(item_path, "INVALID_TRANSITION_ITEM", "Transition item has an unsupported property")
                continue
            self.validate_duration(item.get("duration"), f"{item_path}.duration")
            self.validate_easing(item.get("easing"), f"{item_path}.easing")
            if item.get("delay") is not None:
                self.validate_duration(item["delay"], f"{item_path}.delay")

    def validate_transform(self, value: Any, path: str) -> None:
        if not is_record(value) or value.get("kind") != "transform":
            self.error(path, "INVALID_TRANSFORM", "Transform must be a structured transform value")
            return
        if value.get("scale") is not None and not finite_number(value["scale"], 0, 10):
            self.error(f"{path}.scale", "INVALID_SCALE", "Scale must be between 0 and 10")
        if value.get("translateX") is not None:
            self.validate_length(value["translateX"], f"{path}.translateX")
        if value.get("translateY") is not None:
            self.validate_length(value["translateY"], f"{path}.translateY")
        if value.get("rotate") is not None and not finite_number(value["rotate"], -3600, 3600):
            self.error(f"{path}.rotate", "INVALID_ROTATION", "Rotation must be between -3600 and 3600 degrees")

    def validate_grid_template(self, value: Any, path: str) -> None:
        if not is_record(value) or value.get("kind") != "gridTracks" or not isinstance(value.get("tracks"), list) or not 1 <= len(value["tracks"]) <= 24:
            self.error(path, "INVALID_GRID_TEMPLATE", "Grid template must contain between 1 and 24 structured tracks")
            return
        for index, track in enumerate(value["tracks"]):
            if is_record(track) and track.get("kind") == "fr" and finite_number(track.get("value"), 0.01, 100):
                continue
            if is_record(track) and track.get("kind") == "trackKeyword" and track.get("value") in ("auto", "min-content", "max-content"):
                continue
            self.validate_length(track, f"{path}.tracks.{index}")

    def validate_ratio(self, value: Any, path: str) -> None:
        if not is_record(value) or value.get("kind") != "ratio" or not finite_number(value.get("width"), 0.01, 10000) or not finite_number(value.get("height"), 0.01, 10000):
            self.error(path, "INVALID_ASPECT_RATIO", "Aspect ratio must contain positive width and height values")

    def validate_filter(self, value: Any, path: str) -> None:
        if not isinstance(value, list) or len(value) > 8:
            self.error(path, "INVALID_FILTER", "Filter must be an array with at most 8 items")
            return
        for index, item in enumerate(value):
            item_path = f"{path}.{index}"
            if not is_record(item):
                self.error(item_path, "INVALID_FILTER_ITEM", "Filter item must be structured")
            elif item.get("kind") == "blur":
                self.validate_length(item.get("value"), f"{item_path}.value")
            elif item.get("kind") in ("brightness", "contrast", "grayscale", "saturate"):
                self.validate_number(item.get("value"), f"{item_path}.value")
            elif item.get("kind") == "hueRotate" and finite_number(item.get("degrees"), -3600, 3600):
                continue
            else:
                self.error(item_path, "INVALID_FILTER_ITEM", f"Unsupported filter {item.get('kind')}")

    def validate_renderers(self, value: Any) -> None:
        if value is None:
            return
        if not is_record(value):
            self.error("renderers", "INVALID_RENDERERS", "Renderers must be an object")
            return
        for renderer_id, definition in value.items():
            path = f"renderers.{renderer_id}"
            if renderer_id not in self.renderers:
                self.error(path, "UNKNOWN_RENDERER", f"No registered renderer adapter for {renderer_id}")
                continue
            if not is_record(definition) or definition.get("version") != 1 or not is_record(definition.get("settings")):
                self.error(path, "INVALID_RENDERER_DEFINITION", "Renderer definition must use version 1 and contain settings")
                continue
            known_keys(definition, ["version", "settings"], path, self.error)
            self.scan_renderer_text(definition["settings"], f"{path}.settings")
            renderer_errors = self.validate_renderer_settings(renderer_id, definition["settings"])
            for message in renderer_errors:
                self.error(f"{path}.settings", "INVALID_RENDERER_SETTINGS", message)

    def scan_renderer_text(self, value: Any, path: str) -> None:
        if isinstance(value, str):
            if FORBIDDEN_RENDERER_TEXT.search(value):
                self.error(path, "FORBIDDEN_RENDERER_TEXT", "Renderer settings cannot contain URLs, markup, or CSS syntax")
        elif isinstance(value, list):
            for index, item in enumerate(value):
                self.scan_renderer_text(item, f"{path}.{index}")
        elif is_record(value):
            for key, item in value.items():
                self.scan_renderer_text(item, f"{path}.{key}")

    def validate_renderer_settings(self, renderer_id: str, settings: Mapping[str, Any]) -> list[str]:
        if renderer_id == "theme-tokens":
            return self.validate_theme_tokens(settings)
        if renderer_id == "monaco":
            return self.validate_monaco(settings)
        if renderer_id == "xterm":
            return self.validate_xterm(settings)
        if renderer_id == "mermaid":
            return self.validate_mermaid(settings)
        if renderer_id == "generative-widget":
            return self.validate_widget(settings)
        return [f"Unsupported renderer: {renderer_id}"]

    def validate_theme_token_map(
        self,
        tokens: Any,
        allowed_names: set[str],
        path: str,
    ) -> list[str]:
        errors: list[str] = []
        if not is_record(tokens):
            return [f"{path} must be an object"]
        for name, value in tokens.items():
            if name not in allowed_names:
                errors.append(f"Unsupported {path} token name: {name}")
            if not isinstance(value, str) or not value or len(value) > 512:
                errors.append(f"{path} token {name} must be a non-empty string of at most 512 characters")
            elif CSS_TOKEN_FORBIDDEN.search(value):
                errors.append(f"{path} token {name} contains a forbidden value")
        return errors

    def validate_theme_tokens(self, settings: Mapping[str, Any]) -> list[str]:
        errors: list[str] = []
        for key in settings:
            if key not in ("tokens", "scopes"):
                errors.append(f"Unknown setting: {key}")
        errors.extend(self.validate_theme_token_map(settings.get("tokens"), self.theme_tokens, "root"))
        scopes = settings.get("scopes")
        if scopes is None:
            return errors
        if not is_record(scopes):
            errors.append("scopes must be an object")
            return errors
        for scope_id, tokens in scopes.items():
            if scope_id not in self.theme_scope_ids:
                errors.append(f"Unknown theme token scope: {scope_id}")
                continue
            errors.extend(self.validate_theme_token_map(
                tokens,
                self.scoped_theme_tokens,
                f"scope {scope_id}",
            ))
        return errors

    def validate_monaco(self, settings: Mapping[str, Any]) -> list[str]:
        errors: list[str] = []
        known = {"id", "base", "inherit", "rules", "colors"}
        for key in settings:
            if key not in known:
                errors.append(f"Unknown setting: {key}")
        if not isinstance(settings.get("id"), str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,95}", settings["id"]):
            errors.append("id must contain only lowercase letters, digits, and hyphens")
        if settings.get("base") not in ("vs", "vs-dark", "hc-black", "hc-light"):
            errors.append("base must be a supported Monaco base theme")
        if not isinstance(settings.get("inherit"), bool):
            errors.append("inherit must be boolean")
        rules = settings.get("rules")
        if not isinstance(rules, list) or len(rules) > 512:
            errors.append("rules must be an array with at most 512 entries")
        else:
            for index, rule in enumerate(rules):
                if not is_record(rule) or not isinstance(rule.get("token"), str) or len(rule["token"]) > 160:
                    errors.append(f"rules.{index}.token is invalid")
                    continue
                for key in rule:
                    if key not in ("token", "foreground", "background", "fontStyle"):
                        errors.append(f"rules.{index} has unknown field {key}")
                for key in ("foreground", "background"):
                    color = rule.get(key)
                    if color is not None and (not isinstance(color, str) or not MONACO_TOKEN_COLOR_PATTERN.fullmatch(color)):
                        errors.append(f"rules.{index}.{key} is not a supported color")
                font_style = rule.get("fontStyle")
                if font_style is not None and (not isinstance(font_style, str) or not FONT_STYLE_PATTERN.fullmatch(font_style)):
                    errors.append(f"rules.{index}.fontStyle is invalid")
        colors = settings.get("colors")
        if not is_record(colors) or len(colors) > 512:
            errors.append("colors must be an object with at most 512 entries")
        else:
            for key, color in colors.items():
                if not re.fullmatch(r"[A-Za-z][A-Za-z0-9.]{0,159}", key):
                    errors.append(f"colors.{key} has an invalid key")
                if not isinstance(color, str) or not MONACO_COLOR_PATTERN.fullmatch(color):
                    errors.append(f"colors.{key} is not a supported color")
        return errors

    def validate_xterm_colors(self, value: Any, path: str) -> list[str]:
        if not is_record(value):
            return [f"{path} must be an object"]
        errors: list[str] = []
        for key, color in value.items():
            if key not in XTERM_COLOR_KEYS:
                errors.append(f"{path}.{key} is not supported")
            if not isinstance(color, str) or not COLOR_STRING_PATTERN.fullmatch(color):
                errors.append(f"{path}.{key} is not a supported color")
        for key in ("background", "foreground", "cursor"):
            if not isinstance(value.get(key), str):
                errors.append(f"{path}.{key} is required")
        return errors

    def validate_xterm(self, settings: Mapping[str, Any]) -> list[str]:
        errors: list[str] = []
        for key in settings:
            if key != "surfaces":
                errors.append(f"Unknown setting: {key}")
        surfaces = settings.get("surfaces")
        if not is_record(surfaces):
            errors.append("surfaces must be an object")
        else:
            for key in surfaces:
                if key not in ("terminal", "output"):
                    errors.append(f"Unknown xterm surface: {key}")
            errors.extend(self.validate_xterm_colors(surfaces.get("terminal"), "surfaces.terminal"))
            errors.extend(self.validate_xterm_colors(surfaces.get("output"), "surfaces.output"))
        return errors

    def validate_mermaid(self, settings: Mapping[str, Any]) -> list[str]:
        errors: list[str] = []
        for key in settings:
            if key not in ("mode", "palette"):
                errors.append(f"Unknown setting: {key}")
        if settings.get("mode") not in ("light", "dark"):
            errors.append("mode must be light or dark")
        palette = settings.get("palette")
        if not is_record(palette):
            errors.append("palette must be an object")
            return errors
        for key in palette:
            if key not in MERMAID_KEYS:
                errors.append(f"palette.{key} is not supported")
        for key in MERMAID_KEYS:
            color = palette.get(key)
            if key == "pieColors":
                if not isinstance(color, list) or len(color) != 8 or any(not isinstance(item, str) or not COLOR_STRING_PATTERN.fullmatch(item) for item in color):
                    errors.append("palette.pieColors must contain exactly eight supported colors")
            elif not isinstance(color, str) or not COLOR_STRING_PATTERN.fullmatch(color):
                errors.append(f"palette.{key} is not a supported color")
        return errors

    def validate_widget(self, settings: Mapping[str, Any]) -> list[str]:
        errors: list[str] = []
        for key in settings:
            if key not in ("id", "mode", "vars"):
                errors.append(f"Unknown setting: {key}")
        if not isinstance(settings.get("id"), str) or not re.fullmatch(r"[a-z][a-z0-9.-]{0,95}", settings["id"]):
            errors.append("id is invalid")
        if settings.get("mode") not in ("light", "dark"):
            errors.append("mode must be light or dark")
        variables = settings.get("vars")
        if not is_record(variables) or len(variables) > 256:
            errors.append("vars must be an object with at most 256 entries")
        else:
            for key, value in variables.items():
                if key not in self.widget_vars:
                    errors.append(f"vars.{key} is not registered by the widget host contract")
                if not isinstance(value, str) or len(value) > 256 or not WIDGET_SAFE_VALUE.fullmatch(value):
                    errors.append(f"vars.{key} has an unsafe value")
        return errors

    def validate_assets(self, value: Any) -> None:
        if value is None:
            return
        if not is_record(value):
            self.error("assets", "INVALID_ASSETS", "Assets must be an object")
            return
        for asset_id, asset in value.items():
            path = f"assets.{asset_id}"
            self.validate_id(asset_id, path)
            valid_image = is_record(asset) and asset.get("kind") == "image" and asset.get("mimeType") in ("image/png", "image/jpeg", "image/webp", "image/gif")
            valid_video = is_record(asset) and asset.get("kind") == "video" and asset.get("mimeType") in ("video/mp4", "video/webm")
            if not valid_image and not valid_video:
                self.error(path, "INVALID_ASSET", "Asset must be a supported image or video")
                continue
            known_keys(asset, ["kind", "mimeType", "source"], path, self.error)
            source = asset.get("source")
            if not is_record(source) or source.get("kind") != "package" or not isinstance(source.get("path"), str) or not safe_package_path(source["path"]):
                self.error(f"{path}.source", "INVALID_ASSET_PATH", "Asset path must be a safe package-relative path")
            else:
                known_keys(source, ["kind", "path"], f"{path}.source", self.error)

    def validate_preview(self, value: Any, assets: Any) -> None:
        if value is None:
            return
        if not is_record(value) or value.get("kind") != "asset" or not isinstance(value.get("assetId"), str):
            self.error("preview", "INVALID_PREVIEW", "Preview must reference a declared image asset")
            return
        if not is_record(assets) or value["assetId"] not in assets:
            self.error("preview.assetId", "UNKNOWN_ASSET_REFERENCE", f"Unknown appearance asset {value['assetId']}")
        elif not is_record(assets[value["assetId"]]) or assets[value["assetId"]].get("kind") != "image":
            self.error("preview.assetId", "PREVIEW_ASSET_NOT_IMAGE", "Preview must reference an image asset")

    def validate_background_media(self, value: Any, assets: Any) -> None:
        if value is None:
            return
        if not is_record(value) or value.get("kind") != "video":
            self.error("backgroundMedia", "INVALID_BACKGROUND_MEDIA", "Background media must be a video declaration")
            return
        known_keys(value, ["kind", "assetId", "posterAssetId", "fit", "position"], "backgroundMedia", self.error)
        for field, expected_kind in (("assetId", "video"), ("posterAssetId", "image")):
            asset_id = value.get(field)
            if not isinstance(asset_id, str):
                self.error(f"backgroundMedia.{field}", "INVALID_BACKGROUND_MEDIA_ASSET", f"{field} must reference a declared {expected_kind} asset")
            elif not is_record(assets) or asset_id not in assets:
                self.error(f"backgroundMedia.{field}", "UNKNOWN_ASSET_REFERENCE", f"Unknown appearance asset {asset_id}")
            elif not is_record(assets[asset_id]) or assets[asset_id].get("kind") != expected_kind:
                self.error(f"backgroundMedia.{field}", "BACKGROUND_MEDIA_ASSET_KIND_MISMATCH", f"{field} must reference a {expected_kind} asset")
        if value.get("fit") is not None and value.get("fit") not in ("cover", "contain"):
            self.error("backgroundMedia.fit", "INVALID_BACKGROUND_MEDIA_FIT", "Background media fit must be cover or contain")
        if value.get("position") is not None and value.get("position") not in BACKGROUND_POSITION_VALUES:
            self.error("backgroundMedia.position", "INVALID_BACKGROUND_MEDIA_POSITION", "Background media position is invalid")

    def validate_video_asset_usage(self, background_media: Any, assets: Any, capabilities: Any) -> None:
        if background_media is not None and (
            not isinstance(capabilities, list) or "background-media.v1" not in capabilities
        ):
            self.error(
                "requiredCapabilities",
                "MISSING_BACKGROUND_MEDIA_CAPABILITY",
                "Background media requires the background-media.v1 capability",
            )
        selected_video_id = background_media.get("assetId") if is_record(background_media) else None
        if not is_record(assets):
            return
        for asset_id, asset in assets.items():
            if is_record(asset) and asset.get("kind") == "video" and asset_id != selected_video_id:
                self.error(
                    f"assets.{asset_id}",
                    "UNUSED_VIDEO_ASSET",
                    "Video assets are allowed only when referenced by top-level backgroundMedia",
                )

    def validate_integrity(self, value: Any, assets: Any) -> None:
        if value is None:
            return
        if not is_record(value) or not is_record(value.get("sha256")):
            self.error("integrity", "INVALID_INTEGRITY", "Integrity must contain a sha256 object")
            return
        for asset_id, digest in value["sha256"].items():
            if not is_record(assets) or asset_id not in assets:
                self.error(f"integrity.sha256.{asset_id}", "UNKNOWN_INTEGRITY_ASSET", f"Unknown integrity asset {asset_id}")
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest, re.I):
                self.error(f"integrity.sha256.{asset_id}", "INVALID_SHA256", "SHA-256 digest must contain 64 hexadecimal characters")

    def validate_asset_references(self, manifest: Mapping[str, Any]) -> None:
        assets = manifest.get("assets")
        declared = set(assets) if is_record(assets) else set()
        for role, style in iter_styles(manifest):
            references: list[tuple[Any, str]] = []
            if is_record(style) and style.get("backgroundImage") is not None:
                references.append((style["backgroundImage"], f"{role}.backgroundImage"))
            if is_record(style) and isinstance(style.get("backgroundImages"), list):
                references.extend((item, f"{role}.backgroundImages.{index}") for index, item in enumerate(style["backgroundImages"]))
            for reference, path in references:
                if not is_record(reference) or reference.get("kind") != "asset" or not isinstance(reference.get("assetId"), str):
                    continue
                asset_id = reference["assetId"]
                if asset_id not in declared:
                    self.error(path, "UNKNOWN_ASSET_REFERENCE", f"Unknown appearance asset {asset_id}")
                elif is_record(assets) and is_record(assets[asset_id]) and assets[asset_id].get("kind") != "image":
                    self.error(path, "BACKGROUND_ASSET_NOT_IMAGE", "Style background assets must be images")

    def validate_reference_graph(self, manifest: Mapping[str, Any]) -> None:
        globals_value = manifest.get("globals")
        globals_map = globals_value if is_record(globals_value) else {}
        token_paths: set[str] = set()
        references: list[tuple[str, str]] = []
        graph: dict[str, set[str]] = {}

        for group, entries in globals_map.items():
            if not is_record(entries):
                continue
            for token_id in entries:
                token_paths.add(f"globals.{group}.{token_id}")

        def scan(value: Any, path: str, owner_token: str | None = None) -> None:
            if isinstance(value, list):
                for index, item in enumerate(value):
                    scan(item, f"{path}.{index}", owner_token)
                return
            if not is_record(value):
                return
            if value.get("kind") == "ref" and isinstance(value.get("path"), str) and REFERENCE_PATTERN.fullmatch(value["path"]):
                references.append((path, value["path"]))
                if owner_token is not None:
                    graph.setdefault(owner_token, set()).add(value["path"])
                return
            for key, child in value.items():
                child_path = key if path == "$" else f"{path}.{key}"
                scan(child, child_path, owner_token)

        for group, entries in globals_map.items():
            if not is_record(entries):
                continue
            for token_id, value in entries.items():
                token_path = f"globals.{group}.{token_id}"
                scan(value, token_path, token_path)
        for key, value in manifest.items():
            if key != "globals":
                scan(value, key)

        for source_path, target_path in references:
            if target_path not in token_paths:
                self.error(
                    source_path,
                    "UNKNOWN_TOKEN_REFERENCE",
                    f"Unknown appearance token reference: {target_path}",
                )

        visited: set[str] = set()
        visiting: set[str] = set()

        def visit(token_path: str) -> None:
            if token_path in visited:
                return
            if token_path in visiting:
                self.error(
                    token_path,
                    "CIRCULAR_TOKEN_REFERENCE",
                    f"Circular appearance token reference: {token_path}",
                )
                return
            visiting.add(token_path)
            for target_path in graph.get(token_path, set()):
                if target_path in token_paths:
                    visit(target_path)
            visiting.remove(token_path)
            visited.add(token_path)

        for token_path in token_paths:
            visit(token_path)

    def audit_part_visual_semantics(
        self,
        style: Mapping[str, Any],
        rule: Mapping[str, Any],
        part: Mapping[str, Any],
        path: str,
    ) -> None:
        if (
            not part.get("continuityGroup")
            and part.get("visualRole") != "continuous-surface"
        ) or rule.get("decorationIntent") == "framed":
            return
        radius_properties = (
            "borderRadius",
            "borderTopLeftRadius",
            "borderTopRightRadius",
            "borderBottomRightRadius",
            "borderBottomLeftRadius",
        )
        shadows = style.get("boxShadow")
        has_full_frame = (
            self.has_non_zero_length(style.get("borderWidth"))
            or any(self.has_non_zero_length(style.get(prop)) for prop in radius_properties)
            or (
                isinstance(shadows, list)
                and any(not is_record(shadow) or shadow.get("kind") != "none" for shadow in shadows)
            )
        )
        if not has_full_frame:
            return
        suffix = f" {part['continuityGroup']}" if part.get("continuityGroup") else ""
        self.warning(
            path,
            "CONTINUOUS_SURFACE_FRAMED",
            f"Continuous surface{suffix} uses a full frame without decorationIntent=framed",
        )

    @staticmethod
    def has_non_zero_length(value: Any) -> bool:
        if not is_record(value):
            return value is not None
        if value.get("kind") == "zero":
            return False
        return not (isinstance(value.get("value"), (int, float)) and value.get("value") == 0)

    def audit_cascade_usage(self, components: Any, scenes: Any) -> None:
        total = 0
        overrides = 0
        for surfaces in (components, scenes):
            if not is_record(surfaces):
                continue
            for surface in surfaces.values():
                if not is_record(surface) or not is_record(surface.get("parts")):
                    continue
                for rule in surface["parts"].values():
                    if not is_record(rule):
                        continue
                    total += 1
                    if rule.get("cascade") == "override":
                        overrides += 1
        if total >= 4 and overrides / total > 0.25:
            self.warning(
                "$",
                "EXCESSIVE_OVERRIDE_USAGE",
                f"{overrides} of {total} part rules use override; override should be reserved for specific paint conflicts",
            )


def safe_package_path(value: str) -> bool:
    if not ASSET_PATH_PATTERN.fullmatch(value) or ".." in value or "\\" in value or value.startswith("/"):
        return False
    parts = PurePosixPath(value).parts
    return bool(parts) and all(part not in ("", ".", "..") for part in parts)


def iter_styles(manifest: Mapping[str, Any]) -> Iterable[tuple[str, Mapping[str, Any]]]:
    materials = manifest.get("materials")
    if is_record(materials):
        for material_id, definition in materials.items():
            if is_record(definition) and is_record(definition.get("style")):
                yield f"materials.{material_id}.style", definition["style"]
    for group_name in ("components", "scenes"):
        surfaces = manifest.get(group_name)
        if not is_record(surfaces):
            continue
        for surface_id, surface in surfaces.items():
            if not is_record(surface) or not is_record(surface.get("parts")):
                continue
            for part_id, rule in surface["parts"].items():
                if not is_record(rule):
                    continue
                base_path = f"{group_name}.{surface_id}.parts.{part_id}"
                if is_record(rule.get("base")):
                    yield f"{base_path}.base", rule["base"]
                facets = rule.get("facets")
                if is_record(facets):
                    for facet_id, options in facets.items():
                        if is_record(options):
                            for option, style in options.items():
                                if is_record(style):
                                    yield f"{base_path}.facets.{facet_id}.{option}", style
                states = rule.get("states")
                if is_record(states):
                    for state_id, style in states.items():
                        if is_record(style):
                            yield f"{base_path}.states.{state_id}", style
                contexts = rule.get("contexts")
                if isinstance(contexts, list):
                    for index, context in enumerate(contexts):
                        if is_record(context) and is_record(context.get("style")):
                            yield f"{base_path}.contexts.{index}.style", context["style"]


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AppearanceError(f"Could not read {path}: {error}") from error
    if not is_record(value):
        raise AppearanceError(f"JSON root must be an object: {path}")
    return value


def manifest_bytes(manifest: Mapping[str, Any]) -> bytes:
    return (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def read_image_info(data: bytes) -> tuple[str, int, int]:
    if len(data) >= 24 and data[0] == 0x89 and data[1:4] == b"PNG":
        return "image/png", int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if len(data) >= 10 and data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif", int.from_bytes(data[6:8], "little"), int.from_bytes(data[8:10], "little")
    if len(data) >= 30 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        chunk = data[12:16]
        if chunk == b"VP8X":
            return "image/webp", 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little")
        if chunk == b"VP8 ":
            return "image/webp", int.from_bytes(data[26:28], "little") & 0x3FFF, int.from_bytes(data[28:30], "little") & 0x3FFF
        if chunk == b"VP8L" and len(data) >= 25 and data[20] == 0x2F:
            bits = int.from_bytes(data[21:25], "little")
            return "image/webp", (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        raise AppearanceError("Appearance WebP dimensions could not be read")
    if len(data) >= 4 and data[:2] == b"\xff\xd8":
        offset = 2
        sof = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
        while offset + 8 < len(data):
            if data[offset] != 0xFF:
                offset += 1
                continue
            marker = data[offset + 1]
            if marker in (0xD8, 0xD9):
                offset += 2
                continue
            length = int.from_bytes(data[offset + 2:offset + 4], "big")
            if length < 2 or offset + 2 + length > len(data):
                break
            if marker in sof:
                return "image/jpeg", int.from_bytes(data[offset + 7:offset + 9], "big"), int.from_bytes(data[offset + 5:offset + 7], "big")
            offset += 2 + length
        raise AppearanceError("Appearance JPEG dimensions could not be read")
    raise AppearanceError("Appearance asset is not a supported image")


def assert_image_limits(path: str, data: bytes, expected_mime: str, max_bytes: int = MAX_IMAGE_BYTES) -> tuple[int, int]:
    if not 1 <= len(data) <= max_bytes:
        raise AppearanceError(f"Appearance asset has invalid size: {path}")
    mime, width, height = read_image_info(data)
    if mime != expected_mime:
        raise AppearanceError(f"Appearance asset MIME mismatch: {path}; declared {expected_mime}, found {mime}")
    if width <= 0 or height <= 0 or width > MAX_DIMENSION or height > MAX_DIMENSION or width * height > MAX_PIXELS:
        raise AppearanceError(f"Appearance image dimensions exceed the allowed limit: {path}")
    return width, height


def read_video_mime(data: bytes) -> str:
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return "video/mp4"
    if len(data) >= 16 and data[:4] == b"\x1a\x45\xdf\xa3" and b"webm" in data[:4096].lower():
        return "video/webm"
    raise AppearanceError("Appearance asset is not a supported video")


def assert_video_limits(path: str, data: bytes, expected_mime: str) -> None:
    if not 1 <= len(data) <= MAX_VIDEO_BYTES:
        raise AppearanceError(f"Appearance asset has invalid size: {path}")
    actual_mime = read_video_mime(data)
    if actual_mime != expected_mime:
        raise AppearanceError(f"Appearance asset MIME mismatch: {path}; declared {expected_mime}, found {actual_mime}")


def assert_asset_limits(
    path: str,
    data: bytes,
    definition: Mapping[str, Any],
    preview_asset: bool = False,
) -> None:
    if definition.get("kind") == "video":
        assert_video_limits(path, data, definition["mimeType"])
        return
    assert_image_limits(
        path,
        data,
        definition["mimeType"],
        MAX_PREVIEW_BYTES if preview_asset else MAX_IMAGE_BYTES,
    )


def format_issues(issues: Sequence[Mapping[str, str]]) -> str:
    return "\n".join(f"- {issue['path']} [{issue['code']}]: {issue['message']}" for issue in issues)


def validate_manifest(manifest: Mapping[str, Any], registry: Mapping[str, Any]) -> list[dict[str, str]]:
    validator = ManifestValidator(registry)
    issues = validator.validate(manifest)
    if issues:
        raise AppearanceError(f"Invalid appearance manifest:\n{format_issues(issues)}")
    return validator.warnings


def declared_assets(manifest: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    assets = manifest.get("assets")
    return dict(assets) if is_record(assets) else {}


def validate_project(
    project: Path,
    registry: Mapping[str, Any],
    warning_sink: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    project = project.resolve()
    manifest_path = project / MANIFEST_NAME
    if not project.is_dir() or not manifest_path.is_file():
        raise AppearanceError(f"Project must contain {MANIFEST_NAME}: {project}")
    raw_manifest = manifest_path.read_bytes()
    if not 1 <= len(raw_manifest) <= MAX_MANIFEST_BYTES:
        raise AppearanceError("Appearance manifest has invalid size")
    manifest = read_json(manifest_path)
    warnings = validate_manifest(manifest, registry)
    if warning_sink is not None:
        warning_sink.extend(warnings)
    assets = declared_assets(manifest)
    preview_asset_id = manifest.get("preview", {}).get("assetId") if is_record(manifest.get("preview")) else None
    allowed = {MANIFEST_NAME}
    total = len(raw_manifest)
    seen_paths: set[str] = set()
    for asset_id, definition in assets.items():
        package_path = definition["source"]["path"]
        if package_path in seen_paths:
            raise AppearanceError(f"Appearance assets cannot share package path: {package_path}")
        seen_paths.add(package_path)
        allowed.add(package_path)
        file_path = project.joinpath(*PurePosixPath(package_path).parts).resolve()
        try:
            file_path.relative_to(project)
        except ValueError as error:
            raise AppearanceError(f"Asset escapes project directory: {package_path}") from error
        if not file_path.is_file():
            raise AppearanceError(f"Declared appearance asset is missing: {package_path}")
        data = file_path.read_bytes()
        total += len(data)
        if total > MAX_EXPANDED_BYTES:
            raise AppearanceError("Appearance project exceeds the expanded size limit")
        assert_asset_limits(package_path, data, definition, asset_id == preview_asset_id)
        digest = manifest.get("integrity", {}).get("sha256", {}).get(asset_id) if is_record(manifest.get("integrity")) else None
        if digest and hashlib.sha256(data).hexdigest() != digest.lower():
            raise AppearanceError(f"Appearance asset integrity mismatch: {package_path}")
    actual = {
        path.relative_to(project).as_posix()
        for path in project.rglob("*")
        if path.is_file()
    }
    undeclared = sorted(actual - allowed)
    if undeclared:
        raise AppearanceError(f"Undeclared project files: {', '.join(undeclared)}")
    if len(actual) == 0 or len(actual) > MAX_ENTRIES:
        raise AppearanceError(f"Appearance project must contain between 1 and {MAX_ENTRIES} files")
    return manifest


def zip_is_symlink(info: zipfile.ZipInfo) -> bool:
    return ((info.external_attr >> 16) & 0o170000) == 0o120000


def validate_archive(
    archive_path: Path,
    registry: Mapping[str, Any],
    warning_sink: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    archive_path = archive_path.resolve()
    if not archive_path.is_file() or not 1 <= archive_path.stat().st_size <= MAX_ARCHIVE_BYTES:
        raise AppearanceError(f"Appearance archive must be between 1 byte and {MAX_ARCHIVE_BYTES} bytes")
    try:
        with zipfile.ZipFile(archive_path) as archive:
            infos = [info for info in archive.infolist() if not info.is_dir()]
            names = [info.filename for info in infos]
            if not 1 <= len(infos) <= MAX_ENTRIES:
                raise AppearanceError(f"Appearance archive must contain between 1 and {MAX_ENTRIES} files")
            if len(names) != len(set(names)):
                raise AppearanceError("Appearance archive contains duplicate paths")
            for info in infos:
                if not safe_package_path(info.filename):
                    raise AppearanceError(f"Unsafe archive path: {info.filename}")
                if zip_is_symlink(info):
                    raise AppearanceError(f"Symbolic links are not allowed: {info.filename}")
                if info.flag_bits & 0x1:
                    raise AppearanceError(f"Encrypted appearance archive entries are not supported: {info.filename}")
                if info.file_size > MAX_VIDEO_BYTES:
                    raise AppearanceError(f"Appearance archive entry is too large: {info.filename}")
            if sum(info.file_size for info in infos) > MAX_EXPANDED_BYTES:
                raise AppearanceError("Appearance archive expands beyond the allowed size")
            if MANIFEST_NAME not in names:
                raise AppearanceError(f"Appearance archive must contain {MANIFEST_NAME}")
            raw_manifest = archive.read(MANIFEST_NAME)
            if len(raw_manifest) > MAX_MANIFEST_BYTES:
                raise AppearanceError("Appearance manifest is too large")
            try:
                manifest = json.loads(raw_manifest.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise AppearanceError(f"Appearance manifest is not valid UTF-8 JSON: {error}") from error
            warnings = validate_manifest(manifest, registry)
            if warning_sink is not None:
                warning_sink.extend(warnings)
            assets = declared_assets(manifest)
            preview_asset_id = manifest.get("preview", {}).get("assetId") if is_record(manifest.get("preview")) else None
            path_to_asset: dict[str, tuple[str, Mapping[str, Any]]] = {}
            for asset_id, definition in assets.items():
                package_path = definition["source"]["path"]
                if package_path in path_to_asset:
                    raise AppearanceError(f"Appearance assets cannot share package path: {package_path}")
                path_to_asset[package_path] = (asset_id, definition)
            allowed = {MANIFEST_NAME, *path_to_asset}
            undeclared = sorted(set(names) - allowed)
            if undeclared:
                raise AppearanceError(f"Undeclared archive files: {', '.join(undeclared)}")
            missing = sorted(set(path_to_asset) - set(names))
            if missing:
                raise AppearanceError(f"Declared appearance assets are missing: {', '.join(missing)}")
            total = len(raw_manifest)
            for package_path, (asset_id, definition) in path_to_asset.items():
                data = archive.read(package_path)
                total += len(data)
                if total > MAX_EXPANDED_BYTES:
                    raise AppearanceError("Appearance archive expands beyond the allowed size")
                assert_asset_limits(package_path, data, definition, asset_id == preview_asset_id)
                digest = manifest.get("integrity", {}).get("sha256", {}).get(asset_id) if is_record(manifest.get("integrity")) else None
                if digest and hashlib.sha256(data).hexdigest() != digest.lower():
                    raise AppearanceError(f"Appearance asset integrity mismatch: {package_path}")
            return manifest
    except zipfile.BadZipFile as error:
        raise AppearanceError(f"Appearance archive is not a valid ZIP: {error}") from error


def command_init(args: argparse.Namespace, registry: Mapping[str, Any]) -> None:
    target = Path(args.project).resolve()
    if target.exists() and any(target.iterdir()):
        raise AppearanceError(f"Refusing to initialize non-empty directory: {target}")
    target.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema": SCHEMA,
        "schemaVersion": SCHEMA_VERSION,
        "id": args.id,
        "name": args.name,
        "version": "1.0.0",
        "mode": args.mode,
        "requiredCapabilities": [],
        "globals": {},
        "materials": {},
        "components": {},
        "scenes": {},
        "renderers": {},
        "assets": {},
        "integrity": {"sha256": {}},
    }
    if args.author is not None:
        manifest["author"] = args.author
    if args.description is not None:
        manifest["description"] = args.description
    validate_manifest(manifest, registry)
    (target / MANIFEST_NAME).write_bytes(manifest_bytes(manifest))
    (target / "assets").mkdir(exist_ok=True)
    print(f"INITIALIZED: {target}")
    print(f"Manifest: {target / MANIFEST_NAME}")


def command_build(args: argparse.Namespace, registry: Mapping[str, Any]) -> None:
    project = Path(args.project).resolve()
    manifest_path = project / MANIFEST_NAME
    manifest = read_json(manifest_path)
    assets = declared_assets(manifest)
    if assets and "assets.v1" not in manifest.get("requiredCapabilities", []):
        manifest.setdefault("requiredCapabilities", []).append("assets.v1")
    if manifest.get("backgroundMedia") and "background-media.v1" not in manifest.get("requiredCapabilities", []):
        manifest.setdefault("requiredCapabilities", []).append("background-media.v1")
    validate_manifest(manifest, registry)
    preview_asset_id = manifest.get("preview", {}).get("assetId") if is_record(manifest.get("preview")) else None
    digests: dict[str, str] = {}
    for asset_id, definition in assets.items():
        package_path = definition["source"]["path"]
        file_path = project.joinpath(*PurePosixPath(package_path).parts).resolve()
        if not file_path.is_file():
            raise AppearanceError(f"Declared appearance asset is missing: {package_path}")
        data = file_path.read_bytes()
        assert_asset_limits(package_path, data, definition, asset_id == preview_asset_id)
        digests[asset_id] = hashlib.sha256(data).hexdigest()
    manifest["integrity"] = {"sha256": digests}
    manifest_path.write_bytes(manifest_bytes(manifest))
    validate_project(project, registry)
    output = Path(args.output).resolve() if args.output else project.with_suffix(".openbitfun-appearance")
    if output.suffix != ".openbitfun-appearance":
        raise AppearanceError("Output filename must end in .openbitfun-appearance")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and not args.force:
        raise AppearanceError(f"Output already exists: {output}; pass --force")
    entries = [(MANIFEST_NAME, manifest_path.read_bytes())]
    video_paths = {
        definition["source"]["path"]
        for definition in assets.values()
        if definition.get("kind") == "video"
    }
    for asset_id, definition in sorted(assets.items()):
        package_path = definition["source"]["path"]
        data = project.joinpath(*PurePosixPath(package_path).parts).read_bytes()
        entries.append((package_path, data))
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED if name in video_paths else zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    validate_archive(output, registry)
    print(f"BUILT: {output}")
    print(f"Archive bytes: {output.stat().st_size}; assets: {len(assets)}; integrity hashes: {len(digests)}")


def source_kind(path: Path) -> str:
    if path.is_dir():
        return "project"
    if path.is_file() and path.suffix == ".openbitfun-appearance":
        return "archive"
    raise AppearanceError("Input must be an Appearance project directory or .openbitfun-appearance archive")


def command_validate(args: argparse.Namespace, registry: Mapping[str, Any]) -> None:
    source = Path(args.source).resolve()
    kind = source_kind(source)
    warnings: list[dict[str, str]] = []
    manifest = (
        validate_project(source, registry, warnings)
        if kind == "project"
        else validate_archive(source, registry, warnings)
    )
    print(f"VALID: {source}")
    print(f"Appearance: {manifest['name']} ({manifest['id']} {manifest['version']}, {manifest['mode']})")
    print(f"Components: {len(manifest.get('components', {}))}; scenes: {len(manifest.get('scenes', {}))}; assets: {len(manifest.get('assets', {}))}")
    if warnings:
        print(f"Warnings ({len(warnings)}):")
        print(format_issues(warnings))


def collect_asset_roles(manifest: Mapping[str, Any]) -> dict[str, list[str]]:
    roles = {asset_id: [] for asset_id in declared_assets(manifest)}
    preview = manifest.get("preview")
    if is_record(preview) and preview.get("kind") == "asset" and isinstance(preview.get("assetId"), str):
        roles.setdefault(preview["assetId"], []).append("preview")
    background_media = manifest.get("backgroundMedia")
    if is_record(background_media):
        if isinstance(background_media.get("assetId"), str):
            roles.setdefault(background_media["assetId"], []).append("backgroundMedia.video")
        if isinstance(background_media.get("posterAssetId"), str):
            roles.setdefault(background_media["posterAssetId"], []).append("backgroundMedia.poster")
    for path, style in iter_styles(manifest):
        if is_record(style.get("backgroundImage")) and style["backgroundImage"].get("kind") == "asset":
            roles.setdefault(style["backgroundImage"]["assetId"], []).append(f"{path}.backgroundImage")
        if isinstance(style.get("backgroundImages"), list):
            for index, item in enumerate(style["backgroundImages"]):
                if is_record(item) and item.get("kind") == "asset":
                    roles.setdefault(item["assetId"], []).append(f"{path}.backgroundImages.{index}")
    return roles


def inspect_manifest(manifest: Mapping[str, Any], source: Path) -> None:
    summary = {
        "source": str(source),
        "registryCommit": load_registry().get("generatedFrom"),
        "schema": manifest.get("schema"),
        "schemaVersion": manifest.get("schemaVersion"),
        "id": manifest.get("id"),
        "name": manifest.get("name"),
        "version": manifest.get("version"),
        "mode": manifest.get("mode"),
        "preview": manifest.get("preview"),
        "backgroundMedia": manifest.get("backgroundMedia"),
        "capabilities": manifest.get("requiredCapabilities", []),
        "globalTokenCounts": {key: len(value) for key, value in manifest.get("globals", {}).items() if is_record(value)},
        "materials": sorted(manifest.get("materials", {})),
        "components": {key: sorted(value.get("parts", {})) for key, value in manifest.get("components", {}).items() if is_record(value)},
        "scenes": {key: sorted(value.get("parts", {})) for key, value in manifest.get("scenes", {}).items() if is_record(value)},
        "renderers": sorted(manifest.get("renderers", {})),
        "assets": {},
    }
    roles = collect_asset_roles(manifest)
    for asset_id, definition in declared_assets(manifest).items():
        summary["assets"][asset_id] = {
            "path": definition["source"]["path"],
            "mimeType": definition["mimeType"],
            "roles": roles.get(asset_id, []),
            "integrity": manifest.get("integrity", {}).get("sha256", {}).get(asset_id),
        }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def command_inspect(args: argparse.Namespace, registry: Mapping[str, Any]) -> None:
    source = Path(args.source).resolve()
    kind = source_kind(source)
    manifest = validate_project(source, registry) if kind == "project" else validate_archive(source, registry)
    inspect_manifest(manifest, source)


def format_descriptor(descriptor: Mapping[str, Any], kind: str) -> dict[str, Any]:
    return {
        "kind": kind,
        "id": descriptor.get("id"),
        "parts": [
            {
                "id": part.get("id"),
                **({"allowedProperties": part.get("allowedProperties")} if part.get("allowedProperties") else {}),
                **({"propertyProfile": part.get("propertyProfile")} if part.get("propertyProfile") else {}),
                **({"forceableProperties": part.get("forceableProperties")} if part.get("forceableProperties") else {}),
                **({"visualRole": part.get("visualRole")} if part.get("visualRole") else {}),
                **({"continuityGroup": part.get("continuityGroup")} if part.get("continuityGroup") else {}),
            }
            for part in descriptor.get("parts", [])
        ],
        "facets": [
            {"id": facet.get("id"), "attribute": facet.get("attribute"), "values": facet.get("values", [])}
            for facet in descriptor.get("facets", [])
        ],
        "states": [
            {"id": state.get("id"), "selector": state.get("selector")}
            for state in descriptor.get("states", [])
        ],
    }


def command_contract(args: argparse.Namespace, registry: Mapping[str, Any]) -> None:
    if args.action == "properties":
        print(json.dumps(sorted(STYLE_PROPERTIES), indent=2))
        return
    if args.action == "tokens":
        key = "themeTokenNames" if args.token_kind == "theme" else "widgetVariableNames"
        print("\n".join(registry.get(key, [])))
        return
    if args.kind == "renderers":
        values = registry.get("renderers", [])
        if args.action == "list":
            print("\n".join(values))
            return
        raise AppearanceError("Renderer contracts are documented in references/renderer-contracts.md")
    key = "components" if args.kind == "components" else "scenes"
    descriptors = registry.get(key, [])
    if args.action == "list":
        term = (args.match or "").lower()
        rows = []
        for descriptor in descriptors:
            if term and term not in descriptor["id"].lower():
                continue
            rows.append(f"{descriptor['id']}\tparts={len(descriptor.get('parts', []))}\tfacets={len(descriptor.get('facets', []))}\tstates={len(descriptor.get('states', []))}")
        print("\n".join(rows))
        return
    descriptor = next((item for item in descriptors if item.get("id") == args.id), None)
    if descriptor is None:
        raise AppearanceError(f"Unknown {args.kind[:-1]} contract: {args.id}")
    print(json.dumps(format_descriptor(descriptor, args.kind[:-1]), ensure_ascii=False, indent=2))


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build and validate OpenBitFun .openbitfun-appearance packages")
    subparsers = parser.add_subparsers(dest="command", required=True)
    init = subparsers.add_parser("init", help="initialize a minimal sparse Appearance project")
    init.add_argument("project")
    init.add_argument("--id", required=True)
    init.add_argument("--name", required=True)
    init.add_argument("--mode", choices=("light", "dark"), default="dark")
    init.add_argument("--author")
    init.add_argument("--description")
    build = subparsers.add_parser("build", help="write integrity hashes and build a deterministic archive")
    build.add_argument("project")
    build.add_argument("--output")
    build.add_argument("--force", action="store_true")
    validate = subparsers.add_parser("validate", help="validate a project or archive")
    validate.add_argument("source")
    inspect = subparsers.add_parser("inspect", help="print a validated package summary and asset role map")
    inspect.add_argument("source")
    contract = subparsers.add_parser("contract", help="query the bundled production registry snapshot")
    contract_sub = contract.add_subparsers(dest="action", required=True)
    contract_list = contract_sub.add_parser("list")
    contract_list.add_argument("kind", choices=("components", "scenes", "renderers"))
    contract_list.add_argument("--match")
    contract_show = contract_sub.add_parser("show")
    contract_show.add_argument("kind", choices=("components", "scenes"))
    contract_show.add_argument("id")
    contract_tokens = contract_sub.add_parser("tokens")
    contract_tokens.add_argument("token_kind", choices=("theme", "widget"))
    contract_sub.add_parser("properties")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = create_parser().parse_args(argv)
    try:
        registry = load_registry()
        if args.command == "init":
            command_init(args, registry)
        elif args.command == "build":
            command_build(args, registry)
        elif args.command == "validate":
            command_validate(args, registry)
        elif args.command == "inspect":
            command_inspect(args, registry)
        elif args.command == "contract":
            command_contract(args, registry)
        return 0
    except AppearanceError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    except OSError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
