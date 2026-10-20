"""Run actual frozen methods with an explicit protocol double, never native Stata.

Checks Python locking, read validation, dispatch, cleanup and exception decisions.
The double's _return/trace/RC model is an assumption pending native acceptance.
"""
from contextlib import contextmanager
from io import StringIO
import json
import re
import sys
from types import SimpleNamespace
import uuid


sources = json.load(sys.stdin)


def client(source):
    namespace = dict(StringIO=StringIO, uuid=uuid, CommandResponse=SimpleNamespace)
    exec(compile("from __future__ import annotations\n" + source + sources["reader"],
                 "<silent-state-fixture>", "exec"), namespace)
    return namespace["Client"]


class Lock:
    def __init__(self, model):
        self.model, self.owned = model, False

    def __enter__(self):
        assert not self.owned
        self.owned = True
        if self.model.fail == "lock-race":
            self.model.rc = 97  # A previous owner completed before this lock.
        return self

    def __exit__(self, *_):
        self.owned = False


DEFAULT = object()


class Model:
    def __init__(self, implementation, *, rc=42, trace="off", fail=None, result=DEFAULT):
        self.implementation, self.rc, self.trace = implementation, rc, trace
        self.fail, self.result = fail, result
        self.r = {"mean": 17, "text": "原始结果"}
        self.initial_r = dict(self.r)
        self.scalars, self.holders = {"_mcp_rc": 1234}, {}
        self.reads, self.calls, self.dispatched = [], [], 0
        self._last_results, self.stata, self._exec_lock = object(), self, Lock(self)
        self._get_rc_from_scalar = implementation._get_rc_from_scalar.__get__(self)
        self._get_preserved_rc = implementation._get_preserved_rc.__get__(self)
        sys.modules["sfi"] = SimpleNamespace(Scalar=self, Macro=self)

    @contextmanager
    def _redirect_io(self, *_):
        yield

    def _parse_rc_from_text(self, text):
        m = re.search(r"r\((\d+)\)", text)
        return int(m[1]) if m else None

    def getValue(self, name):
        self.reads.append((name, self._exec_lock.owned))
        if name == "c(rc)":
            if self.fail == "entry-read":
                raise RuntimeError("entry read failed")
            return self.rc
        if self.fail == "result-read":
            raise RuntimeError("result read failed")
        if self.result is not DEFAULT:
            return self.result
        return self.scalars.get(name)

    def getGlobal(self, name):
        assert name == "c(trace)"
        self.reads.append((name, self._exec_lock.owned))
        return "unknown" if self.fail == "trace-read" else self.trace

    def getLocal(self, name):
        assert name == "mcp_rc"
        return ""  # PyStata local does not survive this separate call.

    def _run_internal(self, code, **kwargs):
        return self.run(code, **kwargs)

    def run(self, code, **kwargs):
        assert self._exec_lock.owned
        self.calls.append(code)
        captured_payload = "capture quietly" in code
        for raw in code.splitlines():
            line = raw.strip()
            if not line or line in ("nobreak {", "capture quietly {", "}"):
                continue
            if "PAYLOAD" in line:
                self.dispatched += 1
                self.r, self.rc = {"internal": "mutation"}, 459 if "FAIL" in line else 0
                if "INTERRUPT" in line:
                    raise KeyboardInterrupt("payload interrupt")
                if "RAISE" in line:
                    self.rc = 498
                    raise RuntimeError("payload r(498)")
                assert captured_payload
            elif "_return hold " in line:
                if self.fail == "hold":
                    self.rc = 498
                    if line.startswith("capture "):
                        continue
                    raise RuntimeError("hold failed")
                self.holders[line.split()[-1]] = dict(self.r)
                self.r, self.rc = {}, 0
            elif "_return restore " in line:
                if self.fail == "restore":
                    self.rc = 498
                    if line.startswith("capture "):
                        continue
                    raise RuntimeError("restore failed")
                name = line.split()[-1]
                if name in self.holders:
                    self.r = self.holders.pop(name)
                self.rc = 0
            elif line.startswith("scalar drop "):
                if self.fail == "drop":
                    raise RuntimeError("drop failed")
                del self.scalars[line.split()[-1]]
                self.rc = 0
            elif line.startswith("scalar "):
                _, name, _, value = line.split()
                if value == "." and self.fail == "create":
                    raise RuntimeError("create failed")
                self.scalars[name] = float("nan") if value == "." else self.rc
                self.rc = 0
            elif line.startswith("set trace "):
                value = line.split()[-1]
                if self.fail == "trace-on" and value == "on":
                    raise RuntimeError("trace on failed")
                if self.fail == "trace-restore" and value == "off":
                    raise RuntimeError("trace restore failed")
                self.trace, self.rc = value, 0
            elif line.startswith("capture error "):
                if self.fail == "rc-restore":
                    raise RuntimeError("rc restore failed")
                self.rc = int(line.split()[-1])
            elif line == "local mcp_rc = _rc":
                self.rc = 0
            else:
                raise AssertionError("Unmodelled command: " + line)

    def invoke(self, code="PAYLOAD", trace=False):
        sys.modules["sfi"] = SimpleNamespace(Scalar=self, Macro=self)
        return self.implementation._exec_no_capture_silent(self, code, trace=trace)


