"""Execute real helper source against a log/scalar protocol model, never Stata."""
import json
import logging
import re
import sys
import types
import uuid

sources = json.load(sys.stdin)


def methods(source):
    scope = dict(re=re, uuid=uuid, logger=logging.getLogger("log-test"))
    exec(compile("from __future__ import annotations\nclass Helpers:\n" + source,
                 "isolated-smcl-helpers", "exec"), scope)
    return scope["Helpers"]


class Model:
    def __init__(self, helpers, failure=None):
        self.helpers, self.failure = helpers, failure
        self.logs = {"": "user.log", "user_named": "named.log"}
        self.scalars, self.calls, self.opens, self.rc = {}, [], 0, 0
        self._last_smcl_log_named = False
        sys.modules["sfi"] = types.SimpleNamespace(Scalar=self)

    def getValue(self, name):
        if self.failure == "read":
            raise RuntimeError("SFI failed")
        return None if self.failure == "missing_scalar" else self.scalars[name]

    def _run_internal(self, code, **_):
        self.calls.append(code)
        for line in map(str.strip, code.splitlines()):
            if not line or line in ("nobreak {", "}"):
                continue
            if "log close" in line:
                self.logs.pop(line.split("log close", 1)[1].strip(), None)
                self.rc = 0
            elif "log using" in line:
                self.opens += 1
                if self.failure == "run":
                    raise RuntimeError("transport failed")
                if self.failure == "break":
                    raise KeyboardInterrupt("interrupted")
                self.rc = 603 if self.failure == "open" else 0
                if self.rc == 0:
                    name = re.search(r"name\((\w+)\)", line).group(1)
                    self.logs[name] = "internal.smcl"
            elif line.startswith("scalar "):
                self.scalars[line.split()[1]] = self.rc
                self.rc = 0
            elif "scalar drop " in line:
                if self.failure == "cleanup":
                    raise RuntimeError("cleanup failed")
                self.scalars.pop(line.split()[-1], None)
            else:
                raise AssertionError("Unmodelled command: " + line)

    def open(self, path="/tmp/日志 space.smcl", name="_owned", **kwargs):
        return self.helpers._open_smcl_log(self, path, name, **kwargs)

    def close(self, name="_owned"):
        self.helpers._close_smcl_log(self, name)


old, new = methods(sources["original"]), methods(sources["candidate"])
cases = []
legacy = Model(old, "open")
assert legacy.open() is False and "" not in legacy.logs and legacy.opens == 2
legacy_close = Model(old)
legacy_close.close()
assert "" not in legacy_close.logs

for failure in (None, "open", "read", "missing_scalar", "run", "cleanup", "break"):
    m = Model(new, failure)
    if failure == "break":
        try:
            m.open()
            raise AssertionError("interruption swallowed")
        except KeyboardInterrupt:
            pass
    else:
        assert m.open() is (failure is None)
    assert m.logs[""] == "user.log" and m.logs["user_named"] == "named.log"
    assert m.opens == 1
    if failure != "cleanup":
        assert not m.scalars
    m.failure = None
    m.close()
    assert m.logs == {"": "user.log", "user_named": "named.log"}
    cases.append("named-only:" + str(failure))

for append in (False, True):
    m = Model(new)
    assert m.open(append=append, quiet=True)
    assert (", append smcl" if append else ", replace smcl") in m.calls[0]
    m._last_smcl_log_named = False
    m.close()
    assert "" in m.logs and "_owned" not in m.logs
    cases.append("mode:" + str(append))

m = Model(new)
m.close("_mcp_session")
assert not m.calls
cases.append("persistent-log-retained")
for name in ("", "_all", "bad name", "x\nlog close", "a" * 33):
    # _all is a syntactically valid Stata name but a dangerous log selector.
    m = Model(new)
    try:
        m.open(name=name)
        raise AssertionError("unsafe log name accepted: " + name)
    except ValueError:
        pass
    try:
        m.close(name)
        raise AssertionError("unsafe close selector accepted: " + name)
    except ValueError:
        pass
    assert not m.calls
    cases.append("invalid-name:" + repr(name))
for path in ('/tmp/a"b', "/tmp/a\nb", "/tmp/$global", "/tmp/`local'"):
    m = Model(new)
    try:
        m.open(path=path)
        raise AssertionError("unsafe path accepted")
    except ValueError:
        pass
    assert not m.calls
    cases.append("invalid-path:" + repr(path))
print(json.dumps(dict(verdict="PASS", nativeVerified=False, cases=cases,
                      negativeControls=["legacy-failed-open-closes-user-log", "legacy-stale-flag-closes-user-log"])))
