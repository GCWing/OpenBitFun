#!/usr/bin/env python3
"""Validate authored OpenBitFun agent Markdown without changing the file."""

import argparse
import copy
from pathlib import Path
import re
import sys

try:
    import yaml
except ImportError:
    raise SystemExit("PyYAML is required. Install it with: python -m pip install PyYAML")


class AgentLoader(yaml.SafeLoader):
    """Reject duplicate keys and use YAML 1.2 boolean spelling."""

    yaml_implicit_resolvers = copy.deepcopy(yaml.SafeLoader.yaml_implicit_resolvers)

    def construct_mapping(self, node, deep=False):
        result = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str):
                raise yaml.constructor.ConstructorError(
                    None, None, "Field names must be strings", key_node.start_mark
                )
            if key in result:
                raise yaml.constructor.ConstructorError(
                    None, None, f"Duplicate field: {key}", key_node.start_mark
                )
            result[key] = self.construct_object(value_node, deep=deep)
        return result


for initial, resolvers in AgentLoader.yaml_implicit_resolvers.items():
    AgentLoader.yaml_implicit_resolvers[initial] = [
        (tag, pattern) for tag, pattern in resolvers
        if tag not in {"tag:yaml.org,2002:bool", "tag:yaml.org,2002:timestamp"}
    ]
AgentLoader.add_implicit_resolver(
    "tag:yaml.org,2002:bool",
    re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$"),
    list("tTfF"),
)

FIELDS = {
    "schema_version", "kind", "id", "name", "description", "tools", "readonly",
    "model", "review", "user_context_policy",
}
CONTEXT_SECTIONS = {
    "workspace_context", "workspace_instructions", "project_layout", "memory_summary",
}


def builtin_tools():
    catalog = Path(__file__).resolve().parents[1] / "references" / "tool-catalog.md"
    names = re.findall(r"^\| `([^`]+)` \| .+ \|$", catalog.read_text(encoding="utf-8"), re.M)
    if not names or len(names) != len(set(names)):
        raise ValueError("Bundled tool catalog is empty or contains duplicate tool names")
    return set(names)


def validate_agent(path, scope=None):
    """Return all discovered authoring errors; model availability is not checked."""
    path = Path(path)
    errors = []
    if path.suffix != ".md":
        errors.append("Agent file must have the .md extension")
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        return errors + [f"Cannot read UTF-8 file: {error}"]
    match = re.match(r"\A---\n(.*?)\n---(?:\n|\Z)", text, re.S)
    if not match:
        return errors + ["Start the file with YAML frontmatter between two standalone --- lines"]
    if not text[match.end():].strip():
        errors.append("Markdown body must contain a nonempty role prompt")
    try:
        fields = yaml.load(match[1], Loader=AgentLoader)
    except yaml.YAMLError as error:
        return errors + [f"Invalid YAML: {error}"]
    if not isinstance(fields, dict):
        return errors + ["YAML frontmatter must be a mapping of fields"]
    for key in sorted(set(fields) - FIELDS):
        errors.append(f"Unknown field: {key}")
    if type(fields.get("schema_version")) is not int or fields["schema_version"] != 1:
        errors.append("schema_version must be the integer 1")
    kind = fields.get("kind")
    if kind not in ("mode", "subagent"):
        errors.append("kind must be mode or subagent")
    if scope == "project" and kind == "mode":
        errors.append("Project scope supports subagents only")
    for key in ("id", "name", "description"):
        value = fields.get(key)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"{key} must be a nonempty string")
    identifier = fields.get("id")
    if isinstance(identifier, str) and not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", identifier):
        errors.append("id must start with a letter and contain only letters, digits, - or _")
    for key in ("readonly", "review"):
        if key in fields and type(fields[key]) is not bool:
            errors.append(f"{key} must be a boolean (true or false)")
    if fields.get("review") is True and kind != "subagent":
        errors.append("review: true is supported only for subagents")
    if "model" in fields:
        model = fields["model"]
        if not isinstance(model, str) or not model.strip():
            errors.append("model must be a nonempty string")
    if "tools" in fields:
        tools = fields["tools"]
        if isinstance(tools, str):
            tools = [tool.strip() for tool in tools.split(",") if tool.strip()]
        if not isinstance(tools, list) or any(not isinstance(tool, str) for tool in tools):
            errors.append("tools must be a list of tool names or a comma-separated string")
        else:
            try:
                allowed = builtin_tools()
            except (OSError, UnicodeError, ValueError) as error:
                errors.append(f"Cannot validate tools: {error}")
            else:
                invalid = sorted({tool for tool in tools if tool.strip() not in allowed})
                if invalid:
                    errors.append(f"Unknown built-in tools: {', '.join(repr(tool) for tool in invalid)}")
    if "user_context_policy" in fields:
        sections = fields["user_context_policy"]
        if not isinstance(sections, list) or any(
            not isinstance(section, str) or section.strip() not in CONTEXT_SECTIONS
            for section in sections
        ):
            errors.append("user_context_policy must be a list of supported context section names")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", type=Path, help="Agent Markdown files to validate")
    parser.add_argument("--scope", choices=("user", "project"), help="Intended installation scope")
    args = parser.parse_args()
    failed = False
    for path in args.files:
        errors = validate_agent(path, args.scope)
        if errors:
            failed = True
            for error in errors:
                print(f"{path}: {error}", file=sys.stderr)
        else:
            print(f"{path}: valid")
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
