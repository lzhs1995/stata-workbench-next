"""Execute frozen streaming methods with real async cancellation and OS threads.

Stata and its scoped state guard are doubles: this cannot certify native restore.
"""
import asyncio
import json
import logging
import os
import pathlib
import re
import sys
import tempfile
import threading
import time
import types
import uuid

import anyio


def leaves(error):
    if isinstance(error, BaseExceptionGroup):
        return [leaf for child in error.exceptions for leaf in leaves(child)]
    return [error]


def load(source, folder):
    owner = [None]

    class LogFile:
        def __init__(self):
            self.name = str(folder / "plain.log")
            self.closed = False
            self.close_count = 0
            owner[0].files.append(self)

        def close(self):
            self.close_count += 1
            self.closed = True
            if owner[0].fail_close:
                raise OSError("close-failure")

    class Tail:
        def __init__(self, **kwargs):
            owner[0].fault("tail")

        def get_value(self):
            return "output"

    class Tee:
        def __init__(self, log, tail):
            owner[0].fault("tee")
            self.log = log

        def close(self):
            owner[0].closed_while_running |= owner[0].worker_live
            self.log.close()

    def register(path):
        owner[0].fault("register")

    ns = dict(asyncio=asyncio, anyio=anyio, get_cancelled_exc_class=anyio.get_cancelled_exc_class,
              os=os, json=json, re=re, time=time, uuid=uuid, pathlib=pathlib,
              tempfile=types.SimpleNamespace(NamedTemporaryFile=lambda **kw: LogFile()),
              TailBuffer=Tail, FileTeeIO=Tee, get_writable_temp_dir=lambda: str(folder),
              register_temp_file=register, _DOT_PROMPT_RE=re.compile(r"^\. "),
              CommandResponse=types.SimpleNamespace, ErrorEnvelope=types.SimpleNamespace,
              logger=logging.getLogger("lifecycle-test"))
    exec(compile("from __future__ import annotations\n" + source, "frozen-stream.py", "exec"), ns)

    class Client(ns["Client"]):
        def __init__(self):
            owner[0] = self
            self.folder = folder
            self.files = []
            self.fail = ""
            self.fail_close = False
            self._initialized = True
            self._is_executing = False
            self._break_requested = False
            self._persistent_log_path = None
            self._persistent_log_name = "_mcp_session"
            self._exec_lock = threading.RLock()
            self.dispatches = 0
            self.break_calls = 0
            self.flushes = 0
            self.worker_live = False
            self.closed_while_running = False
            self.block_worker = False
            self.worker_error = None
            self.worker_return_error = None
            self.worker_rc = 0
            self.started = threading.Event()
            self.release = threading.Event()
            self.finished = threading.Event()
            self.state = {"rc": 498, "r": "caller-results"}
            self.notifications = []
            self.progress_calls = 0
            self._graph_detector = types.SimpleNamespace(_stata_client=self,
                _with_graph_probe_state=self.guarded)
            self.stata = types.SimpleNamespace(run=self.unprotected_run)

        def fault(self, label):
            if self.fail == label:
                raise RuntimeError(label)
            if self.fail == label + "-cancel":
                raise asyncio.CancelledError(label)

        def guarded(self, query):
            assert self._exec_lock._is_owned()
            before = dict(self.state)
            try:
                return query(None, self.flush)
            finally:
                self.state = before

        def flush(self, code):
            self.flushes += 1
            self.state["rc"] = 0
            self.state["r"] = "maintenance"
            self.fault("flush")

        def unprotected_run(self, *args, **kwargs):
            self.state["rc"] = 0
            self.state["r"] = "unprotected"

        def init(self):
            raise AssertionError("unexpected native initialization")

        def _maybe_rewrite_graph_name_in_command(self, code):
            return code

        def _invalidate_macro_cache_if_needed(self, code):
            pass

        def _extract_help_topic(self, code):
            return "regress" if code.startswith("help ") else None

        def get_help(self, topic):
            self.fault("help")
            return "help contents"

        def _init_streaming_graph_cache(self, *args, **kwargs):
            return None

        def _create_smcl_log_path(self):
            self.fault("smcl")
            return str(folder / "stream.smcl")

        def _make_smcl_log_name(self):
            return "_wb_log"

        def _capture_graph_state(self, *args):
            self.fault("capture")
            return None

        def _increment_command_idx(self):
            self.fault("increment")

        async def notify(self, value):
            self.notifications.append(json.loads(value))
            self.fault("notify")

        async def progress(self, *args):
            self.progress_calls += 1
            if self.fail == "progress-first" and self.progress_calls == 1:
                raise RuntimeError("initial-progress")
            self.fault("progress")

        async def _stream_smcl_log(self, *, done, **kwargs):
            self.fault("stream")
            await done.wait()

        def _run_streaming_blocking(self, **kwargs):
            self.dispatches += 1
            self.worker_live = True
            self.started.set()
            try:
                if self.block_worker:
                    assert self.release.wait(8), "test did not release worker"
                if self.worker_error is not None:
                    raise self.worker_error
                return self.worker_rc, self.worker_return_error
            finally:
                self.worker_live = False
                self.finished.set()

        def _request_break_in(self):
            self.break_calls += 1
            self.fault("break")

        def _request_break_in_fast(self):
            self._request_break_in()

        async def _wait_for_stata_stop(self):
            return False  # A poll result is not actual OS thread completion.

        def _maybe_reload_startup_after_command(self, *args):
            pass

        def _maybe_reload_startup_after_do_file(self):
            pass

        def _read_smcl_file(self, *args, **kwargs):
            return "output"

        def _clean_internal_smcl(self, text, **kwargs):
            return text

        def _build_combined_log(self, *args, **kwargs):
            return "output"

        def _extract_error_from_smcl(self, *args):
            return "execution failed", "context"

        _extract_error_and_context = _extract_error_from_smcl

        def _resolve_do_file_path(self, path, cwd):
            return path, "do " + path, None

        def _count_do_file_lines(self, path):
            return 1

    return Client


