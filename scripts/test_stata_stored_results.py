"""Execute actual methods with a stateful SFI double; no native Stata claims."""
import copy
import json
import logging
import re
import sys
import threading
import time
import uuid
from types import SimpleNamespace

sources = json.load(sys.stdin)


def implementation(source):
    scope = {'logger': logging.getLogger('stored-results')}
    exec(compile('from __future__ import annotations\n' + source, '<actual-method>', 'exec'), scope)
    return scope['Client']


Client, Old = implementation(sources['candidate']), implementation(sources['original'])
LITERAL = '中文 "quote" $caller `local\'\nsecond line'


class Backend:
    def __init__(self):
        self._exec_lock = threading.RLock()
        self._initialized, self._is_executing, self._last_results = True, False, None
        self.stata = self
        self.entry = self.rc = 459
        self.scalars = {'r': {'N': 23.0, 'missing': 8.98846567431158e307}, 'e': {'rank': 2.0}}
        self.macros = {'r': {'names': LITERAL}, 'e': {'cmd': 'regress'}, 's': {'vars': LITERAL}}
        self.globals = {'mcp_user': LITERAL, 'mcp_r_sc': 'caller-owned'}
        self.calls, self.reads, self.sets = [], [], []
        self.init_calls, self.enumerations = 0, 0
        self.read_errors, self.set_errors, self.run_errors = {}, {}, {}
        self.values, self.native_errors = {}, {}
        self.skip, self.restore_noop, self.set_noop = False, False, False
        self.saved = copy.deepcopy((self.scalars, self.macros, self.globals))
        sys.modules['sfi'] = SimpleNamespace(Scalar=self, Macro=self)

    def init(self):
        self.init_calls += 1
        raise AssertionError('implicit init')

    def inject(self, errors, key):
        if key in errors:
            raise errors.pop(key)

    def getValue(self, name):
        assert self._exec_lock._is_owned()
        self.reads.append(name)
        self.inject(self.read_errors, name)
        if name in self.values: return self.values[name]
        if name == 'c(rc)': return self.rc
        return self.scalars[name[0]][name[2:-1]]

    def getGlobal(self, name):
        assert self._exec_lock._is_owned()
        self.reads.append(name)
        self.inject(self.read_errors, name)
        if name in self.values: return self.values[name]
        if len(name) > 2 and name[1] == '(':
            return self.macros[name[0]].get(name[2:-1], '')
        return self.globals.get(name, '')

    def setGlobal(self, name, value):
        assert self._exec_lock._is_owned()
        self.sets.append((name, value))
        self.inject(self.set_errors, 'before:' + ('query' if value == '!pending!' else 'restore'))
        if not (self.set_noop and value != '!pending!'):
            if value: self.globals[name] = value
            else: self.globals.pop(name, None)
        self.inject(self.set_errors, 'after:' + ('query' if value == '!pending!' else 'restore'))

    def run(self, code, **kwargs):
        assert self._exec_lock._is_owned()
        self.calls.append(code)
        restore = re.fullmatch(r'nobreak \{\ncapture error (\d+)\n\}', code)
        if restore:
            self.inject(self.run_errors, 'restore-before')
            if not self.restore_noop: self.rc = int(restore[1])
            self.inject(self.run_errors, 'restore-after')
            return
        query = re.fullmatch(r'nobreak \{\ncapture quietly global (\w+) : ([res])\((scalars|macros)\)\nglobal (\w+) = _rc\n\}', code)
        if query:
            self.inject(self.run_errors, 'query-before')
            self.enumerations += 1
            scratch, rclass, kind, rc_macro = query.groups()
            assert (rclass, kind) != ('s', 'scalars')
            rc = self.native_errors.get((rclass, kind), 0)
            if not self.skip:
                # Capture errors leave the target macro unchanged, while PyStata
                # can reset c(rc) at the outer boundary. The paired macro survives.
                if rc == 0:
                    source = self.scalars if kind == 'scalars' else self.macros
                    self.globals[scratch] = ' '.join(source[rclass])
                self.globals[rc_macro] = str(rc)
            self.rc = 0
            self.inject(self.run_errors, 'query-after')
            return
        # Model the original method's commands (its literal backslash escapes
        # are deliberately retained in the fixture rather than repaired here).
        if code.startswith('macro define mcp_r_sc'):
            for rclass in 'res':
                self.globals['mcp_' + rclass + '_sc'] = ' '.join(self.scalars.get(rclass, {}))
                self.globals['mcp_' + rclass + '_ma'] = ' '.join(self.macros[rclass])
        elif code.startswith('macro define mcp_m_'):
            for rclass, names in self.macros.items():
                for name, value in names.items():
                    if 'mcp_m_' + rclass + '_' + name in code:
                        self.globals['mcp_m_' + rclass + '_' + name] = value.replace('$caller', 'expanded')
        elif code == 'macro drop mcp_*':
            self.globals = {k: v for k, v in self.globals.items() if not k.startswith('mcp_')}
        elif code.startswith('capture error '): self.rc = int(code.split()[-1]); return
        elif code == 'capture': self.rc = 0; return
        else: raise AssertionError(code)
        self.rc = 0


