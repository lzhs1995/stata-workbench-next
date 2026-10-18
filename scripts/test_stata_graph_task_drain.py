"""Execute frozen methods with real asyncio/AnyIO tasks and real blocked threads.

Only Stata, file output and notifications are doubles. No runtime import or POST.
"""
import asyncio
import json
import logging
import os
import re
import sys
import threading
import time
import types

import anyio

SOURCE = json.load(sys.stdin)
REPORT = []
LOGGER = logging.getLogger("graph-drain-test")
LOGGER.addHandler(logging.NullHandler())


def load_class(source, name):
    namespace = dict(asyncio=asyncio, anyio=anyio, time=time, os=os, re=re,
                     json=json, logger=LOGGER, CommandResponse=types.SimpleNamespace,
                     ErrorEnvelope=types.SimpleNamespace,
                     get_cancelled_exc_class=anyio.get_cancelled_exc_class,
                     _STANDALONE_RC_RE=re.compile(r"r\((\d+)\)"))
    exec(compile("from __future__ import annotations\nclass " + name + ":\n" + source,
                 "<frozen-graph-methods>", "exec"), namespace)
    return namespace[name]


async def until(predicate):
    with anyio.fail_after(3):
        while not predicate():
            await anyio.sleep(0.001)


async def turns():
    # A bounded scheduling window while the tested worker stays explicitly blocked.
    for _ in range(10):
        await anyio.sleep(0.002)


async def stream_case(candidate, case):
    client = load_class(SOURCE["client" if candidate else "originalClient"], "Client")()
    command_started, command_release, command_finished = (threading.Event() for _ in range(3))
    graph_started, graph_release = asyncio.Event(), asyncio.Event()
    state = dict(graph_calls=0, graph_active=0, graph_finished=0, tee_closed=False,
                 final_cache=0, caught=None)
    client._initialized = True
    client._persistent_log_path = None
    client._maybe_rewrite_graph_name_in_command = lambda code: code
    client._invalidate_macro_cache_if_needed = lambda code: None
    client._extract_help_topic = lambda code: None
    client._init_streaming_graph_cache = lambda *a, **k: object()
    tail = types.SimpleNamespace(get_value=lambda: "ok")
    tee = types.SimpleNamespace(close=lambda: state.update(tee_closed=True))
    client._create_streaming_log = lambda **kw: (None, "offline.log", tail, tee)
    client._create_smcl_log_path = lambda: "offline.smcl"
    client._make_smcl_log_name = lambda: "offline"
    client._capture_graph_state = lambda *a: {}
    client._increment_command_idx = lambda: None
    client._maybe_reload_startup_after_command = lambda code: None
    client._read_smcl_file = lambda *a, **k: "ok"
    client._clean_internal_smcl = lambda text, **k: text
    client._build_combined_log = lambda *a, **k: "ok"
    client._parse_rc_from_smcl = lambda *a: None
    client._parse_rc_from_text = lambda *a: None
    client._smcl_to_text = lambda text: text
    client._extract_error_from_smcl = lambda *a: ("failure", "offline graph failure")
    client._extract_error_and_context = client._extract_error_from_smcl

    async def cache_final(*args, **kwargs):
        state["final_cache"] += 1

    async def graph(**kwargs):
        state["graph_calls"] += 1
        state["graph_active"] += 1
        graph_started.set()
        try:
            await graph_release.wait()
            if case == "graph-error":
                raise ValueError("injected graph error")
        finally:
            state["graph_active"] -= 1
            state["graph_finished"] += 1

    async def stream(**kwargs):
        for _ in range(500 if case == "flood" else 1):
            await kwargs["on_chunk"]("output")
        await kwargs["done"].wait()

    def command(**kwargs):
        command_started.set()
        assert command_release.wait(4), "test failed to release command"
        command_finished.set()
        return 0, None

    async def notify(*args):
        pass

    client._cache_new_graphs = cache_final
    client._maybe_cache_graphs_on_chunk = graph
    client._stream_smcl_log = stream
    client._run_streaming_blocking = command
    # Old detached exceptions must be consumed, including the negative control.
    loop = asyncio.get_running_loop()
    previous = loop.get_exception_handler()
    unhandled = []
    loop.set_exception_handler(lambda loop, context: unhandled.append(context))
    request = asyncio.create_task(client.run_command_streaming(
        "display 1", notify_log=notify, auto_cache_graphs=True))
    try:
        await until(lambda: command_started.is_set() and graph_started.is_set())
        await turns()
        if candidate:
            assert state["graph_calls"] == 1, state
        elif case == "flood":
            assert state["graph_calls"] == 500, state
        if case == "graph-error":
            graph_release.set()
            await until(lambda: state["graph_active"] == 0)
            assert not command_finished.is_set()
            assert not request.done(), "graph failure interrupted the user's command"
        command_release.set()
        await until(command_finished.is_set)
        if case != "graph-error":
            # The original returns after its stream watcher finishes, despite the graph.
            if candidate:
                await anyio.sleep(0.15)
                assert not request.done(), "response escaped its pending graph check"
                assert not state["tee_closed"]
            else:
                await until(request.done)
                assert state["graph_active"] > 0
            graph_release.set()
        result = await request
        await until(lambda: state["graph_active"] == 0)
        assert state["tee_closed"] and state["final_cache"] == 1
        assert result.success == (case != "graph-error" or not candidate), result
        if candidate and case == "graph-error":
            assert result.rc != 0
        if candidate:
            assert not unhandled, unhandled
        REPORT.append(dict(kind="candidate" if candidate else "legacy-negative",
                           test="stream-" + case, graphCalls=state["graph_calls"]))
    finally:
        command_release.set()
        graph_release.set()
        if not request.done():
            await request
        await until(lambda: state["graph_active"] == 0)
        loop.set_exception_handler(previous)


