"""Exercise cache transactions with real files/threads and real export state guard."""
import ast
import asyncio
import contextlib
import copy
import hashlib
import json
import logging
import os
import pathlib
import re
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sources = json.load(sys.stdin)

def extract(filename, names):
    tree = ast.parse(Path(__file__).with_name(filename).read_text())
    nodes = [n for n in tree.body if isinstance(n, (ast.ClassDef, ast.FunctionDef)) and n.name in names]
    exec(compile(ast.Module(body=nodes, type_ignores=[]), filename, 'exec'), globals())

extract('test_stata_detector_state.py', {'Backend'})
extract('test_stata_export_state.py', {'ExportBackend', 'error', 'leaves', 'restored'})

async def run_sync(fn):
    return fn()

def implementation(source, name):
    namespace = dict(contextlib=contextlib, threading=threading, time=time, re=re,
                     uuid=uuid, shlex=shlex, os=os, pathlib=pathlib, subprocess=subprocess,
                     logger=logging.getLogger('bulk-cache'), is_windows=lambda: False,
                     GraphExport=lambda **kw: SimpleNamespace(**kw), GraphExportResponse=lambda **kw: SimpleNamespace(**kw),
                     register_temp_file=lambda path: None, register_temp_dir=lambda path: None,
                     anyio=SimpleNamespace(to_thread=SimpleNamespace(run_sync=run_sync), sleep=asyncio.sleep), json=json)
    exec(compile('from __future__ import annotations\n' + source, '<bulk-cache>', 'exec'), namespace)
    namespace['StataClient'] = namespace[name]
    return namespace[name], namespace

Client, scope = implementation(sources['candidate'], 'Client')
Old, old_scope = implementation(sources['original'], 'Client')
Detector, _ = implementation(sources['detector'], 'Detector')
Client._cache_init_lock = Old._cache_init_lock = threading.Lock()

class CacheBackend(ExportBackend):
    MAX_CACHE_SIZE = 100
    MAX_CACHE_BYTES = 100000

    def list_graphs(self, **kwargs):
        assert self._exec_lock._is_owned()
        if self.inventory_error:
            raise self.inventory_error
        return list(self.names)

    def _get_graph_signature(self, name):
        with self._exec_lock:
            if not self._initialized or self._is_executing:
                raise RuntimeError('backend unavailable')
            if self.signature_error:
                raise self.signature_error
            return name + '_same-second'

    def invalidate_list_graphs_cache(self):
        # The real inventory method acquires this lock itself; callers need not.
        with self._exec_lock:
            pass

    def _sanitize_filename(self, name):
        return re.sub(r'\W', '_', name)

    def _get_graph_command_line(self, name):
        return 'graph command'

    def _command_contains_graph_command(self, *args):
        return True

