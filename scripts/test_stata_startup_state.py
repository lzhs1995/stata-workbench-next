"""Actual startup methods composed with the actual results guard, offline only."""
import ast
import copy
import json
import logging
import os
import re
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
exec(compile(ast.Module(body=[node], type_ignores=[]), '<shared-SFI-double>', 'exec'))


def implementation(source, name):
    scope = dict(os=os, re=re, uuid=uuid, logger=logging.getLogger('startup'))
    exec(compile('from __future__ import annotations\n' + source, '<startup>', 'exec'), scope)
    return scope[name]


Client = implementation(sources['candidate'], 'Client')
Old = implementation(sources['original'], 'Client')
Detector = implementation(sources['detector'], 'Detector')


class StartupBackend(Backend):
    def __init__(self):
        super().__init__()
        self._graph_detector = Detector(self)
        self._reload_startup_on_clear = False
        self._profile_do_checked = False
        self._profile_do_dirs = []
        self._sysprofile_do_path = self._profile_do_path = None
        self._global_macro_cache = {}
        self.programs = {'_mcp_startup_sentinel': 'caller program'}
        self.engine_initializations = 0
        self.do_calls, self.do_failure, self.define_failure = [], None, None
        self.define_noop, self.restore_noop = False, False
        self.locals = {}
        self.directories = {key: '' for key in ('sysdir_stata', 'pwd', 'sysdir_personal',
                                                'sysdir_site', 'sysdir_plus', 'sysdir_oldplace', 'adopath')}
        self.saved_globals = copy.deepcopy(self.globals)

    def getGlobal(self, name):
        assert self._exec_lock._is_owned()
        if name.startswith('c(') and name not in self.read_errors and name not in self.read_values:
            return self.directories[name[2:-1]]
        return super().getGlobal(name)

    def getLocal(self, name):
        assert self._exec_lock._is_owned()
        if name in self.read_errors: raise self.read_errors.pop(name)
        return self.locals.get(name, '')

    def _normalize_macro_value(self, value):
        return value.strip() or None

    def _normalize_startup_path(self, path):
        return os.path.realpath(path)

    def _parse_startup_do_files(self, raw):
        return raw.split(os.pathsep), 0

    def _stata_quote(self, value):
        return '"' + value + '"'

    def _code_drops_programs(self, code):
        return code == 'clear all'

    def _should_probe_startup_sentinel_after_command(self, code):
        return code.startswith('$')

    def _resolve_indirect_macro_command(self, code):
        return 'display 1'  # deliberately stale cache for the negative control

    def run(self, code, **kwargs):
        assert self._exec_lock._is_owned()
        if code.startswith(('noisily do ', 'capture noisily do ')):
            self.calls.append(code)
            self.do_calls.append(code.split('do ', 1)[1].strip('"'))
            self.r = {'startup': 'intentional'}
            self.rc = 198 if self.do_failure else 0
            if self.do_failure and not code.startswith('capture '): raise self.do_failure
            return
        if code.startswith('program define '):
            self.calls.append(code)
            if self.define_failure: raise self.define_failure
            match = re.fullmatch(r'program define (_wb_start_[a-f0-9]{22})\n    version 16\nend', code)
            assert match, 'program definitions must be direct complete multiline input'
            if not self.define_noop: self.programs[match[1]] = 'version 16'
            self.rc = 0
            return
        match = re.fullmatch(r'capture quietly program list (\w+)\nscalar (\w+) = _rc\n', code)
        if match:
            self.calls.append(code)
            name, scalar = match.groups()
            self.scalars[scalar] = self.native_errors.get('program list', 0 if name in self.programs else 111)
            self.rc = 0  # model PyStata's outer return boundary
            return
        if self.restore_noop and code.startswith('nobreak {\ncapture error '):
            self.calls.append(code)
            return
        return super().run(code, **kwargs)


def fresh(cls=Client):
    return type('TestClient', (cls, StartupBackend), {})()


def error(call):
    try: call()
    except BaseException as exc: return exc
    raise AssertionError('expected error')


def leaves(exc):
    return [leaf for e in exc.exceptions for leaf in leaves(e)] if isinstance(exc, BaseExceptionGroup) else [exc]


def restored(b):
    assert b.r == {'mean': 3.5, 'names': 'kept'}
    assert b.s == b.saved_s and b.rc == b.entry
    assert b.globals == b.saved_globals and not b.scalars and not b.holders