async def helper_case(mode, worker_error=False):
    cache = load_class(SOURCE["detector"], "Cache")()
    started, release, finished = (threading.Event() for _ in range(3))
    scope_box, outcome = [], []

    def worker():
        started.set()
        try:
            assert release.wait(4)
            if worker_error:
                raise ValueError("worker failed")
            return 42
        finally:
            finished.set()

    async def invoke():
        with anyio.CancelScope() as scope:
            scope_box.append(scope)
            try:
                value = await cache._run_owned_graph_call(worker)
                outcome.append(("value", value))
            except asyncio.CancelledError:
                outcome.append(("cancel", None))
                raise
            except ValueError as error:
                outcome.append(("error", str(error)))

    task = asyncio.create_task(invoke())
    loop = asyncio.get_running_loop()
    previous = loop.get_exception_handler()
    unhandled = []
    loop.set_exception_handler(lambda loop, context: unhandled.append(context))
    try:
        await until(started.is_set)
        if mode == "anyio":
            scope_box[0].cancel()
        elif mode in ("asyncio", "repeated"):
            for _ in range(3 if mode == "repeated" else 1):
                task.cancel()
                await turns()
        await turns()
        assert not task.done() and not finished.is_set() and not outcome
        release.set()
        try:
            await task
        except asyncio.CancelledError:
            assert mode in ("asyncio", "repeated")
        assert finished.is_set()
        expected = "cancel" if mode != "normal" else "error" if worker_error else "value"
        assert len(outcome) == 1 and outcome[0][0] == expected, outcome
        if expected == "value":
            assert outcome[0][1] == 42
        await turns()
        assert not unhandled, unhandled
        REPORT.append(dict(kind="candidate", test="worker-" + mode, workerError=worker_error))
    finally:
        release.set()
        if not task.done():
            try:
                await task
            except asyncio.CancelledError:
                pass
        await until(finished.is_set)
        loop.set_exception_handler(previous)


