"""Execute real original/candidate methods with an offline Stata protocol double.

The double deliberately models maintenance overwriting r()/RC. This proves
ordering and failure decisions, not native _return, nobreak or full session state.
"""
from contextlib import contextmanager
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
import json
import os
import re
import sys
import tempfile
import uuid

sources = json.load(sys.stdin)


def client(source):
    namespace = dict(StringIO=StringIO, uuid=uuid, os=os, re=re,
                     CommandResponse=SimpleNamespace, ErrorEnvelope=SimpleNamespace,
                     _STANDALONE_RC_RE=re.compile(r"r\((\d+)\)"))
    exec(compile("from __future__ import annotations\nclass Client:\n" + source + sources["reader"],
                 "<capture-state-fixture>", "exec"), namespace)
    return namespace["Client"]


class Lock:
    def __init__(self, model):
        self.model, self.owned = model, False

    def __enter__(self):
        assert not self.owned
        self.owned = True
        if self.model.fail == "lock-race":
            self.model.rc = 97
        return self

    def __exit__(self, *_):
        self.owned = False


class Model:
    def __init__(self, impl, root, *, persistent=False, rc=42, more="on", trace="off", fail=None, empty=False):
        self.impl, self.root, self.rc, self.more, self.trace = impl, root, rc, more, trace
        self.fail, self.empty, self.fired = fail, empty, set()
        self.r = {"mean": 17, "text": "用户结果"}
        self.initial_r = dict(self.r)
        self.holders, self.calls, self.reads, self.payload_entries = {}, [], [], []
        self.dispatched = 0
        self._initialized, self._is_executing = True, False
        self._last_results, self.stata, self._exec_lock = object(), self, Lock(self)
        self._persistent_log_path = str(root / "persistent.smcl") if persistent else None
        self._persistent_log_name = "_mcp_session" if persistent else None
        if persistent:
            Path(self._persistent_log_path).write_text("header")
        self._get_rc_from_scalar = impl._get_rc_from_scalar.__get__(self)
        self.cwd = "original"
        self._hold_name = "foreign_stale_holder"

    def fault(self, label):
        if self.fail == label and label not in self.fired:
            self.fired.add(label)
            if "interrupt" in label:
                raise KeyboardInterrupt(label)
            raise RuntimeError(label + " failed")

    @contextmanager
    def _redirect_io(self, *_):
        yield

    @contextmanager
    def _temp_cwd(self, cwd):
        before = self.cwd
        self.cwd = cwd or before
        try:
            yield
        finally:
            self.cwd = before
            self.fault("cwd-exit")

    def getValue(self, name):
        assert name == "c(rc)"
        self.reads.append((name, self._exec_lock.owned))
        self.fault("result-read" if self.dispatched else "entry-read")
        self.fault("result-read-interrupt" if self.dispatched else "entry-read-interrupt")
        return None if self.fail == "result-unknown" and self.dispatched else self.rc

    def getGlobal(self, name):
        self.reads.append((name, self._exec_lock.owned))
        self.fault("more-read" if name == "c(more)" else "trace-read")
        return self.more if name == "c(more)" else self.trace

    def _get_preserved_rc(self):
        return self.rc

    def _increment_command_idx(self):
        pass

    def _maybe_rewrite_graph_name_in_command(self, code):
        self.fault("rewrite")
        return code

    def _invalidate_macro_cache_if_needed(self, code):
        self.fault("invalidate")

    def _create_smcl_log_path(self, **_):
        self.fault("path")
        return str(self.root / (uuid.uuid4().hex + ".smcl"))

    def _make_smcl_log_name(self):
        return "_all" if self.fail == "log-name" else "mcp_" + uuid.uuid4().hex[:12]

    def _open_smcl_log(self, path, name, **_):
        self.calls.append(("open", self._exec_lock.owned))
        self.r, self.rc = {"maintenance": "open"}, 0
        self.fault("open-raise")
        return self.fail != "open-false"

    def _close_smcl_log(self, name):
        self.run("quietly log close " + name)

    def _read_persistent_log_chunk(self, start):
        return self._read_smcl_file("persistent")

    def _read_smcl_file(self, path):
        self.calls.append(("read-output", self._exec_lock.owned))
        self.fault("output-read")
        return "" if self.empty else "user output"

    def _safe_unlink(self, path):
        self.fault("unlink")

    def _maybe_reload_startup_after_command(self, code):
        self.calls.append(("startup", self._exec_lock.owned))
        self.r, self.rc = {"maintenance": "startup"}, 0
        self.fault("startup")

    def _clean_internal_smcl(self, text):
        return text

    def _smcl_to_text(self, text):
        return text

    def _parse_rc_from_text(self, text):
        match = re.search(r"r\((\d+)\)", text)
        return int(match[1]) if match else None

    def _extract_error_and_context(self, text, rc):
        return f"Stata error r({rc})", text

    _extract_error_from_smcl = _extract_error_and_context

    def _run_internal(self, code, **kwargs):
        self.run(code, **kwargs)

    def run(self, code, **_):
        self.calls.append((code, self._exec_lock.owned))
        for line in map(str.strip, code.splitlines()):
            if not line or line in ("nobreak {", "}"):
                continue
            if line.startswith("PAYLOAD"):
                self.dispatched += 1
                self.payload_entries.append((dict(self.r), self.rc, self.more, self.trace, self.cwd))
                if "KEEP" not in line:
                    self.r = {"user": "partial" if "FAIL" in line or "RAISE" in line else "done"}
                self.rc = 459 if "FAIL" in line or "RAISE" in line else 0
                if "RAISE" in line:
                    raise RuntimeError("payload text r(999) disagrees with execution")
                if "INTERRUPT" in line:
                    self.rc = 1
                    raise KeyboardInterrupt("payload interrupt")
            elif "_return hold " in line:
                name = line.split()[-1]
                self.fault("hold-result" if self.dispatched else "hold-entry")
                self.holders[name] = dict(self.r)
                self.r, self.rc = {}, 0
            elif "_return restore " in line:
                name = line.split()[-1]
                self.fault("restore-result" if self.dispatched else "restore-entry")
                if name not in self.holders:
                    raise RuntimeError("missing holder " + name)
                self.r, self.rc = self.holders.pop(name), 0
            elif line.startswith("set more "):
                self.fault("more-restore" if self.dispatched else "more-off")
                self.more, self.rc = line.split()[-1], 0
            elif line.startswith("set trace "):
                self.fault("trace-restore" if self.dispatched else "trace-on")
                self.trace, self.rc = line.split()[-1], 0
            elif "log " in line:
                if "flush " in line:
                    label = "postflush" if self.dispatched else "preflush"
                    self.fault(label)
                    self.fault("cleanup-interrupt" if self.dispatched else "unused")
                if "close " in line and self.dispatched:
                    self.fault("close")
                self.r, self.rc = {"maintenance": "log"}, 0
            elif line.startswith("capture error "):
                self.fault("exit-rc" if self.dispatched else "input-rc")
                self.rc = int(line.split()[-1])
            else:
                raise AssertionError("unmodelled command: " + line)

    def invoke(self, code="PAYLOAD", *, trace=True, cwd=None):
        sys.modules["sfi"] = SimpleNamespace(Scalar=self, Macro=self)
        getsize = os.path.getsize
        def read_size(path):
            self.fault("size")
            return getsize(path)
        os.path.getsize = read_size
        try:
            return self.impl._exec_with_capture(self, code, trace=trace, cwd=cwd)
        finally:
            os.path.getsize = getsize


