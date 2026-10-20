"""Real help + detector guard methods, filesystem and threads; Stata is a double."""
import ast
import contextlib
import copy
import json
import logging
import os
import re
import shlex
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

sources = json.load(sys.stdin)
tree = ast.parse(Path(__file__).with_name('test_stata_detector_state.py').read_text())
node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Backend')
exec(compile(ast.Module(body=[node], type_ignores=[]), '<shared-protocol-double>', 'exec'))


def implementation(source, name):
    scope = dict(contextlib=contextlib, threading=threading, time=time, re=re,
                 uuid=uuid, shlex=shlex, os=os, logger=logging.getLogger('help'),
                 smcl_to_markdown=lambda text, **kw: 'markdown:' + text)
    exec(compile('from __future__ import annotations\n' + source, '<candidate>', 'exec'), scope)
    return scope[name], scope


Client, scope = implementation(sources['candidate'], 'Client')
Old, old_scope = implementation(sources['original'], 'Client')
Detector, _ = implementation(sources['detector'], 'Detector')


class HelpBackend(Backend):
    def run(self, code, **kwargs):
        for line in code.splitlines():
            statement = line.strip().removeprefix('capture ').removeprefix('quietly ')
            if statement.startswith('findfile '):
                assert self._exec_lock._is_owned()
                self.calls.append(line)
                if 'findfile' in self.before_errors:
                    raise self.before_errors.pop('findfile')
                self.rc = self.native_errors.get('findfile', 0)
                self.r = {} if self.rc else {'fn': self.filename}
                if 'findfile' in self.after_errors:
                    raise self.after_errors.pop('findfile')
            else:
                super().run(line, **kwargs)

    def getGlobal(self, name):
        if name == 'mcp_help_file':
            return self.filename
        return super().getGlobal(name)

    def _smcl_to_text(self, text):
        return 'plain:' + text


def fresh(filename, cls=Client):
    b = type('TestClient', (cls, HelpBackend), {})()
    b.filename = filename
    b._graph_detector = Detector(b)
    b._is_executing = False
    b.globals['mcp_help_file'] = 'caller'
    return b


def error(call):
    try:
        call()
    except BaseException as exc:
        return exc
    raise AssertionError('expected failure')


def leaves(exc):
    return [item for child in exc.exceptions for item in leaves(child)] if isinstance(exc, BaseExceptionGroup) else [exc]


def restored(b):
    assert b.s == b.saved_s
    assert b.r == {'mean': 3.5, 'names': 'kept'} and b.rc == b.entry
    assert b.scalars == {} and b.holders == {}
    assert all(value == 'caller' for value in b.globals.values())