async def detector_case(candidate, method, phase, mode):
    cache = load_class(SOURCE["detector" if candidate else "originalDetector"], "Cache")()
    started, release, finished = (threading.Event() for _ in range(3))
    cache.auto_cache = True
    cache._cached_graphs = set()
    cache._removed_graphs = set()
    cache._graphs_to_cache = [] if method.endswith("with_pystata") else ["g"]
    cache._lock = threading.Lock()
    worker_count = [0]

    def call(which, result):
        if which == phase:
            worker_count[0] += 1
            started.set()
            assert release.wait(4)
            finished.set()
        return result

    cache.detector = types.SimpleNamespace(_inventory_cache_enabled=False,
        _detect_graphs_via_pystata=lambda: call("detect", ["g"]))
    cache.stata_client = types.SimpleNamespace(
        list_graphs=lambda: call("list", ["g"]),
        cache_graph_on_creation=lambda name: call("cache", True))

    async def callback(*args):
        pass

    cache._notify_cache_callbacks = callback
    scope_box, cancelled, completed = [], [], []

    async def invoke():
        try:
            with anyio.CancelScope() as scope:
                scope_box.append(scope)
                try:
                    await getattr(cache, method)()
                except asyncio.CancelledError:
                    cancelled.append(True)
                    raise
        finally:
            completed.append(True)

    task = asyncio.create_task(invoke())
    try:
        await until(started.is_set)
        if mode == "anyio":
            scope_box[0].cancel()
        else:
            for _ in range(3 if mode == "repeated" else 1):
                task.cancel()
                await turns()
        if candidate:
            await turns()
            assert not completed and not task.done() and not finished.is_set()
            if phase == "detect":
                assert cache.detector._inventory_cache_enabled
        else:
            await until(task.done)
            assert completed and not finished.is_set(), "legacy abandonment not reproduced"
        release.set()
        try:
            await task
        except asyncio.CancelledError:
            assert mode != "anyio"
        await until(finished.is_set)
        assert cancelled and completed and worker_count == [1]
        assert not cache.detector._inventory_cache_enabled
        REPORT.append(dict(kind="candidate" if candidate else "legacy-negative",
                           test=method, phase=phase, cancellation=mode))
    finally:
        release.set()
        if not task.done():
            try:
                await task
            except asyncio.CancelledError:
                pass
        await until(finished.is_set)


async def group_cancel_case(mode):
    cache = load_class(SOURCE["detector"], "Cache")()
    started, release, finished = (threading.Event() for _ in range(3))
    groups, child_cancelled, returned = [], [], []

    def worker():
        started.set()
        assert release.wait(4)
        finished.set()

    async def child():
        try:
            await cache._run_owned_graph_call(worker)
        except asyncio.CancelledError:
            child_cancelled.append(True)
            raise

    async def request():
        try:
            async with anyio.create_task_group() as group:
                groups.append(group)
                group.start_soon(child)
        finally:
            returned.append(True)

    task = asyncio.create_task(request())
    try:
        await until(started.is_set)
        if mode == "anyio":
            groups[0].cancel_scope.cancel()
        else:
            for _ in range(3):
                task.cancel()
                await turns()
        await turns()
        assert not returned and not task.done() and not finished.is_set()
        release.set()
        try:
            await task
        except asyncio.CancelledError:
            assert mode == "repeated"
        assert returned and child_cancelled and finished.is_set()
        REPORT.append(dict(kind="candidate", test="owning-task-group", cancellation=mode))
    finally:
        release.set()
        if not task.done():
            try:
                await task
            except asyncio.CancelledError:
                pass
        await until(finished.is_set)


async def main():
    for candidate in (True, False):
        for case in ("normal", "graph-error", "flood"):
            await stream_case(candidate, case)
    for mode in ("normal", "anyio", "asyncio", "repeated"):
        for failure in (False, True):
            await helper_case(mode, failure)
    for method in ("cache_detected_graphs", "cache_detected_graphs_with_pystata"):
        for phase in (["detect", "list", "cache"] if method.endswith("with_pystata") else ["list", "cache"]):
            for mode in ("anyio", "asyncio", "repeated"):
                await detector_case(True, method, phase, mode)
        for mode in ("anyio", "asyncio"):
            await detector_case(False, method, "cache", mode)
    for mode in ("anyio", "repeated"):
        await group_cancel_case(mode)
    print(json.dumps(dict(verdict="PASS", nativeVerified=False,
                          candidateCases=sum(x["kind"] == "candidate" for x in REPORT),
                          legacyNegativeControls=sum(x["kind"] == "legacy-negative" for x in REPORT),
                          cases=REPORT)))


anyio.run(main, backend="asyncio")
