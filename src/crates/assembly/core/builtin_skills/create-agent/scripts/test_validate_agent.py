import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from validate_agent import validate_agent


ROOT = Path(__file__).resolve().parents[1]
VALID = """---
schema_version: 1
kind: subagent
id: investigator
name: Investigator
description: Investigate code
tools: [Read, Grep]
readonly: true
---
Inspect the requested code and report evidence.
"""


class AgentValidationTests(unittest.TestCase):
    def check_text(self, text, scope=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "agent.md"
            path.write_bytes(text.encode("utf-8"))
            before = path.read_bytes()
            errors = validate_agent(path, scope)
            self.assertEqual(path.read_bytes(), before)
            return errors

    def test_bundled_templates(self):
        self.assertEqual(validate_agent(ROOT / "assets/mode.md", "user"), [])
        self.assertEqual(validate_agent(ROOT / "assets/subagent.md", "project"), [])

    def test_optional_fields_and_line_endings(self):
        for change in [
            VALID.replace("tools: [Read, Grep]\n", ""),
            VALID.replace("[Read, Grep]", "[]"),
            VALID.replace("[Read, Grep]", "Read, Grep"),
            VALID.replace("readonly: true", "model: my-private-model-42"),
            VALID.replace("readonly: true", "model: inherit"),
            VALID.replace("\n", "\r\n"),
        ]:
            with self.subTest(text=change):
                self.assertEqual(self.check_text(change), [])

    def test_invalid_yaml_and_document_shape(self):
        for change in [
            VALID.replace("[Read, Grep]", "[Read"),
            VALID.replace("id: investigator", "id: investigator\nid: duplicate"),
            VALID.replace("readonly: true", "readonly: !!python/object:example {}"),
            "---\n[one, two]\n---\nPrompt", "---\n---\nPrompt",
            "\ufeff" + VALID, VALID.replace("---\n", "", 1),
            VALID.split("Inspect the requested")[0],
        ]:
            with self.subTest(text=change):
                self.assertTrue(self.check_text(change))

    def test_field_values(self):
        changes = [
            ("schema_version: 1", "schema_version: true"),
            ("schema_version: 1", "schema_version: 2"),
            ("kind: subagent", "kind: other"),
            ("id: investigator", "id: ../agent"),
            ("name: Investigator", "name: null"),
            ("description: Investigate code", 'description: ""'),
            ("readonly: true", 'readonly: "true"'),
            ("readonly: true", "readonly: yes"),
            ("readonly: true", "model: 42"),
            ("readonly: true", "model: null"),
            ("readonly: true", "typo: true"),
            ("[Read, Grep]", "[Read, UnknownTool]"),
            ("[Read, Grep]", "[Read, mcp__example__tool]"),
            ("[Read, Grep]", "[Read, 1]"),
            ("[Read, Grep]", "null"),
            ("[Read, Grep]", "[read]"),
            ("readonly: true", "user_context_policy: [unknown]"),
        ]
        for old, new in changes:
            with self.subTest(new=new):
                self.assertTrue(self.check_text(VALID.replace(old, new)))

    def test_scope_and_review_kind(self):
        mode = VALID.replace("kind: subagent", "kind: mode")
        self.assertTrue(self.check_text(mode, "project"))
        self.assertEqual(self.check_text(mode, "user"), [])
        self.assertTrue(self.check_text(mode.replace("readonly: true", "review: true")))

    def test_cli_exit_codes_and_missing_file(self):
        for name, expected in [("assets/mode.md", 0), ("missing.md", 1)]:
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts/validate_agent.py"), str(ROOT / name)],
                capture_output=True, text=True,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            self.assertEqual(result.returncode, expected, result.stderr)
            self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