new, old = client(sources["candidate"]), client(sources["original"])
cases, negative_controls = [], []
for entry_rc in (0, 42, 2147483647):
    for trace in ("off", "on"):
        for command in ("PAYLOAD", "PAYLOAD\nPAYLOAD", "PAYLOAD FAIL", "PAYLOAD RAISE"):
            m = Model(new, rc=entry_rc, trace=trace)
            res = m.invoke(command, trace=True)
            expected = 498 if "RAISE" in command else 459 if "FAIL" in command else 0
            assert res.rc == expected and res.success == (expected == 0), vars(res)
            assert m.r == m.initial_r and m.rc == entry_rc and m.trace == trace
            assert m.scalars == {"_mcp_rc": 1234} and not m.holders
            assert all(owned for _, owned in m.reads) and not m._exec_lock.owned
            assert m._last_results is None
            cases.append(f"normal:{entry_rc}:{trace}:{command}")

for fail in ("entry-read", "trace-read", "hold", "create", "trace-on"):
    m = Model(new, fail=fail)
    res = m.invoke(trace=True)
    assert not res.success and res.rc != 0 and m.dispatched == 0 and res.stderr
    assert m.r == m.initial_r and m.trace == "off" and m.rc == 42
    assert not m.holders and m.scalars == {"_mcp_rc": 1234}
    if fail.endswith("read"):
        assert m.calls == []
    cases.append("zero-dispatch:" + fail)

invalid = [None, False, True, "0", "", 0.5, -1, float("nan"), float("inf"), 2147483648]
for i, value in enumerate(invalid):
    m = Model(new, rc=value)
    assert not m.invoke().success and m.calls == []
    cases.append(f"invalid-entry:{i}")
    m = Model(new, result=value)
    assert not m.invoke().success and m.dispatched == 1
    assert m.r == m.initial_r and m.rc == 42 and not m.holders
    assert m.scalars == {"_mcp_rc": 1234}
    cases.append(f"invalid-result:{i}")

for fail in ("result-read", "drop", "trace-restore", "restore", "rc-restore"):
    m = Model(new, fail=fail)
    res = m.invoke(trace=True)
    assert not res.success and res.rc != 0 and res.stderr and m.dispatched == 1
    # Continue later cleanup even if an earlier cleanup operation failed.
    if fail != "restore":
        assert m.r == m.initial_r
    if fail != "rc-restore":
        assert m.rc == 42
    cases.append("reported-failure:" + fail)

for fail in (None, "drop"):
    m = Model(new, fail=fail)
    try:
        m.invoke("PAYLOAD INTERRUPT", trace=True)
    except KeyboardInterrupt as error:
        assert m.r == m.initial_r and m.rc == 42 and m.trace == "off"
        assert not m._exec_lock.owned and not m.holders
        if fail:
            assert "drop failed" in str(error.__notes__)
    else:
        raise AssertionError("interruption swallowed")
    cases.append("interruption:" + str(fail))

for result in (0.0, 459.0, 2147483647.0):
    m = Model(new, result=result)
    res = m.invoke()
    assert type(res.rc) is int and res.rc == int(result)
    cases.append("integer-float:" + str(result))

m = Model(new)
m.invoke(); m.invoke()
assert len({c for c in m.calls if "_return hold " in c}) == 2
cases.append("invocation-owned-names")

for label, kwargs, command, traced in [
    ("local-rc-loss", {}, "PAYLOAD FAIL", False),
    ("lock-race", {"fail": "lock-race"}, "PAYLOAD", False),
    ("trace-forced-off", {"trace": "on"}, "PAYLOAD", True),
    ("hold-error-hidden", {"fail": "hold"}, "PAYLOAD", False),
    ("restore-error-hidden", {"fail": "restore"}, "PAYLOAD", False),
    ("entry-unknown-success", {"rc": None}, "PAYLOAD", False),
]:
    a, b = Model(old, **kwargs), Model(new, **kwargs)
    ra, rb = a.invoke(command, trace=traced), b.invoke(command, trace=traced)
    if label == "lock-race":
        assert a.rc == 42 and b.rc == 97
        assert a.reads[0][1] is False and b.reads[0][1] is True
    elif label == "trace-forced-off":
        assert a.trace == "off" and b.trace == "on"
    else:
        assert ra.success and not rb.success
    negative_controls.append(label)

print(json.dumps(dict(verdict="PASS", nativeVerified=False, scope="offline-silent-state",
                      candidateCases=len(cases), cases=cases, negativeControls=negative_controls)))
