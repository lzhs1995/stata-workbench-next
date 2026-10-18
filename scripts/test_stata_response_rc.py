"""Execute frozen response decision blocks offline, without importing Stata.

Diagnostic parsers are explicit test doubles. Original decision source and
success expressions are unchanged. These tests do not exercise HTTP or Stata.
"""
import json
import re
import sys
import textwrap


class DiagnosticParsers:
    def __init__(self, forbidden=False):
        self.forbidden = forbidden
        self.calls = 0

    def _parse_rc_from_text(self, text):
        self.calls += 1
        assert not self.forbidden, "response decision must not parse diagnostic logs"
        match = re.search(r"(?<!\w)r\((\d+)\);?", text)
        return int(match.group(1)) if match else None

    _parse_rc_from_smcl = _parse_rc_from_text

    def _smcl_to_text(self, text):
        assert not self.forbidden, "response decision must not depend on log conversion"
        return re.sub(r"\{[^}]*\}", "", text)


def decision(block, candidate):
    body = block["candidate"] if candidate else block["source"]
    body += block["success"] + "        return rc, success\n"
    args = "self, rc, smcl_content, stdout, stderr, combined, " + block["errorVar"]
    source = f"def run({args}):\n" + textwrap.indent(textwrap.dedent(body), "    ")
    namespace = {"_STANDALONE_RC_RE": re.compile(r"(?<!\w)r\((\d+)\);?")}
    exec(compile(source, f"<{block['name']}:{candidate}>", "exec"), namespace)
    return namespace["run"]


def invoke(fn, rc, smcl="", stdout="", stderr="", error=None, forbidden=False):
    parsers = DiagnosticParsers(forbidden)
    result = fn(parsers, rc, smcl, stdout, stderr, stdout + stderr, error)
    if forbidden:
        assert parsers.calls == 0
    return result


cases = []
negative_controls = []
blocks = json.load(sys.stdin)["blocks"]
for block in blocks:
    new = decision(block, True)
    old = decision(block, False)
    name = block["name"]
    # Logs can be empty, truncated, stale, or ordinary user output. None is RC.
    for label, smcl, stdout, stderr in [
        ("empty", "", "", ""),
        ("partial-smcl", "{txt}partial output", "", ""),
        ("stdout-only", "", "partial output", ""),
        ("stderr-only", "", "", "partial stderr"),
        ("printed-r0", "r(0);", "r(0);", ""),
        ("printed-r111", "{err}r(111);", "r(111);", ""),
        ("conflicting-rcs", "r(0);\nr(459);", "r(111);", "r(9);"),
    ]:
        for rc in (0, 1, 459, 601):
            assert invoke(new, rc, smcl, stdout, stderr, forbidden=True) == (rc, rc == 0)
            cases.append(f"{name}:{label}:rc={rc}")
    for label, value in [
        ("unknown", -1), ("negative", -9), ("absent", None),
        ("false", False), ("true", True), ("string-zero", "0"),
        ("float-zero", 0.0), ("float-nonzero", 459.0),
        ("nan", float("nan")), ("infinity", float("inf")),
    ]:
        assert invoke(new, value, "r(0);", forbidden=True) == (1, False)
        cases.append(f"{name}:invalid:{label}")
    for rc in (0, 459, -1):
        # Empty strings and false-y exception objects still count as an error.
        for error in (RuntimeError("worker failed"), "", False):
            assert invoke(new, rc, "r(0);", error=error, forbidden=True) == (459 if rc == 459 else 1, False)
            cases.append(f"{name}:exception:rc={rc}:{type(error).__name__}")

    for label, rc, smcl, stdout in [
        ("missing-error-markers", 459, "{txt}partial output", ""),
        ("printed-zero-overrides-error", 459, "r(0);", ""),
        ("printed-error-overrides-real-code", 459, "r(111);", ""),
    ]:
        old_result = invoke(old, rc, smcl, stdout)
        assert old_result != (rc, False), (name, label, old_result)
        assert invoke(new, rc, smcl, stdout, forbidden=True) == (rc, False)
        negative_controls.append({"method": name, "case": label, "old": old_result, "candidate": [rc, False]})
    if name != "_exec_with_capture":
        assert invoke(old, -1) == (0, True)
        assert invoke(new, -1, forbidden=True) == (1, False)
        negative_controls.append({"method": name, "case": "unset-with-empty-log", "old": [0, True], "candidate": [1, False]})
    else:
        assert invoke(old, 459, stdout="partial output") == (0, True)
        assert invoke(new, 459, stdout="partial output", forbidden=True) == (459, False)
        negative_controls.append({"method": name, "case": "stdout-without-error-marker", "old": [0, True], "candidate": [459, False]})

print(json.dumps({"verdict": "PASS", "scope": "offline-response-decisions", "nativeVerified": False,
                  "candidateCases": len(cases), "negativeControls": negative_controls}))
