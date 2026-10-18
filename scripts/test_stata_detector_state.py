"""Stateful protocol double: NOT a Stata/native/PyStata acceptance test."""
import contextlib
import copy
import json
import logging
import re
import shlex
import sys
import threading
import time
import uuid
from types import SimpleNamespace

sources = json.load(sys.stdin)


def implementation(source):
    scope = dict(contextlib=contextlib, threading=threading, time=time, re=re,
                 uuid=uuid, shlex=shlex, logger=logging.getLogger("detector-state"))
    exec(compile("from __future__ import annotations\n" + source,
                 "<detector-state>", "exec"), scope)
    return scope["Detector"]


class Backend:
    def __init__(self):
        self.stata, self._exec_lock, self._initialized = self, threading.RLock(), True
        self._graph_name_reverse, self._command_idx, self._list_graphs_cache = {}, 2, None
        self.rc, self.entry, self.r = 459, 459, {"mean": 3.5, "names": "kept"}
        self.s = {"vars": "price mpg", "payload": "引号\" $keep `caller'\nsecond line"}
        self.saved_s = copy.deepcopy(self.s)
        self.scalars, self.holders, self.calls, self.reads = {}, {}, [], []
        self.globals = {"mcpinvlist": "caller", "mcpinvcount": "caller", "mcpinvts0": "caller", "mcp_ts_0": "caller"}
        self.graphs = {"g1": ("1 Jan 2026", "12:00:00"), "g2": ("2 Jan 2026", "13:00:00")}
        self.raw, self.current_graph, self.native_errors = "g1 g2", None, {}
        self.before_errors, self.after_errors, self.read_errors = {}, {}, {}
        self.write_errors, self.write_after_errors, self.ignored_writes = {}, {}, set()
        self.macro_writes = []
        self.read_values, self.phase_count = {}, {}
        self.holder_names, self.scalar_names, self.init_calls = [], [], 0
        self.last_phase = None
        sys.modules["sfi"] = SimpleNamespace(Macro=self, Scalar=self)

    def init(self):
        self.init_calls += 1
        raise AssertionError("implicit initialization")

    def _resolve_graph_name_for_stata(self, name):
        return {"用户图": "g1"}.get(name, name)

    def list_graphs(self, **kwargs):
        raise AssertionError("fallback must not be used")

    def getValue(self, name):
        assert self._exec_lock._is_owned(), "RC read outside client lock"
        self.reads.append(name)
        label = "entry" if name == "c(rc)" and not self.calls else "restore-rc" if name == "c(rc)" else "query-rc"
        if label in self.read_errors:
            raise self.read_errors.pop(label)
        if label in self.read_values:
            return self.read_values[label]
        return self.rc if name == "c(rc)" else self.scalars[name]

    def getGlobal(self, name):
        self.reads.append(name)
        if name in self.read_errors:
            raise self.read_errors.pop(name)
        if name in self.read_values:
            return self.read_values[name]
        if name.startswith("r("):
            return self.r.get(name[2:-1], "")
        if name.startswith("s("):
            return self.s.get(name[2:-1], "")
        return self.globals.get(name, "")

    def setGlobal(self, name, value):
        assert self._exec_lock._is_owned(), "macro write outside client lock"
        self.macro_writes.append((name, value))
        if name in self.write_errors:
            raise self.write_errors.pop(name)
        if name in self.ignored_writes:
            return
        target, key = (self.s, name[2:-1]) if name.startswith("s(") else (self.globals, name)
        if value:
            target[key] = value
        else:
            target.pop(key, None)
        if name in self.write_after_errors:
            raise self.write_after_errors.pop(name)

    def run(self, code, **kwargs):
        assert self._exec_lock._is_owned(), "Stata command outside client lock"
        assert kwargs.get("echo") is False
        self.calls.append(code)
        # Previous candidate used literal backslash-newlines in frozen bodies;
        # accept both to exercise its observable state/RC protocol independently.
        for line in code.replace("\\n", "\n").splitlines():
            line = line.strip()
            if not line or line in ("nobreak {", "}"):
                continue
            captured = line.startswith("capture ")
            statement = line.removeprefix("capture ").removeprefix("quietly ")
            if statement.startswith("_return hold "):
                phase = "hold"
            elif statement.startswith("_return restore "):
                phase = "restore"
            elif statement.startswith("scalar drop "):
                phase = "drop"
            elif statement.startswith("scalar "):
                phase = "assign-rc" if statement.endswith(" = _rc") else "prepare-scalar"
            elif statement.startswith("graph "):
                phase = statement
            elif statement.startswith("global ") and statement.endswith(" : s(macros)"):
                phase = "enumerate-s"
            elif statement == "sreturn clear":
                phase = "clear-s"
            elif statement.startswith("error "):
                phase = "restore-rc"
            else:
                phase = "legacy-macro"
            self.last_phase = phase
            self.phase_count[phase] = self.phase_count.get(phase, 0) + 1
            if phase in self.before_errors:
                raise self.before_errors.pop(phase)
            if phase == "hold":
                name = statement.split()[-1]
                if name in self.holders:
                    raise RuntimeError("holder collision")
                self.holders[name] = copy.deepcopy(self.r)
                self.holder_names.append(name)
                self.r, self.rc = {}, 0
            elif phase == "restore":
                name = statement.split()[-1]
                self.r, self.rc = self.holders.pop(name), 0
            elif phase == "drop":
                del self.scalars[statement.split()[-1]]
                self.rc = 0
            elif phase in ("prepare-scalar", "assign-rc"):
                name = statement.split()[1]
                self.scalar_names.append(name)
                self.scalars[name] = self.rc if phase == "assign-rc" else float("nan")
                self.rc = 0
            elif phase.startswith("graph "):
                if phase.startswith("graph describe "):
                    # StataNow gr_describe.ado calls nametype, which sret clears.
                    self.s = {}
                self.rc = self.native_errors.get(phase, 0)
                if not self.rc:
                    if phase == "graph dir, memory":
                        self.r = {"list": self.raw}
                    else:
                        self.current_graph = phase.split()[-1]
                        date, clock = self.graphs[self.current_graph]
                        self.r = {"command_date": date, "command_time": clock}
                elif not captured:
                    raise RuntimeError("uncaptured r(" + str(self.rc) + ")")
            elif phase == "restore-rc":
                self.rc = int(statement.split()[-1])
            elif phase == "enumerate-s":
                self.globals[statement.split()[1]] = " ".join(self.s)
                self.rc = self.native_errors.get(phase, 0)
            elif phase == "clear-s":
                self.s = {}
                self.rc = self.native_errors.get(phase, 0)
            elif statement.startswith("macro define "):
                name = statement.split()[2].split("`")[0]
                if name == "mcpinvlist": self.globals[name] = self.r.get("list", "")
                elif name == "mcpinvcount": self.globals[name] = "0"
                else: self.globals[name] = "legacy-write"
                self.rc = 0
            else:
                # locals/loops from old implementation; immaterial for negative
                # controls that exercise inventory-only reads and caller globals.
                self.rc = 0
            if phase in self.after_errors:
                raise self.after_errors.pop(phase)


