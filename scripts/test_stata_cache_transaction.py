"""Actual detector/client/cache methods; Stata and export I/O are protocol doubles."""
import ast
import asyncio
import contextlib
import copy
import inspect
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
import anyio

sources = json.load(sys.stdin)
tree = ast.parse(Path(__file__).with_name('test_stata_detector_state.py').read_text())
node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Backend')
exec(compile(ast.Module(body=[node], type_ignores=[]), '<protocol-double>', 'exec'))


class GraphInfo:
    def __init__(self, name, active=False, created=None):
        self.name, self.active, self.created = name, active, created
    def model_copy(self):
        return copy.copy(self)


def implementation(source):
    scope = dict(contextlib=contextlib, threading=threading, time=time, re=re,
                 uuid=uuid, shlex=shlex, asyncio=asyncio, inspect=inspect, json=json,
                 logger=logging.getLogger('cache-transaction'), GraphInfo=GraphInfo,
                 GraphListResponse=lambda graphs: SimpleNamespace(graphs=graphs))
    exec(compile('from __future__ import annotations\n' + source, '<candidate>', 'exec'), scope)
    return scope


new, old = implementation(sources['candidate']), implementation(sources['previous'])
Client = implementation(sources['client'])['Client']
OldClient = implementation(sources['previousClient'])['Client']
cases, controls = [], []


def fresh(impl=new, client=Client):
    b = Backend()
    b.__class__ = type('TestClient', (client, Backend), {})
    b._list_graphs_cache_lock = threading.Lock()
    b._list_graphs_cache_time, b.LIST_GRAPHS_TTL, b._is_executing = 0, 1, False
    b._graph_signature_cache, b._graph_signature_cache_cmd_idx = {}, None
    b._graph_detector = impl['GraphCreationDetector'](b)
    b.exports, b.outcomes = [], {}
    def export(name):
        assert b._exec_lock._is_owned() or impl is old
        b.exports.append(name)
        result = b.outcomes.get(name, True)
        if isinstance(result, BaseException):
            raise result
        return result
    b.cache_graph_on_creation = export
    return b, impl['StreamingGraphCache'](b, auto_cache=True)


def next_request(b, impl=new):
    b._command_idx += 1
    return impl['StreamingGraphCache'](b, auto_cache=True)


def restored(b):
    assert b.r == {'mean': 3.5, 'names': 'kept'} and b.s == b.saved_s
    assert b.rc == b.entry and b.scalars == {} and b.holders == {}
    assert all(value == 'caller' for value in b.globals.values())


async def failure(call):
    try:
        await call()
    except BaseException as exc:
        return exc
    raise AssertionError('expected failure')


def leaves(exc):
    return [leaf for child in exc.exceptions for leaf in leaves(child)] if isinstance(exc, BaseExceptionGroup) else [exc]