cases, controls = [], []
with tempfile.TemporaryDirectory(prefix='stata-help-') as tmp:
    filename = str(Path(tmp) / 'regress.sthlp')
    Path(filename).write_text('{smcl} regression 中文')
    for topic in ('regress', '_pctile', 'mi_estimate', '6', 'topic-name'):
        for plain in (True, False):
            b = fresh(filename)
            result = b.get_help(topic, plain_text=plain)
            assert result == ('plain:' if plain else 'markdown:') + '{smcl} regression 中文'
            assert sum('findfile ' in cmd for cmd in b.calls) == 1
            restored(b)
            cases.append('help-restores-entry:' + topic + ':' + str(plain))

    for topic in (None, '', '../foo', 'x;clear', 'x\nclear', 'x\x00', '$evil', '`evil\'', 'x y', 'x"', '中文', 'x' * 129):
        b = fresh(filename)
        assert isinstance(error(lambda: b.get_help(topic)), ValueError)
        assert not b.calls and not b.reads and b.init_calls == 0
        cases.append('reject-unsafe-topic:' + repr(topic))

    for state in ('uninitialized', 'executing', 'no-detector', 'foreign-detector'):
        b = fresh(filename)
        if state == 'uninitialized': b._initialized = False
        if state == 'executing': b._is_executing = True
        if state == 'no-detector': b._graph_detector = None
        if state == 'foreign-detector': b._graph_detector._stata_client = object()
        error(lambda: b.get_help('regress'))
        assert not b.calls and b.init_calls == 0
        cases.append('reject-backend-state:' + state)

    for rc in (601, 198, 1):
        b = fresh(filename); b.native_errors['findfile'] = rc
        if rc == 601:
            assert b.get_help('regress') == "Help file for 'regress' not found."
        else:
            assert error(lambda: b.get_help('regress')).stata_rc == rc
        restored(b)
        cases.append('distinguish-native-rc:' + str(rc))

    for value in ('', None, 123, '\x00'):
        b = fresh(filename); b.read_values['r(fn)'] = value
        error(lambda: b.get_help('regress')); restored(b)
        cases.append('invalid-filename:' + repr(value))

    for where in ('entry', 'query-rc', 'r(fn)'):
        b = fresh(filename); exc = OSError(where); b.read_errors[where] = exc
        assert error(lambda: b.get_help('regress')) is exc
        restored(b)
        if where == 'entry': assert not b.calls
        cases.append('propagate-read-error:' + where)

    for where in ('hold', 'findfile', 'drop', 'restore', 'restore-rc'):
        b = fresh(filename); exc = KeyboardInterrupt(where); b.after_errors[where] = exc
        assert exc in leaves(error(lambda: b.get_help('regress')))
        cases.append('preserve-interruption:' + where)

    for rc in (601, 198):
        b = fresh(filename); b.native_errors['findfile'] = rc
        exc = OSError('restore'); b.before_errors['restore'] = exc
        observed = leaves(error(lambda: b.get_help('regress')))
        assert exc in observed
        if rc == 198: assert any(getattr(e, 'stata_rc', None) == 198 for e in observed)
        cases.append('not-found-cannot-hide-restore-failure:' + str(rc))

    b = fresh(str(Path(tmp) / 'removed.sthlp'))
    assert isinstance(error(lambda: b.get_help('regress')), FileNotFoundError)
    restored(b); cases.append('located-file-disappears-is-error')
    b = fresh(tmp)
    assert isinstance(error(lambda: b.get_help('regress')), IsADirectoryError)
    restored(b); cases.append('unreadable-file-is-error')

    convert = scope['smcl_to_markdown']
    def broken(text, **kwargs): raise ValueError('parser')
    scope['smcl_to_markdown'] = broken
    b = fresh(filename); assert b.get_help('regress').startswith('plain:'); restored(b)
    scope['smcl_to_markdown'] = convert
    cases.append('markdown-fallback-after-successful-file-read')

    # Another owner holds the backend: no Stata/SFI access until it releases.
    b = fresh(filename); started = threading.Event(); result = []
    def worker():
        started.set(); result.append(b.get_help('regress'))
    with b._exec_lock:
        thread = threading.Thread(target=worker); thread.start()
        assert started.wait(2); time.sleep(0.02)
        assert not b.calls and not b.reads
    thread.join(2); assert not thread.is_alive() and len(result) == 1
    restored(b); cases.append('help-serializes-with-real-owner-thread')

    b = fresh(filename, Old); b.get_help('regress')
    assert b.globals['mcp_help_file'] != 'caller' and b.r != {'mean': 3.5, 'names': 'kept'}
    controls.append('old-mutates-global-and-r')
    b = fresh(str(Path(tmp) / 'missing.sthlp'), Old)
    assert 'not found' in b.get_help('regress')
    controls.append('old-located-file-failure-reported-as-absence')
    b = fresh(filename, Old); b.get_help('x;clear')
    assert any('x;clear' in cmd for cmd in b.calls)
    controls.append('old-interpolates-unsafe-topic')
    b = fresh(filename, Old); b._initialized = False
    error(lambda: b.get_help('regress')); assert b.init_calls == 1
    controls.append('old-implicitly-initializes')

print(json.dumps(dict(verdict='PASS', candidateCases=len(cases), negativeControls=len(controls),
                     cases=cases, controls=controls, nativeVerified=False)))