cases, controls, clients = [], [], []
with tempfile.TemporaryDirectory(prefix='stata-bulk-cache-') as tmp:
    root = Path(tmp)
    scope['get_writable_temp_dir'] = old_scope['get_writable_temp_dir'] = lambda: tmp

    def fresh(cls=Client):
        b = type('TestClient', (cls, CacheBackend), {})()
        b.target, b.current_graph = root / 'untouched.svg', 'g1'
        b._is_executing, b.output_mode, b.target_change = False, 'normal', False
        b.outputs, b.ignored_displays = [], set()
        b._graph_detector = Detector(b)
        b._command_idx, b.names = 1, ['g1', 'g2']
        b.signature_error = b.inventory_error = None
        b._last_emitted_graph_signatures = {}
        b._initialize_cache()
        clients.append(b)
        return b

    def state(b):
        return copy.deepcopy((b._graph_cache_records, b._preemptive_cache, b._cache_sizes, b._cache_access_times, b._total_cache_size))

    def consistent(b):
        records = b._graph_cache_records
        assert b._total_cache_size == sum(r['size'] for r in records.values())
        assert b._cache_sizes == {n: r['size'] for n, r in records.items()}
        assert b._preemptive_cache == {n: r['path'] for n, r in records.items()}
        assert len(records) <= b.MAX_CACHE_SIZE and b._total_cache_size <= b.MAX_CACHE_BYTES
        for r in records.values():
            data = Path(r['path']).read_bytes()
            assert len(data) == r['size'] and hashlib.sha256(data).hexdigest() == r['sha256']

    b = fresh(); result = b.export_graphs_all()
    assert [g.name for g in result.graphs] == ['g1', 'g2']
    assert [Path(g.file_path).read_bytes() for g in result.graphs] == [b'export:g1', b'export:g2']
    assert b.phase_count['graph export'] == 2
    restored(b); consistent(b); cases.append('bulk-real-export-restores-graph-r-s-rc')
    before_count = b.phase_count['graph export']; second = b.export_graphs_all()
    assert [g.file_path for g in second.graphs] == [g.file_path for g in result.graphs]
    assert b.phase_count['graph export'] == before_count
    cases.append('bulk-cache-hit-does-not-reexport')
    b._command_idx += 1; b.export_graphs_all()
    assert b.phase_count['graph export'] == 4
    cases.append('same-timestamp-new-command-invalidates-cache')
    old_path = b._preemptive_cache['g1']; b.cache_graph_on_creation('g1')
    assert b._preemptive_cache['g1'] != old_path and not Path(old_path).exists()
    assert b.phase_count['graph export'] == 5
    restored(b); consistent(b); cases.append('explicit-creation-same-command-forces-export')

    b = fresh(); b.names = []; assert b.export_graphs_all().graphs == [] and not b.outputs
    cases.append('empty-inventory-no-export')
    b.names = ['g1', 'g1', 'g2']; assert len(b.export_graphs_all().graphs) == 2
    cases.append('deduplicate-batch')
    b = fresh(); b.graphs['g1_hash'] = b.graphs['g1']; b.names = ['g1', 'g1_hash']
    b.export_graphs_all(); consistent(b)
    assert set(b._preemptive_cache) == {'g1', 'g1_hash'}
    cases.append('graph-name-does-not-collide-with-metadata')

    for rc in (1, 111, 198, 693):
        b = fresh(); b.cache_graph_on_creation('g1'); snapshot = state(b)
        b._command_idx += 1
        b.native_errors['graph export:' + str(b.phase_count['graph export'] + 2)] = rc
        exc = error(b.export_graphs_all)
        assert any(getattr(e, 'stata_rc', None) == rc for e in leaves(exc))
        assert state(b) == snapshot and b.phase_count['graph export'] == 3
        assert set(Path(b._preemptive_cache_dir).glob('*.svg')) == {Path(b._preemptive_cache['g1'])}
        restored(b); consistent(b); cases.append('batch-failure-rolls-back-no-retry:' + str(rc))

    for exc in (KeyboardInterrupt('cancel'), OSError('IO'), RuntimeError('failure')):
        b = fresh(); b.cache_graph_on_creation('g1'); snapshot = state(b)
        b.before_errors['graph export:2'] = exc
        assert exc in leaves(error(lambda: b.cache_graph_on_creation('g1')))
        assert state(b) == snapshot and b.phase_count['graph export'] == 2
        restored(b); consistent(b); cases.append('creation-failure-preserves-prior-cache:' + type(exc).__name__)

    for mode in ('missing', 'empty', 'oversize', 'symlink'):
        b = fresh(); b.cache_graph_on_creation('g1'); snapshot = state(b); b.output_mode = mode
        error(lambda: b.cache_graph_on_creation('g1'))
        assert state(b) == snapshot; consistent(b); restored(b)
        cases.append('bad-output-preserves-cache:' + mode)

    for location in ('signature', 'inventory'):
        b = fresh(); exc = PermissionError(location); setattr(b, location + '_error', exc)
        assert error(b.export_graphs_all) is exc and not b.outputs
        cases.append('query-errors-propagate:' + location)
    b = fresh(); b.cache_graph_on_creation('g1'); b.signature_error = PermissionError('signature')
    assert error(lambda: b._get_cached_graph_path('g1')) is b.signature_error
    cases.append('cache-lookup-propagates-signature-failure')

    b = fresh(); b.cache_graph_on_creation('g1'); filename = b._preemptive_cache['g1']
    Path(filename).write_bytes(b'corrupted')
    assert b._get_cached_graph_path('g1') is None
    b.export_graphs_all(); consistent(b); cases.append('same-size-corruption-is-cache-miss')
    with patch('builtins.open', side_effect=PermissionError('read denied')):
        assert isinstance(error(lambda: b._get_cached_graph_path('g1')), PermissionError)
    cases.append('cache-file-permission-error-visible')

    for count, size in ((1, 100000), (100, 9), (0, 0)):
        b = fresh(); b.MAX_CACHE_SIZE, b.MAX_CACHE_BYTES = count, size
        result = b.export_graphs_all(); consistent(b)
        assert all(Path(g.file_path).read_bytes() == ('export:' + g.name).encode() for g in result.graphs)
        cases.append('eviction-keeps-all-returned-paths:' + str((count, size)))
    b = fresh(); b.export_graphs_all(); b.invalidate_graph_cache('g1'); consistent(b)
    assert set(b._preemptive_cache) == {'g2'}
    b.invalidate_graph_cache(); consistent(b); assert b._total_cache_size == 0
    cases.append('invalidation-clears-all-metadata-and-accounting')

    b = fresh(); b.cache_graph_on_creation('g1'); old_path = b._preemptive_cache['g1']
    unlink = Path.unlink
    def fail_old(path, *args, **kwargs):
        if str(path) == old_path:
            raise PermissionError('old-cache-cleanup')
        return unlink(path, *args, **kwargs)
    with patch.object(Path, 'unlink', fail_old):
        exc = error(lambda: b.cache_graph_on_creation('g1'))
    assert isinstance(exc, PermissionError) and b._preemptive_cache['g1'] != old_path
    consistent(b); cases.append('post-commit-cleanup-failure-visible-with-consistent-new-cache')

    # Force the old lock inversion schedule using real threads and a timed lock.
    b = fresh(); b.cache_graph_on_creation('g1'); entered = threading.Event(); result = []
    original_signature = b._get_graph_signature
    def signature(name):
        entered.set()
        return original_signature(name)
    b._get_graph_signature = signature
    with b._exec_lock:
        worker = threading.Thread(target=lambda: result.append(b._get_cached_graph_path('g1')), daemon=True)
        worker.start(); time.sleep(0.05)
        assert not entered.is_set(), 'reader queried before acquiring execution lock'
        acquired = b._cache_lock.acquire(timeout=1)
        assert acquired, 'reader inverted cache and execution locks'
        b._cache_lock.release()
    worker.join(2); assert not worker.is_alive() and result == [b._preemptive_cache['g1']]
    cases.append('real-thread-reader-exec-cache-lock-order')
    b = fresh(); failures = []
    def create(name):
        try: b.cache_graph_on_creation(name)
        except BaseException as exc: failures.append(exc)
    workers = [threading.Thread(target=create, args=(name,)) for name in ('g1', 'g2', 'g1', 'g2')]
    for worker in workers: worker.start()
    for worker in workers: worker.join(3); assert not worker.is_alive()
    assert not failures; consistent(b); restored(b)
    cases.append('real-thread-concurrent-creation-serializes-and-counts-once')

    async def emit(b):
        async def notify(text):
            raise AssertionError('failure must not emit graph_ready')
        return await b._emit_graph_ready_for_graphs(['g1'], notify_log=notify, task_id='t',
                                                  export_format='pdf', graph_ready_initial=None)
    for rc in (1, 693):
        b = fresh(); b.native_errors['graph export'] = rc
        exc = error(lambda: asyncio.run(emit(b)))
        assert getattr(exc, 'stata_rc', None) == rc and b.phase_count['graph export'] == 1
        assert b._last_emitted_graph_signatures == {}; restored(b)
        cases.append('emitter-native-error-no-six-attempt-fallback:' + str(rc))

    # Negative controls run old methods against the same observable requirements.
    b = fresh(Old); b._get_graph_signature = lambda name: (_ for _ in ()).throw(PermissionError('signature'))
    path = Path(b._preemptive_cache_dir) / 'g1.svg'; path.write_bytes(b'old'); b._preemptive_cache['g1'] = str(path)
    assert b._get_cached_graph_path('g1') is None
    controls.append('legacy-lookup-hides-signature-error')
    b = fresh(Old); b.native_errors['graph export'] = 1
    assert b.cache_graph_on_creation('g1') is False and b.phase_count['graph export'] == 2
    controls.append('legacy-creation-retries-native-cancel')
    b = fresh(Old)
    with b._exec_lock:
        b.native_errors['graph export'] = 693
        result = b.export_graphs_all()
    assert result.graphs == [] and b.phase_count['graph export'] == 6
    controls.append('legacy-bulk-returns-empty-success-after-failure')
    b = fresh(Old); b._total_cache_size = 9; b._cache_sizes['g1'] = 9
    b.invalidate_graph_cache(); assert b._total_cache_size == 9 and b._cache_sizes['g1'] == 9
    controls.append('legacy-invalidation-leaves-accounting-stale')
    for b in clients:
        b._cleanup_cache()

print(json.dumps({'verdict': 'PASS', 'cases': cases, 'negativeControls': controls, 'nativeVerified': False}))
