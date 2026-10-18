"""Execute extracted worker methods against a stateful protocol double, never Stata.

The negative control uses the frozen original method. These tests prove Python
control flow and failure handling, not native Stata command semantics.
"""
import ast
from contextlib import contextmanager
import io
import json
import logging
import os
import re
import sys
import tempfile
import threading
import types
import uuid


sources = json.load(sys.stdin)


def worker(source):
    tree = ast.parse("class Worker:\n" + source)
    scope = dict(io=io, os=os, uuid=uuid, logger=logging.getLogger("test"))
    exec(compile("from __future__ import annotations\nclass Worker:\n" + source,
                 "isolated-worker", "exec"), scope)
    assert len(tree.body[0].body) == 1
    return scope["Worker"]._run_streaming_blocking


class Model:
    def __init__(self, method, *, more="on", trace="off", fail=None):
        self.method, self.fail = method, fail
        self.r = {"mean": 17, "names": "原始结果"}
        self.initial_r = dict(self.r)
        self.more, self.trace, self.rc = more, trace, 42
        self.holders, self.scalars = {}, {"_mcp_rc": 12345}
        self.calls, self.seen = [], []
        self.stata = self
        self._exec_lock = threading.RLock()
        self._persistent_log_path = self._persistent_log_name = None
        self._last_results = object()
        self.expected_cwd = os.getcwd()
        sys.modules["sfi"] = types.SimpleNamespace(Scalar=self, Macro=self, SFIToolkit=object())

    def getGlobal(self, name):
        if self.fail == "state_read":
            return "unknown"
        return {"c(more)": self.more, "c(trace)": self.trace}[name]

    def getValue(self, name):
        if self.fail == "result_read" and self.seen:
            raise RuntimeError("SFI read failed")
        return self.rc if name == "c(rc)" else self.scalars.get(name)

    @contextmanager
    def _temp_cwd(self, cwd):
        previous = os.getcwd()
        if cwd:
            os.chdir(cwd)
        try:
            yield
        finally:
            os.chdir(previous)

    @contextmanager
    def _redirect_io_streaming(self, *_):
        yield

    def _parse_rc_from_text(self, text):
        match = re.search(r"r\((\d+)\)", text)
        return int(match[1]) if match else None

    def _open_smcl_log(self, *_, **__):
        self.calls.append("OPEN_LOG")
        self.r, self.rc = {"log": "maintenance"}, 0
        if self.fail == "log_raise":
            raise RuntimeError("open failed")
        return self.fail != "log_false"

    def _close_smcl_log(self, _):
        self.calls.append("CLOSE_LOG")
        self.r = {"cleanup": True}

    def _restore_results_from_hold(self, attr):
        if hasattr(self, attr):
            self.run("capture _return restore " + getattr(self, attr))
            delattr(self, attr)

    def _run_internal(self, code, **kwargs):
        return self.run(code, **kwargs)

    def run(self, code, **kwargs):
        self.calls.append(code)
        captured = code.startswith("capture noisily {")
        for raw in code.splitlines():
            line = raw.strip()
            if not line or line in ("nobreak {", "capture noisily {", "noisily {", "}"):
                continue
            if line.startswith("USER"):
                self.seen.append((dict(self.r), self.more, self.trace, self.rc, os.getcwd()))
                if "KEEP" not in line:
                    self.r = {"N": 73, "names": "用户结果"}
                self.rc = 459 if "FAIL" in line else 1 if "BREAK" in line else 0
                if "BREAK" in line:
                    raise KeyboardInterrupt("interrupt")
                if "FAIL" in line and not captured:
                    raise RuntimeError("r(459)")
            elif "_return hold " in line:
                name = line.split()[-1]
                if self.fail == "entry_hold" and name.startswith("_wb_in_"):
                    raise RuntimeError("entry hold failed")
                self.holders[name] = dict(self.r)
                self.r, self.rc = {}, 0
            elif "_return restore " in line:
                name = line.split()[-1]
                if self.fail == "entry_restore" and name.startswith("_wb_in_") and "OPEN_LOG" in self.calls:
                    raise RuntimeError("entry restore failed")
                if self.fail == "result_restore" and name.startswith("_wb_out_"):
                    raise RuntimeError("result restore failed")
                self.r = self.holders.pop(name)
                self.rc = 0
            elif line.startswith("set more "):
                value = line.split()[-1]
                if self.fail == "more_off" and value == "off":
                    raise RuntimeError("set more failed")
                if self.fail == "more_restore" and value == "on":
                    raise RuntimeError("restore more failed")
                self.more, self.rc = value, 0
            elif line.startswith("set trace "):
                self.trace, self.rc = line.split()[-1], 0
            elif "scalar drop " in line:
                self.scalars.pop(line.split()[-1], None)
                self.rc = 0
            elif line.startswith("scalar "):
                _, name, _, value = line.split()
                self.scalars[name] = self.rc if value in ("_rc", "c(rc)") else int(value)
                self.rc = 0
            elif "log flush" in line or "log close" in line:
                self.r, self.rc = {"cleanup": True}, 0
            elif line.startswith("capture error "):
                self.rc = int(line.split()[-1])
            elif line == "capture":
                self.rc = 0
            else:
                raise AssertionError("Unmodelled statement: " + line)

    def invoke(self, command="USER", trace=False, cwd=None):
        return self.method(self, command=command, tee=io.StringIO(), cwd=cwd,
                           trace=trace, echo=True, smcl_path="/tmp/test.smcl",
                           smcl_log_name="_test_log", hold_attr="_hold_name_stream",
                           require_smcl_log=True)