new, previous = implementation(sources["candidate"]), implementation(sources["previous"])
cases, controls = [], []


def fresh():
    backend = Backend()
    return backend, new(backend)


def expect_error(call):
    try:
        call()
    except BaseException as error:
        return error
    raise AssertionError("expected error")


def leaves(error):
    if isinstance(error, BaseExceptionGroup):
        return [item for child in error.exceptions for item in leaves(child)]
    return [error]


def restored(backend):
    assert backend.r == {"mean": 3.5, "names": "kept"}, backend.r
    assert backend.rc == backend.entry, backend.rc
    assert backend.scalars == {} and backend.holders == {}, (backend.scalars, backend.holders)
    assert all(value == "caller" for value in backend.globals.values()), backend.globals


for method, args in [("_get_graph_inventory", ()), ("_get_graph_timestamps", (["g1", "g2"],)),
                     ("_get_current_graphs_from_pystata", ()), ("_get_graph_state_from_pystata", ()),
                     ("_detect_graphs_via_pystata", ()), ("detect_graph_modifications", ())]:
    b, d = fresh()
    getattr(d, method)(*args)
    restored(b)
    assert all(len(name) <= 32 for name in b.holder_names + b.scalar_names)
    cases.append("success:" + method)

b, d = fresh()
b._graph_name_reverse = {"g1": "用户图"}
assert d._get_graph_inventory()[0] == ["用户图", "g2"]
assert d._get_graph_timestamps(["用户图"])["用户图"] == "1 Jan 2026_12:00:00"
restored(b)
cases.append("aliases-resolved-before-native-interpolation")