cases, controls = [], []
with patch.dict(os.environ, {}, clear=False), tempfile.TemporaryDirectory() as tmp:
    os.environ.pop('MCP_STATA_STARTUP_DO_FILE', None)
    root = Path(tmp)
    configured, sysprofile, profile = [root / n for n in ('configured.do', 'sysprofile.do', 'profile.do')]
    for file in (configured, sysprofile, profile): file.write_text('* offline fixture\n')
    b = fresh(); b.directories['pwd'] = tmp
    os.environ['MCP_STATA_STARTUP_DO_FILE'] = os.pathsep.join(map(str, (configured, configured, sysprofile)))
    b._load_startup_do_file()
    assert b.do_calls == list(map(str, (configured, sysprofile, profile)))
    assert all(code.startswith('noisily do ') for code in b.calls)
    cases.append('configured-sysprofile-profile-order-and-deduplication')

    for cls, bucket in ((Client, cases), (Old, controls)):
        b = fresh(cls); b.do_failure = RuntimeError('native r(198)')
        os.environ['MCP_STATA_STARTUP_DO_FILE'] = str(configured)
        if cls is Client:
            assert error(b._load_startup_do_file) is b.do_failure
            assert b.do_calls == [str(configured)] and not b._profile_do_checked
            bucket.append('native-do-failure-stops-load')
        else:
            b._collect_profile_do_dirs = lambda: []
            b._load_startup_do_file()
            bucket.append('old-capture-hides-native-do-failure')

    for bad in (str(root / 'missing.do'), str(root / '$unknown.do'), str(root / 'bad`macro.do'), str(root / 'bad"quote.do')):
        b = fresh(); os.environ['MCP_STATA_STARTUP_DO_FILE'] = bad
        error(b._load_startup_do_file)
        assert not b.calls
        cases.append('reject-invalid-or-missing-file:' + Path(bad).name)

    os.environ.pop('MCP_STATA_STARTUP_DO_FILE')
    b = fresh(); b.directories['pwd'] = tmp
    b.read_errors['c(adopath)'] = OSError('SFI read')
    error(b._prime_profile_do_cache)
    assert not b._profile_do_checked and b._profile_do_dirs == []
    b._prime_profile_do_cache()
    assert b._sysprofile_do_path == str(sysprofile) and b._profile_do_path == str(profile)
    assert not b.calls and b.globals == b.saved_globals
    cases.append('failed-directory-query-does-not-poison-cache')

    b = fresh(); b.directories['pwd'] = tmp
    real_stat = os.stat
    def stat_failure(path, *args, **kwargs):
        if os.fspath(path) == str(profile): raise PermissionError('profile access')
        return real_stat(path, *args, **kwargs)
    with patch('os.stat', stat_failure): assert isinstance(error(b._prime_profile_do_cache), PermissionError)
    assert not b._profile_do_checked and b._sysprofile_do_path is None
    cases.append('profile-stat-error-does-not-publish-partial-search')

    b = fresh(Old); b._collect_profile_do_dirs = lambda: (_ for _ in ()).throw(OSError('read'))
    b._prime_profile_do_cache(); assert b._profile_do_checked
    controls.append('old-directory-failure-commits-empty-cache')

    for failure in (RuntimeError('startup'), KeyboardInterrupt('interrupted'), FileNotFoundError('missing')):
        b = fresh(); b._initialized = False
        def fail(): raise failure
        b._load_startup_do_file = fail
        assert error(b.init) is failure and not b._initialized
        for _ in range(2): assert error(b.init).__cause__ is failure
        assert b.engine_initializations == 1
        cases.append('partial-init-latches-without-replay:' + type(failure).__name__)
    b = fresh(); b._initialized = False
    b.init(); b.init(); assert b.engine_initializations == 1 and b._initialized
    cases.append('successful-init-is-idempotent')
    b = fresh(Old); b._initialized = False
    b._load_startup_do_file = lambda: (_ for _ in ()).throw(RuntimeError('startup'))
    error(b.init); b.init(); assert b._initialized and b.engine_initializations == 1
    controls.append('old-partial-init-silently-reports-ready')

    b = fresh(); b._reload_startup_on_clear = True
    b._install_startup_sentinel(); name = b._startup_sentinel_name
    assert len(name) == 32 and b._startup_sentinel_alive()
    b._install_startup_sentinel()
    assert len(b.programs) == 2 and b.programs['_mcp_startup_sentinel'] == 'caller program'
    assert sum(c.startswith('program define ') for c in b.calls) == 1
    restored(b); cases.append('unique-program-preserves-caller-and-results-through-real-guard')
    del b.programs[name]; assert not b._startup_sentinel_alive(); restored(b)
    cases.append('only-native-111-means-absent')
    for rc in (1, 198, 601):
        b.native_errors['program list'] = rc
        assert error(b._startup_sentinel_alive).stata_rc == rc
        restored(b); cases.append('sentinel-probe-error-propagates:' + str(rc))

    for field in ('define_failure', 'define_noop'):
        b = fresh(); setattr(b, field, RuntimeError('define') if field == 'define_failure' else True)
        error(b._install_startup_sentinel); restored(b)
        assert len(b.programs) == 1
        cases.append('failed-or-noop-definition-is-not-ready:' + field)
    b = fresh(); b.before_errors['restore'] = RuntimeError('restore')
    error(b._install_startup_sentinel)
    assert b._startup_sentinel_name in b.programs
    cases.append('successful-definition-tracked-despite-restoration-error')
    with patch('uuid.uuid4', lambda: SimpleNamespace(hex='a' * 32)):
        b = fresh(); name = '_wb_start_' + 'a' * 22; b.programs[name] = 'caller collision'
        error(b._install_startup_sentinel)
        assert b.programs[name] == 'caller collision' and not any(c.startswith('program define ') for c in b.calls)
        restored(b); cases.append('sentinel-collision-refuses-without-dropping-caller')

    for failure in (None, RuntimeError('do'), KeyboardInterrupt('do')):
        b = fresh(); b.do_failure = failure
        os.environ['MCP_STATA_STARTUP_DO_FILE'] = str(configured)
        if failure: assert error(b._reload_startup_do_files) is failure
        else: b._reload_startup_do_files()
        assert b.rc == b.entry and b.r == {'startup': 'intentional'}
        cases.append('reload-retains-script-effects-and-entry-rc:' + type(failure).__name__)
    b = fresh(); b.do_failure = RuntimeError('do'); b.before_errors['restore-rc'] = OSError('restore')
    found = leaves(error(b._reload_startup_do_files))
    assert b.do_failure in found and any(isinstance(e, OSError) for e in found)
    cases.append('reload-aggregates-primary-and-restoration-errors')
    b = fresh(); b.restore_noop = True
    assert 'not restored' in str(error(b._reload_startup_do_files))
    cases.append('reload-detects-silent-rc-restoration-failure')
    os.environ.pop('MCP_STATA_STARTUP_DO_FILE')

