"""Execute real export/guard methods with real files/threads and a Stata double."""
import ast
import contextlib
import copy
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
tree = ast.parse(Path(__file__).with_name('test_stata_detector_state.py').read_text())
node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Backend')
exec(compile(ast.Module(body=[node], type_ignores=[]), '<shared-protocol-double>', 'exec'))


def implementation(source, name):
    scope = dict(contextlib=contextlib, threading=threading, time=time, re=re,
                 uuid=uuid, shlex=shlex, os=os, pathlib=pathlib, subprocess=subprocess,
                 logger=logging.getLogger('export'), is_windows=lambda: False,
                 register_temp_file=lambda path: None)
    exec(compile('from __future__ import annotations\n' + source, '<export>', 'exec'), scope)
    return scope[name], scope


Client, scope = implementation(sources['candidate'], 'Client')
Old, old_scope = implementation(sources['original'], 'Client')
Detector, _ = implementation(sources['detector'], 'Detector')


class ExportBackend(Backend):
    MAX_GRAPH_BYTES = 1024

    def run(self, code, **kwargs):
        for line in code.splitlines():
            statement = line.strip().removeprefix('capture ').removeprefix('quietly ')
            if not statement.startswith('graph '):
                super().run(line, **kwargs)
                continue
            assert self._exec_lock._is_owned()
            self.calls.append(line)
            parts = shlex.split(statement)
            phase = ' '.join(parts[:2])
            self.phase_count[phase] = self.phase_count.get(phase, 0) + 1
            key = phase + ':' + str(self.phase_count[phase])
            if key in self.before_errors:
                raise self.before_errors.pop(key)
            self.rc = self.native_errors.get(key, self.native_errors.get(phase, 0))
            if not self.rc:
                self.s = {}
                self.r = {'export_scratch': 'changed'}
                if phase == 'graph describe':
                    if self.current_graph is None:
                        self.rc = 111
                    else:
                        self.r = {'fn': self.current_graph}
                elif phase == 'graph display':
                    if parts[2] not in self.graphs:
                        self.rc = 111
                    elif key not in self.ignored_displays:
                        self.current_graph = parts[2]
                elif phase in ('graph export', 'graph save'):
                    output = Path(parts[2].removesuffix(','))
                    self.outputs.append(output)
                    self.writes(phase, output)
            if key in self.after_errors:
                raise self.after_errors.pop(key)

    def writes(self, phase, path):
        if self.output_mode == 'missing':
            path.unlink(missing_ok=True)
        elif self.output_mode == 'empty':
            path.write_bytes(b'')
        elif self.output_mode == 'oversize':
            path.write_bytes(b'x' * (self.MAX_GRAPH_BYTES + 1))
        elif self.output_mode == 'symlink':
            path.unlink(missing_ok=True)
            path.symlink_to(self.target)
        else:
            path.write_bytes(('export:' + self.current_graph).encode())
        if self.target_change:
            self.target.write_bytes(b'concurrent owner')

    def _exec_no_capture_silent(self, code, **kwargs):
        if not self._initialized:
            self.init()
        with self._exec_lock:
            self.run(code, echo=False)
            return SimpleNamespace(success=self.rc == 0, rc=self.rc,
                                   error=None if not self.rc else SimpleNamespace(message='native export error'))


def fresh(target, cls=Client):
    b = type('TestClient', (cls, ExportBackend), {})()
    b.target, b.current_graph = target, 'g1'  # g2 is inventory's LAST graph.
    b._is_executing, b.output_mode, b.target_change = False, 'normal', False
    b.outputs, b.ignored_displays = [], set()
    b._graph_detector = Detector(b)
    return b


def error(call):
    try:
        call()
    except BaseException as exc:
        return exc
    raise AssertionError('expected failure')


def leaves(exc):
    return [item for child in exc.exceptions for item in leaves(child)] if isinstance(exc, BaseExceptionGroup) else [exc]


def restored(b, graph='g1'):
    assert b.current_graph == graph, b.current_graph
    assert b.s == b.saved_s
    assert b.r == {'mean': 3.5, 'names': 'kept'} and b.rc == b.entry
    assert b.scalars == {} and b.holders == {}
    assert all(value == 'caller' for value in b.globals.values())