async def invoke(client, mode="command", **kwargs):
    if mode == "command":
        return await client.run_command_streaming(kwargs.pop("code", "display 1"),
            notify_log=client.notify, notify_progress=client.progress, **kwargs)
    return await client.run_do_file_streaming(str(client.folder / "job.do"),
        notify_log=client.notify, notify_progress=client.progress, **kwargs)


async def until(predicate):
    with anyio.fail_after(3):
        while not predicate():
            await anyio.sleep(0.002)


async def run(data, folder):
    Current, Old = load(data["candidate"], folder), load(data["original"], folder)
    Split = load(data["splitCandidate"], folder)
    passed, negatives = [], []
    for mode in ("command", "dofile"):
        c = Current()
        result = await invoke(c, mode)
        assert result.success and c.dispatches == 1 and c.files[0].close_count == 1
        passed.append(mode + ":success")
        for failure in ("smcl", "capture", "increment", "notify", "notify-cancel"):
            c = Current(); c.fail = failure
            try:
                await invoke(c, mode)
            except BaseException as error:
                assert failure.replace("-cancel", "") in str(error)
            else:
                raise AssertionError("preparation failure returned success")
            assert c.dispatches == 0 and c.files[0].closed and c.files[0].close_count == 1
            passed.append(mode + ":prepare:" + failure)
        c = Current(); c.fail = "capture"; c.fail_close = True
        try:
            await invoke(c, mode)
        except BaseExceptionGroup as error:
            assert {str(e) for e in leaves(error)} == {"capture", "close-failure"}
        else:
            raise AssertionError("lost preparation/cleanup errors")
        passed.append(mode + ":prepare-and-close-errors")

        for failure in ("", "flush", "stat", "name", "guard", "busy"):
            c = Current(); c._persistent_log_path = str(folder / "persistent.smcl")
            before = dict(c.state)
            if failure == "stat": c._persistent_log_path += ".missing"
            if failure == "name": c._persistent_log_name = "_log; display 1"
            if failure == "guard": c._graph_detector = None
            if failure == "busy": c._is_executing = True
            c.fail = failure
            try:
                result = await invoke(c, mode)
                assert not failure and result.success
            except (RuntimeError, ValueError, FileNotFoundError):
                assert failure and c.dispatches == 0
            assert c.state == before and c.files[0].closed
            if not failure: assert c.flushes == 1
            passed.append(mode + ":persistent:" + (failure or "state-preserved"))

        for rc in (0, 498):
            c = Current(); c.fail = "stream"; c.worker_rc = rc
            result = await invoke(c, mode)
            assert not result.success and result.rc == (rc or 1) and c.dispatches == 1
            assert c.files[0].closed
            passed.append(mode + ":stream-failure-rc:" + str(rc))
        c = Current(); c.worker_error = TypeError("business-type-error")
        result = await invoke(c, mode)
        assert not result.success and c.dispatches == 1
        passed.append(mode + ":type-error-dispatched-once")
        c = Current(); c.fail = "progress-first"
        result = await invoke(c, mode)
        assert not result.success and c.dispatches == 0 and c.files[0].closed
        assert c.progress_calls == 2
        passed.append(mode + ":progress-prevents-dispatch")
        c = Current(); c.fail = "progress"
        try:
            await invoke(c, mode)
        except RuntimeError as error:
            assert str(error) == "progress"
        else:
            raise AssertionError("final progress failure was swallowed")
        assert c.progress_calls == 2 and c.dispatches == 0 and c.files[0].closed
        passed.append(mode + ":persistent-progress-failure-propagates")

        for double_cancel, worker_failure, break_failure, close_failure, returned in (
                (False, False, False, False, False),
                (True, False, False, False, False),
                (True, True, False, False, False),
                (True, True, True, False, False),
                (True, True, True, True, False),
                (True, True, True, True, True)):
            c = Current(); c.block_worker = True
            worker_error = TypeError("worker-failed-after-cancel")
            if worker_failure:
                if returned: c.worker_return_error = worker_error
                else: c.worker_error = worker_error
            if break_failure: c.fail = "break"
            c.fail_close = close_failure
            task = asyncio.create_task(invoke(c, mode))
            await until(c.started.is_set)
            task.cancel()
            await until(lambda: c.break_calls == 1)
            if double_cancel: task.cancel()
            await asyncio.sleep(0.02)
            assert not task.done() and not c.files[0].closed and c.worker_live
            c.release.set()
            try:
                await task
            except BaseException as error:
                assert any(isinstance(e, asyncio.CancelledError) for e in leaves(error))
                if worker_failure: assert worker_error in leaves(error), repr(error)
                if break_failure: assert any(str(e) == "break" for e in leaves(error)), repr(error)
                if close_failure: assert any(str(e) == "close-failure" for e in leaves(error)), repr(error)
            else:
                raise AssertionError("cancellation returned success")
            assert c.finished.is_set() and c.files[0].closed and not c.closed_while_running
            assert c.dispatches == 1 and c.break_calls == 1
            assert c.files[0].close_count == 1
            passed.append(f"{mode}:asyncio-cancel:{double_cancel}:{worker_failure}:{break_failure}:{close_failure}:{returned}")

        c = Current(); c.block_worker = True
        async with anyio.create_task_group() as group:
            group.start_soon(invoke, c, mode)
            await until(c.started.is_set)
            group.cancel_scope.cancel()
            with anyio.CancelScope(shield=True):
                await until(lambda: c.break_calls == 1)
                assert not c.files[0].closed and c.worker_live
                c.release.set()
        assert c.finished.is_set() and c.files[0].closed and not c.closed_while_running
        passed.append(mode + ":anyio-cancel-drained")

        old = Old(); old.fail = "capture"
        try: await invoke(old, mode)
        except RuntimeError: pass
        assert old.dispatches == 0 and not old.files[0].closed
        old.files[0].close()
        negatives.append(mode + ":old-preparation-leak")
        old = Old(); old.fail = "stream"
        result = await invoke(old, mode)
        assert result.success
        negatives.append(mode + ":old-stream-failure-success")
        old = Old(); old.worker_error = TypeError("business-type-error")
        result = await invoke(old, mode)
        assert not result.success and old.dispatches == 2
        negatives.append(mode + ":old-type-error-double-dispatch")
        split = Split(); split.block_worker = True
        split.worker_error = TypeError("lost-worker-error")
        task = asyncio.create_task(invoke(split, mode))
        await until(split.started.is_set)
        task.cancel()
        await until(lambda: split.break_calls == 1)
        split.release.set()
        try:
            await task
        except BaseException as error:
            assert any(isinstance(e, asyncio.CancelledError) for e in leaves(error))
            assert split.worker_error not in leaves(error)
        else:
            raise AssertionError("negative control did not cancel")
        assert split.finished.is_set() and split.files[0].closed
        negatives.append(mode + ":split-group-loses-worker-error")

    for failure in ("register", "tail", "tee"):
        c = Current(); c.fail = failure
        try: c._create_streaming_log(trace=False)
        except RuntimeError as error: assert str(error) == failure
        else: raise AssertionError("factory failure not propagated")
        assert c.files[0].closed
        passed.append("factory:" + failure)
        c = Current(); c.fail = failure; c.fail_close = True
        try: c._create_streaming_log(trace=False)
        except BaseExceptionGroup as error:
            assert {str(e) for e in leaves(error)} == {failure, "close-failure"}
        else: raise AssertionError("factory lost creation/close errors")
        assert c.files[0].close_count == 1
        passed.append("factory-and-close:" + failure)
    c = Current(); c.fail = "help"
    try: await invoke(c, code="help regress")
    except RuntimeError as error: assert str(error) == "help"
    else: raise AssertionError("help failure returned success")
    assert not c.files and c.dispatches == 0
    passed.append("early-help-failure")
    c = Current(); result = await invoke(c, code="help regress")
    assert result.success and c.dispatches == 0 and c.notifications[0]["event"] == "help_ready"
    passed.append("early-help-success")
    old = Old(); old.fail = "help"
    assert (await invoke(old, code="help regress")).success
    negatives.append("old-early-help-failure-success")
    old = Old(); old._persistent_log_path = str(folder / "persistent.smcl")
    before = dict(old.state); await invoke(old, "dofile")
    assert old.state != before
    negatives.append("old-persistent-flush-clobbers-state")
    return dict(verdict="PASS", candidateCases=len(passed), cases=passed,
                negativeControls=negatives, nativeVerified=False)


data = json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix="stata-lifecycle-") as temp:
    folder = pathlib.Path(temp)
    (folder / "job.do").write_text("display 1\n")
    (folder / "persistent.smcl").write_text("existing log\n")
    print(json.dumps(anyio.run(run, data, folder)))