async def run():
    for result in (False, None, OSError('disk')):
        b, cache = fresh(); b.outcomes['g1'] = result
        await failure(cache.cache_detected_graphs_with_pystata)
        assert set(b._graph_detector._pending_cache_names()) == {'g1', 'g2'}
        b.outcomes.clear(); cache = next_request(b)
        assert await cache.cache_detected_graphs_with_pystata() == ['g1', 'g2']
        assert b.exports == ['g1', 'g1', 'g2']; restored(b)
        cases.append('cross-request-retry:' + type(result).__name__)

    for phase in ('graph dir, memory', 'graph describe g1', 'graph describe g2'):
        for entry in ('detect', 'list', 'snapshot'):
            b, cache = fresh()
            if entry != 'detect':
                b._graph_detector._detect_graphs_via_pystata()
            b.native_errors[phase] = 601
            if entry == 'snapshot':
                async def call(): b._capture_graph_state(cache, True)
            else:
                call = cache.cache_detected_graphs_with_pystata if entry == 'detect' else cache.cache_detected_graphs
            exc = await failure(call)
            assert any(getattr(e, 'stata_rc', None) == 601 for e in leaves(exc))
            assert not b.exports; restored(b)
            b.native_errors.clear(); retry = next_request(b)
            assert await retry.cache_detected_graphs_with_pystata() == ['g1', 'g2']
            cases.append('real-query-failure-retry:' + entry + ':' + phase)

    b, cache = fresh(); b.outcomes['g2'] = OSError('disk')
    await failure(cache.cache_detected_graphs_with_pystata)
    assert b._graph_detector._pending_cache_names() == ['g2']
    b.outcomes.clear()
    assert await next_request(b).cache_detected_graphs_with_pystata() == ['g2']
    assert b.exports == ['g1', 'g2', 'g2']; cases.append('partial-success-no-repeat')

    for failing_channels in ('graph', 'log', 'both'):
        b, cache = fresh(); calls = []; one, two = ValueError('graph'), OSError('log')
        async def on_graph(name, success):
            calls.append(('graph', name, success))
            if failing_channels in ('graph', 'both'): raise one
        async def log(payload):
            event = json.loads(payload); calls.append(('log', event['graph'], event['success']))
            assert event['task_id'] == 'request-1'
            if failing_channels in ('log', 'both'): raise two
        cache.add_cache_callback(b._create_graph_cache_callback(on_graph, log, 'request-1'))
        exc = await failure(cache.cache_detected_graphs_with_pystata)
        assert leaves(exc) == ([one, two] if failing_channels == 'both' else [one if failing_channels == 'graph' else two])
        assert calls == [('graph', 'g1', True), ('log', 'g1', True)]
        assert await next_request(b).cache_detected_graphs_with_pystata() == ['g2']
        assert b.exports == ['g1', 'g2']; cases.append('real-notification-wrapper:' + failing_channels)

    b, cache = fresh(); export_error, callback_error = OSError('export'), ValueError('callback')
    b.outcomes['g1'] = export_error
    async def callback(*args): raise callback_error
    cache.add_cache_callback(b._create_graph_cache_callback(callback, callback))
    exc = await failure(cache.cache_detected_graphs_with_pystata)
    assert leaves(exc) == [export_error, callback_error, callback_error]
    assert set(b._graph_detector._pending_cache_names()) == {'g1', 'g2'}
    cases.append('export-and-both-notification-errors-retained')

    for channel in ('graph', 'log'):
        b, cache = fresh(); calls = []
        async def graph(*args):
            calls.append('graph')
            if channel == 'graph': raise asyncio.CancelledError()
        async def log(*args):
            calls.append('log')
            if channel == 'log': raise asyncio.CancelledError()
        cache.add_cache_callback(b._create_graph_cache_callback(graph, log))
        assert isinstance(await failure(cache.cache_detected_graphs_with_pystata), asyncio.CancelledError)
        assert calls == (['graph'] if channel == 'graph' else ['graph', 'log'])
        assert await next_request(b).cache_detected_graphs_with_pystata() == ['g2']
        assert b.exports == ['g1', 'g2']; cases.append('notification-cancellation:' + channel)

    b, cache = fresh(); d = b._graph_detector
    assert d.detect_graph_modifications() == {'dropped': [], 'renamed': [], 'cleared': False}
    assert await cache.cache_detected_graphs_with_pystata() == ['g1', 'g2']
    assert await cache.cache_detected_graphs_with_pystata() == []
    cases.append('modifications-observation-does-not-consume-pending')
    b.graphs['g1'] = ('1 Jan 2026', '12:00:01')
    assert await cache.cache_detected_graphs_with_pystata() == ['g1']
    assert b.exports == ['g1', 'g2', 'g1']; cases.append('same-request-new-timestamp')

    b, cache = fresh(); d = b._graph_detector
    d._detect_graphs_via_pystata(); tokens = dict(d._pending_cache_states)
    b._capture_graph_state(cache, True)
    assert d._pending_cache_states == tokens
    assert await cache.cache_detected_graphs() == ['g1', 'g2']
    assert not d._pending_cache_names(); cases.append('real-snapshot-keeps-pending')

    for action in ('drop', 'clear', 'rename'):
        b, cache = fresh(); d = b._graph_detector
        await cache.cache_detected_graphs_with_pystata()
        if action == 'drop':
            modifications = {'dropped': ['g1']}; b.raw = 'g2'
        elif action == 'clear':
            modifications = {'cleared': True}; b.raw = ''
        else:
            modifications = {'renamed': [('g1', 'g3')]}; b.raw = 'g2 g3'; b.graphs['g3'] = b.graphs['g1']
        finished = threading.Event()
        def modify(): d.process_modifications(modifications); finished.set()
        t = threading.Thread(target=modify, daemon=True); t.start()
        assert await asyncio.to_thread(finished.wait, 1), 'detector lock deadlock'
        t.join(); assert 'g1' not in d._last_graph_state
        b.raw = 'g1 g2'
        assert await cache.cache_detected_graphs_with_pystata() == (['g1', 'g2'] if action == 'clear' else ['g1'])
        cases.append('lifecycle-recreate-no-deadlock:' + action)

    b, cache = fresh(); d = b._graph_detector
    d._detect_graphs_via_pystata(); d.mark_graph_removed('g1')
    assert d._pending_cache_names() == ['g2'] and 'g1' not in d._last_graph_state
    d.mark_all_cleared(); assert not d._pending_cache_names() and not d._last_graph_state
    cases.append('direct-lifecycle-clears-pending')

    b, cache = fresh(); d = b._graph_detector
    d._detect_graphs_via_pystata(); b.raw = 'g2'; d.detect_graph_modifications()
    assert d._pending_cache_names() == ['g2']; cases.append('observation-removal-discards-pending')

    b, cache = fresh(); other = next_request(b)
    results = await asyncio.gather(cache.cache_detected_graphs_with_pystata(), other.cache_detected_graphs_with_pystata())
    assert sorted(name for result in results for name in result) == ['g1', 'g2']
    assert sorted(b.exports) == ['g1', 'g2']; cases.append('two-request-caches-export-once')

    # Cancellation controls use actual OS threads and the actual cache entrypoint.
    for stage in ('detect', 'list', 'export'):
        for cancel_kind in ('asyncio', 'repeated', 'anyio'):
            for worker_fails in (False, True):
                b, cache = fresh(); started, release, finished = threading.Event(), threading.Event(), threading.Event()
                old_run, old_export = b.run, b.cache_graph_on_creation
                invocation = [0]
                def slow_worker():
                    started.set()
                    assert release.wait(2)
                    finished.set()
                    if worker_fails: raise OSError('worker failure')
                def run_query(code, **kw):
                    if 'graph dir, memory' in code:
                        invocation[0] += 1
                        if invocation[0] == (1 if stage == 'detect' else 2) and stage != 'export': slow_worker()
                    return old_run(code, **kw)
                def export(name):
                    if name == 'g1': slow_worker()
                    return old_export(name)
                b.run, b.cache_graph_on_creation = run_query, export
                observed = []
                async def own():
                    try: await cache.cache_detected_graphs_with_pystata()
                    except BaseException as exc: observed.append(exc)
                if cancel_kind == 'anyio':
                    async with anyio.create_task_group() as group:
                        group.start_soon(own)
                        assert await asyncio.to_thread(started.wait, 1)
                        group.cancel_scope.cancel()
                        with anyio.CancelScope(shield=True):
                            await asyncio.sleep(.01); assert not finished.is_set() and not observed
                            release.set()
                else:
                    task = asyncio.create_task(own())
                    assert await asyncio.to_thread(started.wait, 1)
                    task.cancel(); await asyncio.sleep(.01)
                    if cancel_kind == 'repeated': task.cancel(); await asyncio.sleep(.01)
                    assert not task.done() and not observed
                    release.set(); await asyncio.wait_for(task, 2)
                assert finished.is_set() and len(observed) == 1 and isinstance(observed[0], asyncio.CancelledError)
                b.run, b.cache_graph_on_creation = old_run, old_export
                expected = ['g2'] if stage == 'export' and not worker_fails else ['g1', 'g2']
                assert await next_request(b).cache_detected_graphs_with_pystata() == expected
                assert b.exports == ['g1', 'g2']; restored(b)
                cases.append('owned-thread-drain:' + stage + ':' + cancel_kind + ':' + str(worker_fails))

    b, cache = fresh(); cache.auto_cache = False
    assert await cache.cache_detected_graphs_with_pystata() == [] and not b.calls
    cases.append('disabled-no-query')

    # Frozen previous methods expose the failures fixed above.
    b, cache = fresh(old); b.outcomes['g1'] = False
    await failure(cache.cache_detected_graphs_with_pystata); b.outcomes.clear()
    assert await next_request(b, old).cache_detected_graphs_with_pystata() == []
    assert b.exports == ['g1']; controls.append('old-cross-request-pending-lost-F2')
    b, cache = fresh(old)
    b._graph_detector.detect_graph_modifications()
    assert await cache.cache_detected_graphs_with_pystata() == [] and not b.exports
    controls.append('old-modification-observation-consumes-work')
    b, cache = fresh(old); await cache.cache_detected_graphs_with_pystata()
    b.graphs['g1'] = ('1 Jan 2026', '12:00:01')
    assert await cache.cache_detected_graphs_with_pystata() == []
    controls.append('old-same-request-timestamp-ignored')
    b, cache = fresh(client=OldClient); calls = []
    async def callback(*args): calls.append(args); raise ValueError('lost')
    cache.add_cache_callback(b._create_graph_cache_callback(callback, callback))
    assert await cache.cache_detected_graphs_with_pystata() == ['g1', 'g2']
    assert len(calls) == 4; controls.append('old-real-wrapper-swallows-F3')


asyncio.run(run())
print(json.dumps(dict(verdict='PASS', candidateCases=len(cases), cases=cases,
                      negativeControls=controls, nativeVerified=False)))
