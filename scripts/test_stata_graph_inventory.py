"""Offline client + real candidate detector methods; no live Stata imports."""
import ast
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
from pathlib import Path
from types import SimpleNamespace

sources = json.load(sys.stdin)
# Reuse the stateful native-protocol double, not another implementation of the
# client under test. Loading just its class prevents running that test suite.
tree = ast.parse(Path(__file__).with_name('test_stata_detector_state.py').read_text())
node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Backend')
exec(compile(ast.Module(body=[node], type_ignores=[]), '<shared-protocol-double>', 'exec'))


class GraphInfo:
    def __init__(self, name, active=False, created=None):
        self.name, self.active, self.created = name, active, created

    def model_copy(self):
        return copy.copy(self)


def implementation(source, name):
    scope = dict(contextlib=contextlib, threading=threading, time=time, re=re,
                 uuid=uuid, shlex=shlex, logger=logging.getLogger('inventory'),
                 GraphInfo=GraphInfo, GraphListResponse=lambda graphs: SimpleNamespace(graphs=graphs))
    exec(compile('from __future__ import annotations\n' + source, '<candidate>', 'exec'), scope)
    return scope[name]


Client = implementation(sources['candidate'], 'Client')
Old = implementation(sources['original'], 'Client')
Detector = implementation(sources['detector'], 'Detector')


def fresh(cls=Client):
    b = Backend()
    cls_type = type('TestClient', (cls, Backend), {})
    b.__class__ = cls_type
    b._list_graphs_cache_lock = threading.Lock()
    b._list_graphs_cache_time = 0
    b.LIST_GRAPHS_TTL = 1
    b._is_executing = False
    b._graph_signature_cache, b._graph_signature_cache_cmd_idx = {}, None
    b._graph_detector = Detector(b)
    b.globals.update(mcp_graph_list='caller', mcp_graph_details='caller')
    return b


def error(call):
    try:
        call()
    except BaseException as exc:
        return exc
    raise AssertionError('expected failure')


def restored(b):
    assert b.s == b.saved_s
    assert b.r == {'mean': 3.5, 'names': 'kept'} and b.rc == b.entry
    assert b.scalars == {} and b.holders == {}
    assert all(value == 'caller' for value in b.globals.values())


cases, controls = [], []
for raw in ('g1 g2', '', '"g1" g2'):
    b = fresh(); b.raw = raw
    expected = [] if not raw else ['g1', 'g2']
    assert b.list_graphs() == expected
    assert [g.name for g in b.list_graphs_structured().graphs] == expected
    restored(b)
    calls, stamp = len(b.calls), b._list_graphs_cache_time
    b.list_graphs()
    assert len(b.calls) == calls and b._list_graphs_cache_time == stamp
    cases.append('successful-detached-cached-inventory:' + repr(raw))

b = fresh(); b._graph_name_reverse = {'g1': '用户图'}
assert b.list_graphs() == ['用户图', 'g2']; restored(b)
assert b._list_graphs_cache[0].created == '1 Jan 2026 12:00:00'
cases.append('unicode-alias-preserves-created-format')

b = fresh(); b.list_graphs()
view = b.list_graphs_structured().graphs
view[0].name = 'tampered'; view.clear()
names = b.list_graphs(); names.clear()
assert b.list_graphs() == ['g1', 'g2'] and not b._list_graphs_cache[-1].active
cases.append('caller-mutation-cannot-change-cache')

b = fresh(); b.list_graphs(); b.raw = 'g2'
b._graph_detector._inventory_cache = {'timestamp': time.monotonic(), 'graphs': ['stale'], 'timestamps': {'stale': 'old'}}
assert b.list_graphs(force_refresh=True) == ['g2']
assert b._graph_detector._inventory_cache['graphs'] == ['stale']
cases.append('force-refresh-bypasses-both-ttls-without-mutating-detector-cache')

for age in (2, -10):
    b = fresh(); b.list_graphs(); b.raw = 'g2'
    b._list_graphs_cache_time = time.monotonic() - age
    assert b.list_graphs() == ['g2']
    cases.append('expired-or-future-cache:' + str(age))

for cached in (False, True):
    for problem in ('uninitialized', 'executing'):
        b = fresh()
        if cached: b.list_graphs()
        before = len(b.calls)
        if problem == 'uninitialized': b._initialized = False
        else: b._is_executing = True
        error(b.list_graphs); error(b.list_graphs_structured)
        assert len(b.calls) == before and b.init_calls == 0
        cases.append('no-fake-recursive-or-init-cache:' + problem + ':' + str(cached))

for cached in (False, True):
    for phase in ('graph dir, memory', 'graph describe g1', 'graph describe g2'):
        b = fresh()
        if cached: b.list_graphs()
        before, stamp = b._list_graphs_cache, b._list_graphs_cache_time
        b.native_errors[phase] = 601
        exc = error(lambda: b.list_graphs(force_refresh=True))
        assert exc.stata_rc == 601
        assert b._list_graphs_cache is before and b._list_graphs_cache_time == stamp
        restored(b)
        cases.append('native-failure-no-cache-publication:' + phase + ':' + str(cached))