for raw in ("", '"g1" g2'):
    b, d = fresh()
    b.raw = raw
    names, _ = d._get_graph_inventory()
    assert names == ([] if raw == "" else ["g1", "g2"])
    restored(b)
    cases.append("valid-inventory:" + repr(raw))

b, d = fresh()
b.graphs["g1"] = ("", "")
assert d._get_graph_inventory()[1]["g1"] == ""
restored(b)
cases.append("documented-missing-timestamp")

for value in (-1, 1.5, True, "0", None, float("nan"), float("inf"), 2147483648):
    b, d = fresh()
    b.read_values["entry"] = value
    expect_error(d._get_graph_inventory)
    assert not b.calls and d._inventory_cache["graphs"] == []
    cases.append("invalid-entry-zero-commands:" + repr(value))

for missing in ("uninitialized", "lock", "backend"):
    b, d = fresh()
    if missing == "uninitialized": b._initialized = False
    elif missing == "lock": b._exec_lock = None
    else: d._stata_client = None
    expect_error(d._get_graph_inventory)
    assert not b.calls and b.init_calls == 0
    cases.append("missing-" + missing)

for phase in ("graph dir, memory", "graph describe g1", "graph describe g2"):
    for rc in (1, 198, 601):
        b, d = fresh()
        b.native_errors[phase] = rc
        before = copy.deepcopy(d._inventory_cache)
        error = expect_error(d._get_graph_inventory)
        assert error.stata_rc == rc
        assert d._inventory_cache == before
        restored(b)
        cases.append("native-rc:" + phase + ":" + str(rc))

for phase in ("graph dir, memory", "graph describe g1", "graph describe g2"):
    for error in (RuntimeError(phase), OSError(phase), KeyboardInterrupt(phase)):
        b, d = fresh()
        b.before_errors[phase] = error
        assert expect_error(d._get_graph_inventory) is error
        restored(b)
        cases.append("python-failure:" + phase + ":" + type(error).__name__)

for phase in ("r(list)", "r(command_date)", "r(command_time)", "query-rc"):
    b, d = fresh()
    error = ValueError(phase)
    b.read_errors[phase] = error
    assert expect_error(d._get_graph_inventory) is error
    restored(b)
    cases.append("read-failure:" + phase)

for value in (-1, 1.5, True, "0", None, float("nan"), 2147483648):
    b, d = fresh()
    b.read_values["query-rc"] = value
    expect_error(d._get_graph_inventory)
    restored(b)
    cases.append("unknown-query-rc:" + repr(value))

for phase in ("hold", "prepare-scalar"):
    b, d = fresh()
    error = RuntimeError(phase)
    b.after_errors[phase] = error
    assert expect_error(d._get_graph_inventory) is error
    assert not any(call.startswith("capture quietly graph") for call in b.calls)
    restored(b)
    cases.append("preparation-boundary-failure:" + phase)

for phase in ("drop", "restore", "restore-rc"):
    b, d = fresh()
    error = RuntimeError(phase)
    b.before_errors[phase] = error
    assert error in leaves(expect_error(d._get_graph_inventory))
    assert d._inventory_cache["graphs"] == []
    assert b.phase_count.get("restore-rc") == 1
    if phase != "restore": assert b.r == {"mean": 3.5, "names": "kept"}
    cases.append("cleanup-failure-no-cache:" + phase)

b, d = fresh()
query_error, cleanup_error = KeyboardInterrupt("query stop"), OSError("restore failed")
b.before_errors.update({"graph describe g2": query_error, "restore": cleanup_error})
error = expect_error(d._get_graph_inventory)
assert leaves(error) == [query_error, cleanup_error]
assert b.rc == b.entry and d._inventory_cache["graphs"] == []
assert len(b.holders) == 1, "failed restore must retain the saved holder"
cases.append("query-interruption-and-restore-error-both-retained")

