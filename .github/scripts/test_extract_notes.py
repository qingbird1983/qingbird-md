"""Tests for extract-notes.py — run with:
    python -m unittest .github/scripts/test_extract_notes.py -v
"""
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / ".github" / "scripts" / "extract-notes.py"


class ExtractNotesTests(unittest.TestCase):
    def _run(self, version: str, changelog: str) -> str:
        with tempfile.TemporaryDirectory() as tmp:
            cl = Path(tmp) / "CHANGELOG.md"
            cl.write_text(changelog, encoding="utf-8")
            out = Path(tmp) / "notes.md"
            subprocess.run(
                [sys.executable, str(SCRIPT),
                 "--version", version, "--changelog", str(cl), "--output", str(out)],
                check=True,
            )
            return out.read_text(encoding="utf-8")

    def test_extracts_section_with_date(self):
        cl = textwrap.dedent("""\
            # Changelog

            ## [0.1.4] - 2026-08-29

            ### Added
            - thing one
            - thing two

            ## [0.1.3] - 2026-08-29

            ### Fixed
            - old thing
        """)
        result = self._run("v0.1.4", cl)
        self.assertIn("### Added", result)
        self.assertIn("thing one", result)
        self.assertIn("thing two", result)
        self.assertNotIn("old thing", result)
        self.assertNotIn("[0.1.3]", result)

    def test_extracts_section_without_date(self):
        cl = textwrap.dedent("""\
            # Changelog

            ## [0.2.0]

            content here

            ## [0.1.0]

            older content
        """)
        result = self._run("0.2.0", cl)
        self.assertEqual(result, "content here\n")

    def test_strips_v_prefix(self):
        cl = "## [1.2.3] - 2026-01-01\n\nbody\n"
        self.assertEqual(self._run("v1.2.3", cl), "body\n")

    def test_extracts_last_section(self):
        cl = textwrap.dedent("""\
            ## [0.1.0]

            first

            ## [0.1.1]

            last
        """)
        result = self._run("v0.1.1", cl)
        self.assertEqual(result, "last\n")

    def test_missing_section_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            cl = Path(tmp) / "CHANGELOG.md"
            cl.write_text("## [0.1.0]\n\nfoo\n", encoding="utf-8")
            out = Path(tmp) / "notes.md"
            r = subprocess.run(
                [sys.executable, str(SCRIPT),
                 "--version", "v9.9.9", "--changelog", str(cl), "--output", str(out)],
                capture_output=True, text=True,
            )
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("no `## [9.9.9]`", r.stderr)

    def test_empty_section_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            cl = Path(tmp) / "CHANGELOG.md"
            cl.write_text("## [0.1.4]\n\n## [0.1.3]\n\nolder\n", encoding="utf-8")
            out = Path(tmp) / "notes.md"
            r = subprocess.run(
                [sys.executable, str(SCRIPT),
                 "--version", "v0.1.4", "--changelog", str(cl), "--output", str(out)],
                capture_output=True, text=True,
            )
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("empty", r.stderr)

    def test_missing_changelog_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as tmp:
            cl = Path(tmp) / "nope.md"
            out = Path(tmp) / "notes.md"
            r = subprocess.run(
                [sys.executable, str(SCRIPT),
                 "--version", "v0.1.4", "--changelog", str(cl), "--output", str(out)],
                capture_output=True, text=True,
            )
            self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
