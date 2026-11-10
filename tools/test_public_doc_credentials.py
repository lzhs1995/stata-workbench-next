"""Bounded current-Markdown bridge credential guard; not a history/secret audit.

Reject literal token assignments, bearer/custom-header values and the historical
port-to-hex-token notation. Report locations only, never the matched values.
Environment references and angle-bracket placeholders are the documented form.
"""
import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKIP_PREFIXES = ("node_modules/", "upstream/")
# A literal value in a credential assignment (hex, base64/base64url or opaque).
# Do not skip '$' or '<': environment expressions and placeholders are not values.
VALUE = r"[A-Za-z0-9_][A-Za-z0-9_./+~=-]*(?![A-Za-z0-9_./+~=-])"
LABEL = r"(?:STATA_BRIDGE_TOKEN|bridge[ _-]+token|X-Stata-Workbench-Token)"
ASSIGNMENT = re.compile(
    rf"(?i)(?<![\w{{$]){LABEL}[`\"'*]*\s*(?:=|:|→|\|)\s*[`\"']*({VALUE})"
)
# Generic prose such as "wrong token: 401" is not a credential assignment.
GENERIC_TOKEN = re.compile(
    r"(?i)\btoken[`\"'*]*\s*(?:=|:|→|\|)\s*[`\"']*"
    r"([A-Za-z0-9_][A-Za-z0-9_./+~=-]{15,})(?![A-Za-z0-9_./+~=-])"
)
BEARER = re.compile(
    rf"(?i)\bAuthorization[`\"']*\s*:\s*[`\"']*Bearer\s+[`\"']*({VALUE})"
)
PORT_MAPPING = re.compile(
    r"(?i)(?<![\d])\d{4,5}\s*(?:→|->|=>)\s*[`\"']*([0-9a-f]{32,})(?![0-9a-f])"
)


def credential_locations(rel, text):
    """Yield each suspect line once, without retaining its credential in output."""
    for number, line in enumerate(text.splitlines(), 1):
        if any(pattern.search(line) for pattern in (ASSIGNMENT, GENERIC_TOKEN, BEARER, PORT_MAPPING)):
            yield rel, number


def tracked_documentation():
    names = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True
    ).stdout.decode("utf-8").split("\0")
    for rel in filter(None, names):
        if rel.lower().endswith(".md") and not rel.startswith(SKIP_PREFIXES):
            yield rel, (ROOT / rel).read_text(encoding="utf-8")


class PublicDocumentationCredentialTests(unittest.TestCase):
    def test_literal_assignment_and_header_controls(self):
        # Synthetic values only; never embed the removed operational credential.
        value = "synthetic-" + "Ab09_+/=" * 4
        samples = [
            f'export STATA_BRIDGE_TOKEN="{value}"',
            f"$env:STATA_BRIDGE_TOKEN = '{value}'",
            f'"STATA_BRIDGE_TOKEN": "{value}"',
            f'bridge token: `{value}`',
            f'| token | `{value}` |',
            f'Authorization: Bearer {value}',
            f'authorization: bearer `{value}`',
            f'X-Stata-Workbench-Token: {value}',
            'STATA_BRIDGE_TOKEN=short',
            'Authorization: Bearer short',
        ]
        for number, sample in enumerate(samples):
            with self.subTest(case=number):
                self.assertEqual(list(credential_locations("sample.md", sample)),
                                 [("sample.md", 1)])

    def test_historical_port_mapping_shape(self):
        for width in (32, 58, 64):
            for arrow in ("→", "->", "=>"):
                with self.subTest(width=width, arrow=arrow):
                    text = f"## Bridge connection\n\n- 17486 {arrow} `{'a1' * (width // 2)}`"
                    self.assertEqual(list(credential_locations("sample.md", text)),
                                     [("sample.md", 3)])

    def test_environment_placeholders_and_hashes_are_allowed(self):
        text = '\n'.join([
            'STATA_BRIDGE_TOKEN="$STATA_BRIDGE_TOKEN"',
            'STATA_BRIDGE_TOKEN="${STATA_BRIDGE_TOKEN:-}"',
            '$env:STATA_BRIDGE_TOKEN = $env:SELECTED_SESSION_TOKEN',
            'Authorization: Bearer ${STATA_BRIDGE_TOKEN}',
            'Authorization: Bearer $env:STATA_BRIDGE_TOKEN',
            'Authorization: Bearer <token>',
            'X-Stata-Workbench-Token: <local-session-token>',
            '| token | <configured-locally> |',
            '- 17486 → <selected-session-token>',
            'Token must be obtained from the local installation.',
            '## Bridge bearer authentication',
            'wrong token: 401; wrong Host or any Origin: 403.',
            'Bundle SHA-256: `' + 'a1' * 32 + '`',
            '## Bridge authentication\nBundle hash: `' + 'b2' * 32 + '`',
        ])
        self.assertEqual(list(credential_locations("sample.md", text)), [])

    def test_findings_contain_only_locations(self):
        value = "b2" * 29
        text = f"STATA_BRIDGE_TOKEN={value}; Authorization: Bearer {value}\n- 17486 → `{value}`"
        findings = list(credential_locations("sample.md", text))
        self.assertEqual(findings, [("sample.md", 1), ("sample.md", 2)])
        self.assertNotIn(value, repr(findings))

    def test_current_public_markdown_has_no_literal_bridge_credentials(self):
        findings = [location for rel, text in tracked_documentation()
                    for location in credential_locations(rel, text)]
        self.assertEqual(findings, [], "literal bridge credential candidates (file, line only)")


if __name__ == "__main__":
    unittest.main()
