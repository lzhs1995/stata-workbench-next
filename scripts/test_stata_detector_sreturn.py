"""Production detector methods and protocol double; NOT native Stata acceptance."""
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
tree = ast.parse(Path(__file__).with_name('test_stata_detector_state.py').read_text())
node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Backend')
exec(compile(ast.Module(body=[node], type_ignores=[]), '<shared-protocol-double>', 'exec'))


def implementation(source):
    scope = dict(contextlib=contextlib, threading=threading, time=time, re=re,
                 uuid=uuid, shlex=shlex, logger=logging.getLogger('sreturn'))
    exec(compile('from __future__ import annotations\n' + source, '<detector>', 'exec'), scope)
    return scope['Detector'], scope


def fresh(key='candidate'):
    cls, scope = implementation(sources[key])
    b = Backend()
    return b, cls(b), scope


def error(call):
    try:
        call()
    except BaseException as exc:
        return exc
    raise AssertionError('expected failure')


def leaves(exc):
    return [item for child in exc.exceptions for item in leaves(child)] if isinstance(exc, BaseExceptionGroup) else [exc]


def restored(b):
    assert b.s == b.saved_s, b.s
    assert b.r == {'mean': 3.5, 'names': 'kept'} and b.rc == b.entry
    assert b.scalars == {} and b.holders == {}
    assert all(value == 'caller' for value in b.globals.values()), b.globals


cases, controls = [], []
entries = [('_get_graph_inventory', ()), ('_get_graph_timestamps', (['g1', 'g2'],)),
           ('_get_current_graphs_from_pystata', ()), ('_get_graph_state_from_pystata', ()),
           ('_detect_graphs_via_pystata', ()), ('detect_graph_modifications', ())]
for key in ('candidate', 'equivalent'):
    for method, args in entries:
        b, d, _ = fresh(key)
        getattr(d, method)(*args)
        restored(b)
        assert not any(b.saved_s['payload'] in code for code in b.calls)
        cases.append(key + ':' + method)

for key in ('previous', 'excised'):
    b, d, _ = fresh(key)
    d._get_graph_inventory()
    assert b.s != b.saved_s
    assert isinstance(error(lambda: restored(b)), AssertionError)
    controls.append(key + ':inventory-loses-s-results')

for phase in ('graph dir, memory', 'graph describe g1', 'graph describe g2'):
    for failure in (RuntimeError('before'), KeyboardInterrupt('before')):
        b, d, _ = fresh()
        b.before_errors[phase] = failure
        assert error(d._get_graph_inventory) is failure
        restored(b)
        cases.append('query-error:' + phase + ':' + type(failure).__name__)
    for rc in (1, 198, 601):
        b, d, _ = fresh()
        b.native_errors[phase] = rc
        assert error(d._get_graph_inventory).stata_rc == rc
        restored(b)
        cases.append('native-error:' + phase + ':' + str(rc))

for where in ('before_errors', 'after_errors'):
    for phase in ('hold', 'prepare-scalar', 'enumerate-s'):
        b, d, _ = fresh()
        failure = OSError(where + ':' + phase)
        getattr(b, where)[phase] = failure
        assert failure in leaves(error(d._get_graph_inventory))
        assert not any('graph ' in call for call in b.calls)
        assert b.s == b.saved_s and b.rc == b.entry
        assert all(value == 'caller' for value in b.globals.values())
        cases.append('incomplete-snapshot:' + where + ':' + phase)

for value in (None, 5, 'bad;clear', 'same same', 'a' * 33, '`macro\''):
    b, d, scope = fresh()
    scope['uuid'] = SimpleNamespace(uuid4=lambda: SimpleNamespace(hex='a' * 32))
    b.read_values['_wb_ds_' + 'a' * 24] = value
    error(d._get_graph_inventory)
    assert not any('graph ' in call for call in b.calls)
    assert b.s == b.saved_s and b.rc == b.entry
    cases.append('invalid-s-name-list:' + repr(value))

for name in ('s(vars)', 's(payload)'):
    b, d, _ = fresh()
    b.read_errors[name] = ValueError(name)
    error(d._get_graph_inventory)
    assert not any('graph ' in call for call in b.calls)
    restored(b)
    cases.append('snapshot-read-error:' + name)

b, d, _ = fresh()
b.s = b.saved_s = {}
d._get_graph_inventory()
restored(b)
cases.append('empty-entry-s-results')

b, d, scope = fresh()
scope['uuid'] = SimpleNamespace(uuid4=lambda: SimpleNamespace(hex='f' * 32))
scratch = '_wb_ds_' + 'f' * 24
b.globals[scratch] = 'caller'
d._get_graph_inventory()
restored(b)
assert b.globals[scratch] == 'caller'
cases.append('scratch-global-collision-restores-original')

for phase in ('clear-s', 'drop', 'restore', 'restore-rc'):
    b, d, _ = fresh()
    failure = RuntimeError(phase)
    b.before_errors[phase] = failure
    assert failure in leaves(error(d._get_graph_inventory))
    assert d._inventory_cache['graphs'] == []
    assert b.s == b.saved_s
    assert b.phase_count.get('restore-rc') == 1
    cases.append('restoration-failure-not-published:' + phase)

for where in ('write_errors', 'write_after_errors', 'ignored_writes'):
    b, d, _ = fresh()
    if where == 'ignored_writes':
        b.ignored_writes.add('s(vars)')
    else:
        getattr(b, where)['s(vars)'] = KeyboardInterrupt('restore s(vars)')
    failure = error(d._get_graph_inventory)
    assert d._inventory_cache['graphs'] == []
    assert b.s['payload'] == b.saved_s['payload'], 'continue restoring other values'
    assert b.rc == b.entry and not b.scalars and not b.holders
    if where == 'ignored_writes':
        assert 'not restored' in str(failure)
    cases.append('SFI-restoration:' + where)

b, d, _ = fresh()
query_failure, restore_failure = KeyboardInterrupt('query'), OSError('s() restoration')
b.after_errors['graph describe g1'] = query_failure
b.write_errors['s(vars)'] = restore_failure
failure = error(d._get_graph_inventory)
assert leaves(failure)[:2] == [query_failure, restore_failure]
assert 's() results were not restored' in str(leaves(failure)[2])
assert b.rc == b.entry and not b.scalars and not b.holders
cases.append('query-interruption-plus-restoration-errors-all-retained')

b, d, scope = fresh()
scope['uuid'] = SimpleNamespace(uuid4=lambda: SimpleNamespace(hex='b' * 32))
scratch = '_wb_ds_' + 'b' * 24
b.globals[scratch] = 'caller'
b.ignored_writes.add(scratch)
assert 'temporary global was not restored' in str(error(d._get_graph_inventory))
assert d._inventory_cache['graphs'] == [] and b.rc == b.entry
cases.append('scratch-restore-mismatch-is-failure')

b, d, _ = fresh()
gate, failures = threading.Barrier(4), []
def worker():
    gate.wait()
    try:
        d._get_graph_inventory()
    except BaseException as exc:
        failures.append(exc)
threads = [threading.Thread(target=worker) for _ in range(3)]
for thread in threads: thread.start()
gate.wait()
for thread in threads: thread.join(2)
assert not failures and all(not t.is_alive() for t in threads)
restored(b)
cases.append('concurrent-probes-serialize-s-snapshot-and-restore')

print(json.dumps(dict(verdict='PASS', nativeVerified=False, scope='offline-sreturn-state',
                     candidateCases=len(cases), cases=cases, negativeControls=controls)))
