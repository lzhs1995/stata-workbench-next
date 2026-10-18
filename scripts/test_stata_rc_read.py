"""Execute pinned original/candidate RC readers with SFI doubles, no Stata import.

The Stata double records the original fallback's global mutation. Candidate
scenarios must leave this state unchanged and execute zero Stata commands.
"""
import builtins
import json
import sys
import textwrap
from types import SimpleNamespace


class Runtime:
    def __init__(self, value=None, error=None, macro_value="0"):
        self.value = value
        self.error = error
        self.macro_value = macro_value
        self.commands = []
        self.reads = []
        self.globals = {"_mcp_last_rc": "user-owned"}
        self.stata = SimpleNamespace(run=self.run)

    def getValue(self, name):
        self.reads.append(name)
        if self.error:
            raise self.error
        return self.value

    def run(self, code, **kwargs):
        self.commands.append(code)
        assert code == "global _mcp_last_rc = _rc"
        self.globals["_mcp_last_rc"] = self.macro_value

    def getGlobal(self, name):
        return self.globals[name]


def execute(source, runtime, injected=False, import_failure=False):
    def import_sfi(name, *args, **kwargs):
        assert name == "sfi", name
        if import_failure:
            raise ImportError("SFI unavailable")
        return SimpleNamespace(Scalar=runtime, Macro=runtime)
    namespace = {"__builtins__": dict(vars(builtins), __import__=import_sfi)}
    exec(compile(textwrap.dedent(source), "<frozen-rc-reader>", "exec"), namespace)
    fn = namespace["_get_rc_from_scalar"]
    return fn(runtime, runtime if injected else None)


sources = json.load(sys.stdin)
cases = []
values = [
    ("zero-int", 0, 0), ("zero-float", 0.0, 0), ("negative-zero", -0.0, 0),
    ("nonzero-int", 459, 459), ("nonzero-float", 459.0, 459),
    ("max-int", 2147483647, 2147483647), ("max-float", 2147483647.0, 2147483647),
    ("none", None, -1), ("false", False, -1), ("true", True, -1),
    ("empty-string", "", -1), ("numeric-string", "0", -1),
    ("numeric-bytes", b"0", -1), ("fraction-zero", 0.5, -1),
    ("fraction-error", 459.5, -1), ("negative-int", -1, -1),
    ("negative-float", -0.5, -1), ("nan", float("nan"), -1),
    ("inf", float("inf"), -1), ("negative-inf", float("-inf"), -1),
    ("out-of-range-int", 2147483648, -1), ("out-of-range-float", 2147483648.0, -1),
    ("huge-int", 10**100, -1), ("list", [], -1), ("dict", {}, -1),
    ("int-subclass", type("IntValue", (int,), {})(0), -1),
    ("float-subclass", type("FloatValue", (float,), {})(0.0), -1),
]
for injected in (False, True):
    for label, value, expected in values:
        runtime = Runtime(value)
        result = execute(sources["candidate"], runtime, injected)
        assert type(result) is int and result == expected, (label, result)
        assert runtime.reads == ["c(rc)"]
        assert runtime.commands == []
        assert runtime.globals == {"_mcp_last_rc": "user-owned"}
        cases.append(f"{label}:injected={injected}")
    runtime = Runtime(error=RuntimeError("read failed"))
    assert execute(sources["candidate"], runtime, injected) == -1
    assert runtime.commands == []
    assert runtime.globals == {"_mcp_last_rc": "user-owned"}
    cases.append(f"read-error:injected={injected}")

runtime = Runtime()
assert execute(sources["candidate"], runtime, import_failure=True) == -1
assert runtime.reads == runtime.commands == []
cases.append("import-error")

# A caller interruption must propagate, while still never executing fallback.
runtime = Runtime(error=KeyboardInterrupt())
try:
    execute(sources["candidate"], runtime)
except KeyboardInterrupt:
    pass
else:
    raise AssertionError("interruption swallowed")
assert runtime.commands == []
cases.append("interruption")

negative_controls = []
for label, kwargs, old_expected in [
    ("none-is-success", {"value": None}, 0),
    ("fraction-truncated", {"value": 0.5}, 0),
    ("read-error-writes-global", {"error": RuntimeError("read failed")}, 0),
    ("missing-macro-is-success", {"error": RuntimeError("read failed"), "macro_value": ""}, 0),
]:
    old, new = Runtime(**kwargs), Runtime(**kwargs)
    assert execute(sources["original"], old) == old_expected
    assert execute(sources["candidate"], new) == -1
    if kwargs.get("error"):
        assert len(old.commands) == 1
        assert old.globals["_mcp_last_rc"] != "user-owned"
    assert new.commands == []
    assert new.globals == {"_mcp_last_rc": "user-owned"}
    negative_controls.append({"case": label, "old": old_expected, "candidate": -1,
                              "oldStataCommands": len(old.commands)})

print(json.dumps({"verdict": "PASS", "scope": "offline-rc-reader", "nativeVerified": False,
                  "candidateCases": len(cases), "negativeControls": negative_controls}))
