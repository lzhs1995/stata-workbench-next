"""Exercise frozen detector methods; SFI and Stata remain explicit doubles.

This suite verifies Python failure propagation and cache decisions, not native
capture return codes or preservation of Stata state across PyStata boundaries.
"""
import contextlib
import copy
import json
import logging
import shlex
import sys
import threading
import time
from types import SimpleNamespace

sources = json.load(sys.stdin)


def implementation(source):
    scope = dict(contextlib=contextlib, threading=threading, time=time,
                 shlex=shlex, logger=logging.getLogger("detector-test"))
    exec(compile("from __future__ import annotations\n" + source,
                 "<frozen-detector>", "exec"), scope)
    return scope["Detector"]


def fail(error):
    def invoke(*args, **kwargs):
        raise error
    return invoke


class Backend:
    def __init__(self, error=None, phase=None, raw="g1 g2"):
        self.error, self.phase, self.raw = error, phase, raw
        self.stata, self._exec_lock = self, threading.RLock()
        self._graph_name_reverse, self._command_idx = {}, 1
        self._list_graphs_cache = None
        self.calls, self.list_calls = [], 0
        sys.modules["sfi"] = SimpleNamespace(Macro=self)

    def run(self, code, **kwargs):
        self.calls.append(code)
        if self.error is not None and self.phase == "run":
            raise self.error

    def getGlobal(self, name):
        if self.error is not None and self.phase == "read":
            raise self.error
        return {"mcpinvlist": self.raw, "mcpinvcount": "2",
                "mcpinvts0": "t1", "mcpinvts1": "t2",
                "mcp_ts_0": "t1", "mcp_ts_1": "t2"}[name]

    def _resolve_graph_name_for_stata(self, name):
        return name

    def list_graphs(self, **kwargs):
        self.list_calls += 1
        return []


new, old = implementation(sources["candidate"]), implementation(sources["original"])
cases, controls = [], []


def must_raise(call, error):
    try:
        call()
    except BaseException as actual:
        assert actual is error, (actual, error)
    else:
        raise AssertionError("failure became successful empty or partial state")


errors = [RuntimeError("runtime"), ValueError("value"), AttributeError("attribute"),
          ImportError("sfi"), OSError("io"), TypeError("type")]
for method, args in [("_get_graph_inventory", ()), ("_get_graph_timestamps", (["g1"],))]:
    for phase in ("run", "read"):
        for error in errors:
            backend = Backend(error, phase)
            detector = new(backend)
            before = copy.deepcopy(detector._inventory_cache)
            must_raise(lambda: getattr(detector, method)(*args), error)
            assert detector._inventory_cache == before
            legacy = old(Backend(error, phase))
            assert getattr(legacy, method)(*args) in ({}, ([], {}))
            cases.append(f"{method}:{phase}:{type(error).__name__}")
            controls.append(cases[-1])

for method in ("_detect_graphs_via_pystata", "detect_graph_modifications"):
    for error in errors + [KeyboardInterrupt("stop")]:
        detector = new(Backend())
        before = {"kept": {"signature": "stable", "exists": True}}
        detector._last_graph_state = copy.deepcopy(before)
        detector._get_graph_state_from_pystata = fail(error)
        must_raise(getattr(detector, method), error)
        assert detector._last_graph_state == before
        cases.append(f"{method}:{type(error).__name__}:state-unchanged")
        if isinstance(error, Exception):
            legacy = old(Backend())
            legacy._get_graph_state_from_pystata = fail(error)
            assert getattr(legacy, method)() in ([], {"dropped": [], "renamed": [], "cleared": False})
            controls.append(cases[-1])

for error in errors:
    detector = new(Backend())
    detector._get_graph_inventory = fail(error)
    must_raise(detector._get_graph_state_from_pystata, error)
    must_raise(detector._get_current_graphs_from_pystata, error)
    assert detector._stata_client.list_calls == 0
    legacy = old(Backend())
    legacy._get_graph_inventory = fail(error)
    assert legacy._get_graph_state_from_pystata() == {}
    assert legacy._get_current_graphs_from_pystata() == []
    cases.append(f"state-and-current:{type(error).__name__}")
    controls.append(cases[-1])

# A mid-list signature failure must not fabricate a nonexistent graph.
error = RuntimeError("second signature")
for cls in (new, old):
    detector = cls(Backend())
    detector._get_graph_inventory = lambda: (["g1", "g2"], {})
    def signature(name):
        if name == "g2":
            raise error
        return "first-signature"
    detector._describe_graph_signature = signature
    if cls is new:
        must_raise(detector._get_graph_state_from_pystata, error)
        assert detector._last_graph_state == {}
    else:
        assert detector._get_graph_state_from_pystata()["g2"]["exists"] is False
cases.append("partial-signature-rejected")
controls.append(cases[-1])

# Reproduce the false-clear chain using the real nested frozen methods.
for cls in (new, old):
    backend = Backend(error, "run")
    detector = cls(backend)
    detector._last_graph_state = {"kept": {"signature": "old"}}
    if cls is new:
        must_raise(detector.detect_graph_modifications, error)
        assert "kept" in detector._last_graph_state
    else:
        result = detector.detect_graph_modifications()
        assert result["cleared"] is True and result["dropped"] == ["kept"]
        assert detector._last_graph_state == {}
cases.append("inventory-failure-is-not-clear")
controls.append(cases[-1])

for method in ("_get_graph_inventory", "_get_graph_state_from_pystata",
               "_get_current_graphs_from_pystata", "_detect_graphs_via_pystata",
               "detect_graph_modifications"):
    try:
        getattr(new(), method)()
    except RuntimeError as error:
        assert "unavailable" in str(error)
    else:
        raise AssertionError("missing backend became empty")
    cases.append("missing-backend:" + method)
assert new()._get_graph_timestamps([]) == {}
try:
    new()._get_graph_timestamps(["g1"])
except RuntimeError:
    pass
else:
    raise AssertionError("nonempty timestamps without a backend")
cases.append("empty-timestamps-versus-missing-backend")

# Successful reads, timestamp stability, removal, and a genuine empty inventory.
backend = Backend()
backend._graph_name_reverse = {"g1": "用户图"}
detector = new(backend)
graphs, timestamps = detector._get_graph_inventory()
assert graphs == ["用户图", "g2"] and timestamps == {"用户图": "t1", "g2": "t2"}
assert detector._detect_graphs_via_pystata() == graphs
assert detector._detect_graphs_via_pystata() == []
assert detector._get_graph_timestamps(["g1"]) == {"g1": "t1"}
assert detector._get_current_graphs_from_pystata() == graphs and backend.list_calls == 0
cases.append("success-signatures-aliases-and-authoritative-current")
backend.raw = ""
result = detector.detect_graph_modifications()
assert result["cleared"] and set(result["dropped"]) == set(graphs)
cases.append("genuine-empty-clears")

detector = new(Backend(raw='"unterminated'))
try:
    detector._get_graph_inventory()
except ValueError:
    pass
else:
    raise AssertionError("malformed inventory guessed")
assert old(Backend(raw='"unterminated'))._get_graph_inventory()[0] == ['"unterminated']
cases.append("malformed-inventory-rejected")
controls.append(cases[-1])

print(json.dumps(dict(verdict="PASS", nativeVerified=False,
                     scope="offline-detector-error-propagation", candidateCases=len(cases),
                     cases=cases, negativeControls=controls)))