for phase in ('r(list)', 'r(command_date)', 'r(command_time)'):
    b = fresh(); b.read_values[phase] = None
    error(b.list_graphs); restored(b); assert b._list_graphs_cache is None
    cases.append('invalid-read:' + phase)

for raw in ('g1 g1', 'g1/evil', '"unterminated', 'g1;drop'):
    b = fresh(); b.raw = raw
    error(b.list_graphs); restored(b)
    assert not any('graph describe' in cmd for cmd in b.calls)
    cases.append('reject-malformed-inventory:' + raw)

b = fresh(); b._graph_name_reverse = {'g1': 'same', 'g2': 'same'}
error(b.list_graphs); restored(b)
cases.append('reject-alias-collision')

for phase in ('hold', 'graph dir, memory', 'graph describe g2', 'restore', 'drop', 'restore-rc'):
    b = fresh(); exc = KeyboardInterrupt(phase); b.after_errors[phase] = exc
    observed = error(b.list_graphs)
    assert observed is exc or isinstance(observed, BaseExceptionGroup)
    assert b._list_graphs_cache is None
    cases.append('break-or-cleanup-error-prevents-publication:' + phase)

b = fresh(); b.native_errors['graph dir, memory'] = 601; b.before_errors['restore'] = OSError('restore')
exc = error(b.list_graphs)
assert isinstance(exc, BaseExceptionGroup) and len(exc.exceptions) == 2
cases.append('query-and-restore-errors-retained')

for method in ('list_graphs', 'list_graphs_structured', 'invalidate_list_graphs_cache'):
    b = fresh(); b.list_graphs()
    started, finished = threading.Event(), threading.Event()
    def worker():
        started.set(); getattr(b, method)(); finished.set()
    with b._exec_lock:
        t = threading.Thread(target=worker); t.start()
        assert started.wait(1) and not finished.wait(.03)
    t.join(2); assert not t.is_alive() and finished.is_set()
    cases.append('exec-lock-before-cached-operation:' + method)

class GraphCache:
    def __init__(self):
        self._initial_graphs, self.clears = {'preserved'}, 0
        self.detector = SimpleNamespace(clear_detection_state=self.clear)
    def clear(self): self.clears += 1

b = fresh(); cache = GraphCache()
result = b._capture_graph_state(cache, True)
assert cache._initial_graphs == {'g1', 'g2'} and cache.clears == 1
assert result == {'g1': 'g1_1 Jan 2026 12:00:00', 'g2': 'g2_2 Jan 2026 13:00:00'}
assert b.phase_count['graph dir, memory'] == 1
result.clear(); assert len(b._graph_signature_cache) == 2; restored(b)
cases.append('single-inventory-prerun-and-detached-signatures')

b = fresh(); b._initialized = False
assert b._capture_graph_state(None, False) is None and not b.calls
cases.append('disabled-graph-features-need-no-native-query')

b = fresh(); cache = GraphCache(); b.native_errors['graph dir, memory'] = 601
b._graph_signature_cache = {'old': 'keep'}; b._graph_signature_cache_cmd_idx = -1
error(lambda: b._capture_graph_state(cache, True))
assert cache._initial_graphs == {'preserved'} and cache.clears == 0
assert b._graph_signature_cache == {'old': 'keep'} and b._graph_signature_cache_cmd_idx == -1
cases.append('prerun-failure-propagates-without-clearing-cache')

b = fresh(); b.graphs['g1'] = ('', '')
first = b._get_graph_signature('g1'); b._command_idx += 1
assert first != b._get_graph_signature('g1'); restored(b)
cases.append('missing-creation-time-uses-command-index')

for problem in ('missing', 'failure'):
    b = fresh(); b._graph_signature_cache = {'old': 'keep'}
    if problem == 'failure': b.native_errors['graph dir, memory'] = 601
    error(lambda: b._get_graph_signature('missing' if problem == 'missing' else 'g1'))
    assert b._graph_signature_cache == {'old': 'keep'}
    cases.append('signature-no-fabricated-success:' + problem)

# Negative controls execute the frozen old methods, not source string checks.
b = fresh(Old); b._is_executing = True
assert b.list_graphs() == []; controls.append('old-recursive-empty-success')
b = fresh(Old); b._is_executing = True; b._list_graphs_cache = ['old']
b.list_graphs().append('changed'); assert b._list_graphs_cache == ['old', 'changed']
controls.append('old-cache-reference-escapes')
b = fresh(Old); b.list_graphs(force_refresh=True)
assert b.globals['mcp_graph_list'] != 'caller'; controls.append('old-fixed-global-overwritten')
b = fresh(Old); b.before_errors['graph dir, memory'] = RuntimeError('query')
assert b.list_graphs(force_refresh=True) == []; controls.append('old-query-failure-empty-success')
b = fresh(Old); cache = GraphCache()
b.list_graphs = lambda **kw: (_ for _ in ()).throw(RuntimeError('query'))
assert b._capture_graph_state(cache, True) == {} and cache._initial_graphs == set()
controls.append('old-prerun-failure-erases-inventory')
assert b._get_graph_signature('missing') == 'missing'
controls.append('old-signature-failure-fabricates-name')

print(json.dumps(dict(verdict='PASS', cases=cases, candidateCases=len(cases),
                      negativeControls=controls, nativeVerified=False)))