new, old = client(sources["candidate"]), client(sources["original"])
cases, negatives = [], []
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    for persistent in (False, True):
        for more, traced in (("on", "off"), ("off", "on")):
            for command in ("PAYLOAD", "PAYLOAD KEEP", "PAYLOAD FAIL", "PAYLOAD RAISE"):
                for entry_rc in (0, 42):
                    m = Model(new, root, persistent=persistent, more=more, trace=traced, rc=entry_rc)
                    out = m.invoke(command)
                    expected_rc = 459 if "FAIL" in command or "RAISE" in command else 0
                    expected_r = m.initial_r if "KEEP" in command else {"user": "partial" if expected_rc else "done"}
                    assert out.rc == expected_rc and out.success == (expected_rc == 0), vars(out)
                    assert m.payload_entries == [(m.initial_r, entry_rc, "off", "on", "original")]
                    assert (m.r, m.rc, m.more, m.trace) == (expected_r, expected_rc, more, traced)
                    assert not m.holders and m._hold_name == "foreign_stale_holder"
                    assert all(owned for _, owned in m.calls + m.reads)
                    assert not m._is_executing and not m._exec_lock.owned and m._last_results is None
                    cases.append(f"normal:{persistent}:{more}:{traced}:{entry_rc}:{command}")

    preparation = ("entry-read", "more-read", "trace-read", "hold-entry", "more-off", "rewrite", "invalidate",
                   "path", "log-name", "open-raise", "open-false", "preflush", "size", "trace-on", "restore-entry", "input-rc")
    for fail in preparation:
        m = Model(new, root, fail=fail, persistent=fail in ("preflush", "size"))
        out = m.invoke()
        assert not out.success and out.rc > 0 and m.dispatched == 0, (fail, vars(out))
        assert (m.r, m.rc, m.more, m.trace) == (m.initial_r, 42, "on", "off"), (fail, m.r, m.rc)
        assert not m.holders and not m._exec_lock.owned
        if fail.endswith("read"):
            assert not m.calls
        cases.append("zero-dispatch:" + fail)

    for value in (None, False, True, "0", 0.5, -1, float("nan"), float("inf"), 2147483648):
        m = Model(new, root, rc=value)
        assert not m.invoke().success and not m.calls and not m.dispatched
        cases.append("invalid-entry:" + repr(value))

    for fail in ("result-read", "result-unknown", "hold-result", "postflush", "close", "output-read", "unlink",
                 "startup", "trace-restore", "more-restore", "restore-result", "exit-rc", "cwd-exit"):
        m = Model(new, root, fail=fail, persistent=fail == "postflush")
        out = m.invoke()
        assert not out.success and out.rc > 0 and out.stderr and m.dispatched == 1, (fail, vars(out))
        assert not m._exec_lock.owned and not m._is_executing
        if fail not in ("restore-result", "hold-result"):
            assert m.r == {"user": "done"}, (fail, m.r)
        cases.append("reported-failure:" + fail)

    for fail, command in ((None, "PAYLOAD INTERRUPT"), ("postflush", "PAYLOAD INTERRUPT"),
                          ("cleanup-interrupt", "PAYLOAD"), ("result-read-interrupt", "PAYLOAD")):
        m = Model(new, root, fail=fail, persistent=True)
        try:
            m.invoke(command)
        except KeyboardInterrupt as error:
            assert m.r == {"user": "done"} and m.more == "on" and m.trace == "off"
            assert not m.holders and not m._exec_lock.owned and not m._is_executing
            assert error.__notes__
        else:
            raise AssertionError("interruption swallowed: " + str(fail))
        cases.append("interruption:" + str(fail))

    m = Model(new, root, persistent=True, empty=True)
    assert m.invoke().success
    assert all(owned for _, owned in m.calls) and m.r == {"user": "done"}
    cases.append("empty-log-flush-stays-locked-and-held")
    m = Model(new, root)
    m.invoke(cwd="project", trace=False)
    assert m.cwd == "original" and m.payload_entries[0][-1] == "project"
    assert not any("c(trace)" == name for name, _ in m.reads)
    cases.append("cwd-restored-without-unrequested-trace")
    m.invoke()
    holds = [call for call, _ in m.calls if "_return hold " in call]
    assert len(holds) == len(set(holds)) == 4
    cases.append("invocation-owned-holders")

    for label, kwargs, command in (("entry-clobbered", {}, "PAYLOAD KEEP"),
                                   ("startup-clobbers-result", {}, "PAYLOAD"),
                                   ("trace-forced-off", {"trace": "on"}, "PAYLOAD"),
                                   ("open-failure-dispatch", {"fail": "open-false"}, "PAYLOAD"),
                                   ("failure-loses-results", {}, "PAYLOAD RAISE"),
                                   ("empty-flush-outside-lock", {"persistent": True, "empty": True}, "PAYLOAD")):
        a, b = Model(old, root, **kwargs), Model(new, root, **kwargs)
        ra, rb = a.invoke(command), b.invoke(command)
        if label == "entry-clobbered":
            assert a.payload_entries[0][0] != a.initial_r and b.payload_entries[0][0] == b.initial_r
        elif label in ("startup-clobbers-result", "failure-loses-results"):
            assert "maintenance" in a.r and "user" in b.r
        elif label == "trace-forced-off":
            assert a.trace == "off" and b.trace == "on"
        elif label == "open-failure-dispatch":
            assert a.dispatched == 1 and b.dispatched == 0 and not rb.success
        else:
            assert any("log flush" in call and not owned for call, owned in a.calls)
            assert all(owned for _, owned in b.calls)
        negatives.append(label)

print(json.dumps(dict(verdict="PASS", nativeVerified=False, scope="offline-capture-state",
                     candidateCases=len(cases), cases=cases, negativeControls=negatives)))