def fresh(cls=Client):
    return type('TestClient', (cls, Backend), {})()


def error(call):
    try: call()
    except BaseException as exc: return exc
    raise AssertionError('expected failure')


def leaves(exc):
    return [leaf for e in exc.exceptions for leaf in leaves(e)] if isinstance(exc, BaseExceptionGroup) else [exc]


def restored(b):
    assert (b.scalars, b.macros, b.globals) == b.saved
    assert b.rc == b.entry


cases, controls = [], []
for rc in (0, 1, 459, 2147483647):
    b = fresh(); b.rc = b.entry = rc
    result = b.get_stored_results()
    assert result == {key: {**b.scalars.get(key, {}), **b.macros[key]} for key in 'res'}
    assert b.enumerations == 5
    assert all(LITERAL not in code for code in b.calls)
    restored(b)
    result['r']['N'] = -1
    cached = b.get_stored_results(); cached['s']['vars'] = 'changed'
    assert b._last_results['r']['N'] == 23 and b._last_results['s']['vars'] == LITERAL
    assert b.enumerations == 5
    b.scalars['r']['N'] = 42; assert b.get_stored_results(True)['r']['N'] == 42
    assert b.enumerations == 10
    cases.append('literal-results-rc-and-isolated-cache:' + str(rc))

b = fresh(); b.scalars = {'r': {}, 'e': {}}; b.macros = {key: {} for key in 'res'}
b.saved = copy.deepcopy((b.scalars, b.macros, b.globals))
assert b.get_stored_results() == {key: {} for key in 'res'}; restored(b)
cases.append('valid-empty-results')

for state in ('uninitialized', 'executing'):
    b = fresh(); b._last_results = {'r': {'old': 1}}
    if state == 'uninitialized': b._initialized = False
    else: b._is_executing = True
    error(b.get_stored_results)
    assert not b.calls and not b.reads and b.init_calls == 0
    cases.append('reject-state-even-with-cache:' + state)

for value in (None, '', '0', True, -1, 1.2, float('nan'), float('inf'), 2147483648):
    b = fresh(); b.values['c(rc)'] = value; b._last_results = {'r': {'old': 1}}
    error(lambda: b.get_stored_results(True))
    assert not b.calls and not b.sets and b._last_results is None
    cases.append('reject-unknown-entry-rc:' + repr(value))

for name in ('c(rc)', 'r(N)', 'r(names)', 'e(rank)', 'e(cmd)', 's(vars)'):
    b = fresh(); exc = OSError(name); b.read_errors[name] = exc
    assert error(b.get_stored_results) is exc
    restored(b); assert b._last_results is None
    if name == 'c(rc)': assert not b.calls and not b.sets
    cases.append('propagate-read-failure:' + name)

for target in (('r', 'scalars'), ('r', 'macros'), ('e', 'scalars'), ('e', 'macros'), ('s', 'macros')):
    b = fresh(); b.native_errors[target] = 198
    assert error(b.get_stored_results).stata_rc == 198
    restored(b); assert b._last_results is None
    cases.append('capture-native-rc-before-boundary-reset:' + repr(target))

for target in ('query-before', 'query-after', 'restore-before', 'restore-after'):
    b = fresh(); exc = KeyboardInterrupt(target); b.run_errors[target] = exc
    assert exc in leaves(error(b.get_stored_results)); assert b._last_results is None
    assert (b.scalars, b.macros, b.globals) == b.saved
    if target != 'restore-before': assert b.rc == b.entry
    cases.append('preserve-interruption:' + target)