cases, controls = [], []
with tempfile.TemporaryDirectory(prefix='stata-export-') as tmp:
    root = Path(tmp)
    target = root / '原图.pdf'
    scope['get_writable_temp_dir'] = old_scope['get_writable_temp_dir'] = lambda: tmp

    def reset(cls=Client):
        target.write_bytes(b'old output')
        return fresh(target, cls)

    def unchanged():
        assert target.read_bytes() == b'old output'
        assert not list(root.glob('.wb-export-*'))

    for fmt in ('pdf', 'png', 'svg', ' PDF ', None):
        for name in (None, 'g1', 'g2', '用户图'):
            b = reset()
            result = b.export_graph(name, str(target), fmt)
            assert result == str(target)
            assert target.read_bytes() == (b'export:g2' if name == 'g2' else b'export:g1')
            assert b.phase_count['graph export'] == 1
            assert b.phase_count.get('graph display', 0) == (2 if name == 'g2' else 0)
            assert b.outputs[0].parent == target.parent and b.outputs[0] != target
            restored(b)
            cases.append('export-restores-entry:' + str(fmt) + ':' + str(name))

    registered = []
    scope['register_temp_file'] = registered.append
    b = reset(); result = Path(b.export_graph())
    assert result.read_bytes() == b'export:g1' and registered == [result]
    restored(b); result.unlink(); cases.append('generated-output-registered')

    for name in ('', '../g1', 'g1;clear', 'g1\nclear', '$g1', '`g1\'', 'g1"', 'g1 g2', 'x' * 33, 42):
        b = reset(); error(lambda: b.export_graph(name, target))
        assert not b.calls and not b.reads; unchanged()
        cases.append('reject-unsafe-graph:' + repr(name))

    for text in ('bad"dir', 'bad$dir', 'bad`dir', 'bad\ndir', 'bad\rdir'):
        directory = root / text; directory.mkdir()
        b = reset(); error(lambda: b.export_graph('g2', directory / 'out.pdf'))
        assert not b.calls and not b.reads; unchanged()
        cases.append('reject-interpolated-path:' + repr(text))

    # The target basename never enters Stata; even literal macro text is safe.
    literal = root / '$literal`file\'.pdf'
    b = reset(); b.export_graph('g2', literal)
    assert literal.read_bytes() == b'export:g2'; literal.unlink(); restored(b)
    cases.append('literal-target-basename-does-not-enter-Stata')

    for fmt in ('do', 'jpg', 123):
        b = reset(); error(lambda: b.export_graph('g2', target, fmt))
        assert not b.calls; unchanged(); cases.append('reject-format:' + repr(fmt))

    for state in ('uninitialized', 'executing', 'no-detector', 'foreign-detector'):
        b = reset()
        if state == 'uninitialized': b._initialized = False
        if state == 'executing': b._is_executing = True
        if state == 'no-detector': b._graph_detector = None
        if state == 'foreign-detector': b._graph_detector._stata_client = object()
        error(lambda: b.export_graph('g2', target))
        assert not b.calls and b.init_calls == 0; unchanged()
        cases.append('reject-backend-state:' + state)

    for mode in ('missing', 'empty', 'oversize', 'symlink'):
        b = reset(); b.output_mode = mode
        error(lambda: b.export_graph('g2', target)); restored(b); unchanged()
        cases.append('invalid-output-preserves-old-file:' + mode)

    for rc in (1, 111, 198, 693):
        b = reset(); b.native_errors['graph export'] = rc
        assert error(lambda: b.export_graph('g2', target)).stata_rc == rc
        assert b.phase_count['graph export'] == 1
        restored(b); unchanged(); cases.append('no-native-error-retry:' + str(rc))

    for phase in ('graph describe:1', 'graph display:1', 'graph export:1', 'graph display:2', 'graph describe:2'):
        for when in ('before_errors', 'after_errors'):
            b = reset(); exc = KeyboardInterrupt(phase); getattr(b, when)[phase] = exc
            assert exc in leaves(error(lambda: b.export_graph('g2', target)))
            if not (phase == 'graph display:2' and when == 'before_errors'):
                restored(b)
            unchanged(); cases.append('preserve-interruption:' + when + ':' + phase)

    b = reset(); b.current_graph = None
    assert error(lambda: b.export_graph('g2', target)).stata_rc == 111
    assert not b.phase_count.get('graph export'); unchanged()
    cases.append('unknown-entry-graph-prevents-export')

    b = reset(); b.ignored_displays.add('graph display:2')
    assert 'restore the current graph' in str(error(lambda: b.export_graph('g2', target)))
    unchanged(); cases.append('verify-restored-graph-before-publish')

    b = reset(); primary, recovery = KeyboardInterrupt('export'), OSError('restore graph')
    b.after_errors['graph export:1'], b.before_errors['graph display:2'] = primary, recovery
    failures = leaves(error(lambda: b.export_graph('g2', target)))
    assert primary in failures and recovery in failures and len(failures) == 3
    unchanged(); cases.append('aggregate-export-cancellation-and-graph-restoration')

    for where in ('entry', 'query-rc', 'r(fn)'):
        b = reset(); exc = OSError(where); b.read_errors[where] = exc
        assert exc in leaves(error(lambda: b.export_graph('g2', target)))
        restored(b); unchanged(); cases.append('propagate-SFI-read-failure:' + where)

    b = reset(); exc = OSError('result restore'); b.before_errors['restore'] = exc
    assert exc in leaves(error(lambda: b.export_graph('g2', target)))
    unchanged(); cases.append('result-restoration-failure-blocks-publish')

    b = reset(); b.target_change = True
    assert 'destination changed' in str(error(lambda: b.export_graph('g2', target)))
    assert target.read_bytes() == b'concurrent owner'; restored(b)
    assert not list(root.glob('.wb-export-*')); cases.append('preserve-concurrent-destination-change')

    b = reset(); exc = OSError('replace denied')
    with patch.object(os, 'replace', side_effect=exc):
        assert error(lambda: b.export_graph('g2', target)) is exc
    restored(b); unchanged(); cases.append('failed-replace-retains-old-output')

    b = reset(); primary, cleanup = KeyboardInterrupt('export'), OSError('unlink')
    b.after_errors['graph export:1'] = primary
    unlink = Path.unlink
    def failing_unlink(path, *args, **kwargs):
        if path.name.startswith('.wb-export-'): raise cleanup
        return unlink(path, *args, **kwargs)
    with patch.object(Path, 'unlink', failing_unlink):
        failures = leaves(error(lambda: b.export_graph('g2', target)))
    assert primary in failures and cleanup in failures
    assert target.read_bytes() == b'old output'; restored(b)
    for item in root.glob('.wb-export-*'): item.unlink()
    cases.append('aggregate-primary-and-stage-cleanup-errors')

    b = reset(); started = threading.Event(); result = []
    def worker():
        started.set(); result.append(b.export_graph('g2', target))
    with b._exec_lock:
        thread = threading.Thread(target=worker); thread.start()
        assert started.wait(2); time.sleep(0.02)
        assert not b.calls and not b.reads
    thread.join(2); assert not thread.is_alive() and result == [str(target)]
    restored(b); cases.append('serializes-with-real-owner-thread')

    scope['is_windows'] = lambda: True
    exe = root / 'Stata.exe'; exe.write_bytes(b'test-double-only')
    def renderer(args, **kwargs):
        assert kwargs['timeout'] == 30 and Path(args[0]) == exe
        lines = Path(args[-1]).read_text().splitlines()
        output = Path(shlex.split(lines[1])[3].removesuffix(','))
        assert output.parent == root and output != target
        output.write_bytes(b'windows-png')
        return SimpleNamespace(returncode=0, stderr='', stdout='')

    b = reset(); b._stata_exec_path = str(exe)
    with patch.object(subprocess, 'run', renderer): b.export_graph('g2', target, 'png')
    assert target.read_bytes() == b'windows-png'
    assert any('asis replace' in line for line in b.calls)
    assert b.phase_count['graph save'] == 1 and not b.phase_count.get('graph export')
    assert not list(root.glob('wb-graph-*')); restored(b)
    cases.append('windows-external-renderer-asis-and-state-restoration')

    for kind in ('timeout', 'failed-exit', 'missing-executable', 'empty-save', 'cleanup'):
        b = reset(); b._stata_exec_path = str(exe)
        primary = subprocess.TimeoutExpired('Stata', 30)
        if kind == 'missing-executable': b._stata_exec_path = str(root / 'absent.exe')
        if kind == 'empty-save': b.output_mode = 'empty'
        cleanup = OSError('renderer workspace cleanup')
        real_cleanup = tempfile.TemporaryDirectory.cleanup
        def broken_cleanup(directory):
            real_cleanup(directory)
            raise cleanup
        with contextlib.ExitStack() as stack:
            if kind == 'failed-exit':
                runner = stack.enter_context(patch.object(subprocess, 'run', return_value=SimpleNamespace(returncode=7, stderr='render failed', stdout='')))
            else:
                runner = stack.enter_context(patch.object(subprocess, 'run', side_effect=primary))
            if kind == 'cleanup': stack.enter_context(patch.object(tempfile.TemporaryDirectory, 'cleanup', broken_cleanup))
            failure = error(lambda: b.export_graph('g2', target, 'png'))
        if kind in ('timeout', 'cleanup'): assert primary in leaves(failure)
        if kind == 'cleanup': assert cleanup in leaves(failure)
        assert runner.call_count == (0 if kind in ('missing-executable', 'empty-save') else 1)
        restored(b); unchanged(); cases.append('windows-failure-preserves-state-and-output:' + kind)
    scope['is_windows'] = lambda: False

    b = reset(Old); b.export_graph('g2', target)
    assert b.current_graph == 'g2' and b.r != {'mean': 3.5, 'names': 'kept'}
    controls.append('old-leaves-selected-graph-and-results')
    b = reset(Old); b.native_errors['graph display'] = 111
    error(lambda: b.export_graph('g2', target)); assert not target.exists()
    controls.append('old-deletes-existing-output-before-failure')
    b = reset(Old); b.native_errors['graph export'] = 693
    error(lambda: b.export_graph('g2', target)); assert b.phase_count['graph export'] == 2
    controls.append('old-retries-native-export-error')
    b = reset(Old); b._initialized = False
    error(lambda: b.export_graph('g2', target)); assert b.init_calls == 1
    controls.append('old-implicitly-initializes')

print(json.dumps(dict(verdict='PASS', candidateCases=len(cases), negativeControls=len(controls),
                     cases=cases, controls=controls, nativeVerified=False)))