new, old = worker(sources["candidate"]), worker(sources["original"])
cases = []
for more in ("on", "off"):
    for command in ("USER", "USER\n// ignored", "USER KEEP", "USER FAIL"):
        # Use a blank line to exercise the multiline bundle without modelling
        # Stata's comment parser.
        command = command.replace("// ignored", " ")
        if "\n" in command:
            command = "USER\n\nUSER KEEP"
        m = Model(new, more=more)
        rc, exc = m.invoke(command)
        assert m.seen[0][:4] == (m.initial_r, "off", "off", 42), m.seen
        assert m.more == more and m.r == (m.initial_r if command == "USER KEEP" else {"N": 73, "names": "用户结果"})
        assert m.scalars == {"_mcp_rc": 12345} and not m.holders
        assert not m._is_executing and m._last_results is None
        assert (rc == 459 and exc is not None) if "FAIL" in command else (rc == 0 and exc is None)
        cases.append("normal:" + more + ":" + repr(command))

for failure in ("state_read", "entry_hold", "more_off", "log_false", "log_raise", "entry_restore"):
    m = Model(new, fail=failure)
    rc, exc = m.invoke()
    assert not m.seen and rc != 0 and exc is not None
    assert not m._is_executing
    if failure not in ("entry_restore",):
        assert m.r == m.initial_r and not m.holders
    assert m.more == "on"
    cases.append("zero-dispatch:" + failure)

for failure in ("more_restore", "result_restore", "result_read"):
    m = Model(new, fail=failure)
    rc, exc = m.invoke()
    assert len(m.seen) == 1 and rc != 0 and exc is not None
    assert not m._is_executing
    if failure != "result_restore":
        assert m.r == {"N": 73, "names": "用户结果"}
    cases.append("failure-reported:" + failure)

for trace in ("on", "off"):
    m = Model(new, trace=trace)
    rc, exc = m.invoke(trace=True)
    assert m.trace == trace and m.seen[0][2] == "on" and rc == 0 and exc is None
    cases.append("trace:" + trace)

m = Model(new)
with tempfile.TemporaryDirectory(prefix="worker-cwd-") as cwd:
    prior = os.getcwd()
    rc, exc = m.invoke(cwd=cwd)
    assert os.getcwd() == prior and os.path.realpath(m.seen[0][4]) == os.path.realpath(cwd)
    assert rc == 0 and exc is None
cases.append("cwd-finally")

m = Model(new)
try:
    m.invoke("USER BREAK", trace=True)
    raise AssertionError("KeyboardInterrupt was swallowed")
except KeyboardInterrupt:
    assert m.more == "on" and m.trace == "off" and not m._is_executing
    assert m.r == {"N": 73, "names": "用户结果"} and not m.holders
    assert m.rc == 1
cases.append("python-interruption-finally")

m = Model(old)
m.invoke()
assert m.seen[0][0] != m.initial_r and m.scalars["_mcp_rc"] != 12345
cases.append("legacy-negative-control")
print(json.dumps(dict(verdict="PASS", cases=cases, nativeVerified=False), ensure_ascii=False))