for target in ('before:query', 'after:query', 'before:restore', 'after:restore'):
    b = fresh(); exc = OSError(target); b.set_errors[target] = exc
    assert exc in leaves(error(b.get_stored_results)); assert b._last_results is None
    assert b.rc == b.entry
    if target != 'before:restore': restored(b)
    cases.append('propagate-scratch-write-failure:' + target)

b = fresh(); b.skip = True
error(b.get_stored_results); restored(b); assert b._last_results is None
cases.append('reject-silent-enumeration-noop')
for target in ('restore_noop', 'set_noop'):
    b = fresh(); setattr(b, target, True)
    error(b.get_stored_results); assert b._last_results is None
    cases.append('verify-restoration:' + target)

b = fresh(); one, two = OSError('query'), OSError('cleanup')
b.read_errors['r(N)'] = one; b.run_errors['restore-before'] = two
observed = leaves(error(b.get_stored_results)); assert one in observed and two in observed
assert b._last_results is None; cases.append('retain-primary-and-cleanup-errors')

for name in ('bad;clear', 'bad\n;clear', '$macro', 'x' * 33):
    b = fresh(); b.macros['s'][name] = 'value'
    error(b.get_stored_results); assert b._last_results is None
    assert all(name not in code for code in b.calls)
    cases.append('reject-unsupported-name:' + repr(name))
b = fresh(); b.macros['r']['N'] = 'collision'
error(b.get_stored_results); assert b._last_results is None
cases.append('reject-ambiguous-flat-api-name')

for name, value in (('r(N)', None), ('r(N)', True), ('r(names)', None)):
    b = fresh(); b.values[name] = value
    error(b.get_stored_results); restored(b)
    cases.append('reject-invalid-sfi-value:' + name + ':' + repr(value))

# Force UUID collision to ensure caller globals are restored with literal bytes.
old_uuid = uuid.uuid4
uuid.uuid4 = lambda: SimpleNamespace(hex='a' * 32)
try:
    b = fresh()
    for suffix in ('_n', '_c'): b.globals['_wb_sr_' + 'a' * 20 + suffix] = LITERAL
    b.saved = copy.deepcopy((b.scalars, b.macros, b.globals))
    b.get_stored_results(); restored(b)
    cases.append('restore-colliding-scratch-with-literal-bytes')
    b = fresh(); b.read_errors['_wb_sr_' + 'a' * 20 + '_c'] = OSError('snapshot')
    error(b.get_stored_results); restored(b); assert not b.calls and not b.sets
    cases.append('snapshot-failure-before-write')
finally:
    uuid.uuid4 = old_uuid

# The real execution lock covers cache lookup too, so the caller sees the state
# committed by the current owner rather than an obsolete snapshot.
b = fresh(); b._last_results = {'r': {'old': 1}}
started, observed = threading.Event(), []
def worker():
    started.set(); observed.append(b.get_stored_results())
with b._exec_lock:
    thread = threading.Thread(target=worker); thread.start()
    assert started.wait(2); time.sleep(0.02); assert not observed and not b.reads
    b._last_results = {'r': {'new': 2}}
thread.join(2); assert not thread.is_alive() and observed == [{'r': {'new': 2}}]
cases.append('serialize-cached-read-with-real-owner-thread')

b = fresh(Old); result = b.get_stored_results()
assert 'mcp_user' not in b.globals and result['r']['names'] != LITERAL
controls.append('old-deletes-caller-globals-and-expands-values')
result['r']['N'] = -1; assert b._last_results['r']['N'] == -1
controls.append('old-exposes-mutable-cache')
b = fresh(Old); b.read_errors['r(N)'] = OSError('read')
assert 'N' not in b.get_stored_results()['r']
controls.append('old-swallows-scalar-read-failure')
b = fresh(Old); b.read_errors['e(cmd)'] = OSError('unused')
b.read_errors['mcp_r_sc'] = OSError('names')
assert b.get_stored_results() == {'r': {}, 'e': {}}
controls.append('old-returns-false-empty-success-on-query-failure')
b = fresh(Old); b._initialized = False
error(b.get_stored_results); assert b.init_calls == 1
controls.append('old-implicitly-initializes')

print(json.dumps(dict(verdict='PASS', candidateCases=len(cases), negativeControls=len(controls),
                     cases=cases, controls=controls, nativeVerified=False)))