b, d = fresh()
b.read_values["restore-rc"] = 0
assert "not restored" in str(expect_error(d._get_graph_inventory))
assert d._inventory_cache["graphs"] == []
cases.append("restore-mismatch-is-failure")

for bad in ("x;clear", "g1\nclear", "$graph", "`evil'", "../g1", "g1.gph", '"g1"', "space name", "x" * 33):
    b, d = fresh()
    expect_error(lambda: d._get_graph_timestamps([bad]))
    assert not b.calls
    cases.append("bad-request-name-zero-commands:" + repr(bad))

for bad in ('"unterminated', "g1 x;clear", "g1 $graph", "g1 g1"):
    b, d = fresh()
    b.raw = bad
    expect_error(d._get_graph_inventory)
    assert not any("graph describe " in call for call in b.calls)
    restored(b)
    cases.append("bad-inventory-before-describe:" + repr(bad))

b, d = fresh()
b._graph_name_reverse = {"g1": "duplicate", "g2": "duplicate"}
expect_error(d._get_graph_inventory)
restored(b)
cases.append("duplicate-aliases-rejected")

b, d = fresh()
d._inventory_cache_enabled = True
first = d._get_graph_inventory()
stamp, count = d._inventory_cache["timestamp"], len(b.calls)
second = d._get_graph_inventory()
assert len(b.calls) == count and d._inventory_cache["timestamp"] == stamp
second[0].clear(); second[1].clear()
assert d._inventory_cache["graphs"] == first[0] and d._inventory_cache["timestamps"] == first[1]
d._inventory_cache["timestamp"] -= 5
d._get_graph_inventory()
assert len(b.calls) > count
restored(b)
cases.append("cache-hit-no-stata-no-ttl-extension-defensive-copy")

b, d = fresh()
assert d._get_graph_timestamps([]) == {} and not b.calls
d._last_graph_state = {"kept": {"signature": "x"}}
b.native_errors["graph dir, memory"] = 198
expect_error(d.detect_graph_modifications)
assert d._last_graph_state == {"kept": {"signature": "x"}}
restored(b)
cases.append("native-failure-does-not-clear-last-state")

# Real Python threads share a real reentrant client lock. UUIDs, not timestamps,
# name the state holders. This does not test native Stata thread affinity.
b, d = fresh()
barrier, failures = threading.Barrier(5), []
def worker():
    barrier.wait()
    try: d._get_graph_inventory()
    except BaseException as error: failures.append(error)
threads = [threading.Thread(target=worker) for _ in range(4)]
for thread in threads: thread.start()
barrier.wait()
for thread in threads: thread.join(2)
assert not failures and all(not thread.is_alive() for thread in threads), failures
assert len(set(b.holder_names)) == 4
restored(b)
cases.append("concurrent-python-probes-serialize-and-use-distinct-names")

# Negative controls use the exact pre-state candidate, including its capture
# bundle. A quiet native failure returns an empty list instead of an exception;
# success writes caller globals and loses entry c(rc).
b = Backend(); d = previous(b)
d._get_graph_inventory(need_timestamps=False)
assert b.globals["mcpinvlist"] != "caller"
assert b.rc != b.entry
controls.extend(["previous-writes-caller-globals", "previous-loses-entry-rc"])
b = Backend(); d = previous(b)
b.native_errors["graph dir, memory"] = 198
assert d._get_graph_inventory(need_timestamps=False) == ([], {})
controls.append("previous-captured-native-error-became-empty")
b = Backend(); d = previous(b)
b.after_errors["graph dir, memory"] = RuntimeError("query boundary")
expect_error(lambda: d._get_graph_inventory(need_timestamps=False))
assert b.holders and b.r != {"mean": 3.5, "names": "kept"}
controls.append("previous-query-exception-skips-restore")

print(json.dumps(dict(verdict="PASS", nativeVerified=False,
                     scope="offline-detector-state-protocol", candidateCases=len(cases),
                     cases=cases, negativeControls=controls)))