for method in ('_probe_global_macro', '_probe_local_macro'):
    b = fresh(); b.read_errors['example'] = OSError('macro')
    assert isinstance(error(lambda: getattr(b, method)('example')), OSError)
    assert not b.calls
    cases.append('macro-read-error-propagates:' + method)
b = fresh(); b._global_macro_cache['example'] = 'stale'
assert b._probe_global_macro('example') is None and 'example' not in b._global_macro_cache
cases.append('empty-global-invalidates-stale-cache')
b = fresh(Old); b._global_macro_cache['example'] = 'stale'
assert b._probe_global_macro('example') is None and b._global_macro_cache['example'] == 'stale'
controls.append('old-empty-global-retains-stale-cache')

for cls, expected in ((Client, 1), (Old, 0)):
    b = fresh(cls); b._reload_startup_on_clear = True; reloads = []
    b._startup_sentinel_alive = lambda: False
    b._reload_startup_do_files = lambda: reloads.append(True)
    b._maybe_reload_startup_after_command('$indirect')
    assert len(reloads) == expected
    (cases if cls is Client else controls).append('macro-indirection-uses-actual-program-state:' + cls.__name__)

# The public initializer holds the real lock while publishing success or failure.
b = fresh(); b._initialized = False
entered, release, completed = threading.Event(), threading.Event(), []
def startup(): entered.set(); assert release.wait(2)
b._load_startup_do_file = startup
def worker(): b.init(); completed.append(True)
one = threading.Thread(target=worker); one.start(); assert entered.wait(2)
two = threading.Thread(target=worker); two.start(); time.sleep(0.02)
assert not completed; release.set(); one.join(2); two.join(2)
assert completed == [True, True] and b.engine_initializations == 1
cases.append('concurrent-init-waits-for-startup-publication')

print(json.dumps(dict(verdict='PASS', nativeVerified=False, candidateCases=len(cases),
                     negativeControls=len(controls), cases=cases, controls=controls)))
