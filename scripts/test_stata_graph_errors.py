"""Frozen runtime methods, real asyncio/AnyIO and threads; Stata is a double."""
import asyncio
import functools
import inspect
import json
import logging
import os
import pathlib
import re
import sys
import threading
import time
import types

import anyio

SOURCE = json.load(sys.stdin)
REPORT = []
LOGGER = logging.getLogger("graph-errors-test")
LOGGER.addHandler(logging.NullHandler())
LOGGER.propagate = False


def load_class(key):
    namespace = dict(asyncio=asyncio, anyio=anyio, time=time, os=os, re=re,
                     functools=functools, inspect=inspect, pathlib=pathlib,
                     json=json, logger=LOGGER, CommandResponse=types.SimpleNamespace,
                     ErrorEnvelope=types.SimpleNamespace,
                     get_cancelled_exc_class=anyio.get_cancelled_exc_class,
                     _DOT_PROMPT_RE=re.compile(r"^\\. "),
                     _STANDALONE_RC_RE=re.compile(r"r\((\d+)\)"))
    exec(compile("from __future__ import annotations\nclass Subject:\n" + SOURCE[key],
                 "<frozen-graph-errors>", "exec"), namespace)
    return namespace["Subject"]()


async def until(predicate):
    with anyio.fail_after(3):
        while not predicate():
            await anyio.sleep(0.001)


def record(candidate, test, **details):
    REPORT.append(dict(kind="candidate" if candidate else "legacy-negative", test=test, **details))


async def detector_case(candidate, method, case):
    cache = load_class("detector" if candidate else "originalDetector")
    cache.auto_cache = True
    cache._lock = threading.Lock()
    cache._graphs_to_cache = ["g", "g", "h"]
    cache._cached_graphs = set()
    cache._removed_graphs = {"removed"}
    calls, callbacks = [], []

    def detect():
        if case == "detect-error":
            raise ValueError("detect failed")
        return ["g", "h", "removed"]

    def listing():
        if case == "list-error":
            raise ValueError("list failed")
        return ["g", "h", "removed"]

    def save(name):
        calls.append(name)
        if case == "cache-error" or case == "partial" and name == "h":
            raise ValueError("cache failed")
        if case == "false":
            return False
        if case == "none":
            return None
        if case == "truthy":
            return 1
        return True

    async def callback(name, success):
        callbacks.append((name, success))
        if case in ("callback-error", "error-and-callback"):
            raise ValueError("callback failed")

    if case == "error-and-callback":
        def save(name):
            calls.append(name)
            raise ValueError("cache failed")
    cache.detector = types.SimpleNamespace(_detect_graphs_via_pystata=detect,
                                          _inventory_cache_enabled=False)
    cache.stata_client = types.SimpleNamespace(list_graphs=listing, cache_graph_on_creation=save)
    cache._cache_callbacks = [callback]
    error = None
    try:
        result = await getattr(cache, method)()
    except Exception as exc:
        error = exc
    if candidate:
        if case == "success":
            assert error is None and result == ["g", "h"]
            assert calls == ["g", "h"] and cache._graphs_to_cache == []
        else:
            assert error is not None, (method, case)
            expected = ["h"] if case in ("partial", "callback-error") else ["g", "h"]
            assert list(dict.fromkeys(cache._graphs_to_cache)) == expected
            if case == "callback-error":
                assert cache._cached_graphs == {"g"}
            if case == "error-and-callback":
                assert isinstance(error, ExceptionGroup)
                assert str(error.exceptions[0]) == "cache failed"
                assert str(error.exceptions[1].exceptions[0]) == "callback failed"
    else:
        assert error is None, (method, case, error)
        if case not in ("detect-error",):
            assert not cache._graphs_to_cache, "legacy loses pending work on error"
    assert not cache.detector._inventory_cache_enabled
    record(candidate, "detector-" + case, method=method)


async def stream_case(candidate, method, case, business_rc=0):
    client = load_class("client" if candidate else "originalClient")
    command_started, command_release, command_finished = (threading.Event() for _ in range(3))
    graph_started, graph_release = asyncio.Event(), asyncio.Event()
    state = dict(graph_calls=0, graph_active=0, tee_closed=False, captured_exc=None)
    client._initialized = True
    client._persistent_log_path = None
    client._is_executing = False
    client._command_idx = 1
    client._last_emitted_graph_signatures = {}
    client._maybe_rewrite_graph_name_in_command = lambda code: code
    client._invalidate_macro_cache_if_needed = lambda code: None
    client._extract_help_topic = lambda code: None
    client._resolve_do_file_path = lambda *a: ("offline.do", "do offline.do", None)
    client._count_do_file_lines = lambda *a: 0
    client._maybe_reload_startup_after_do_file = lambda: None
    client._maybe_reload_startup_after_command = lambda *a: None
    tail = types.SimpleNamespace(get_value=lambda: "business output")
    tee = types.SimpleNamespace(close=lambda: state.update(tee_closed=True))
    client._create_streaming_log = lambda **kw: (None, "offline.log", tail, tee)
    client._create_smcl_log_path = lambda: "offline.smcl"
    client._make_smcl_log_name = lambda: "offline"
    client._capture_graph_state = lambda *a: None if case == "fallback-error" else {}
    client._increment_command_idx = lambda: None
    client._read_smcl_file = lambda *a, **kw: "business output"
    client._clean_internal_smcl = lambda text, **kw: text
    client._parse_rc_from_smcl = lambda *a: None
    client._parse_rc_from_text = lambda *a: None
    client._smcl_to_text = lambda text: text
    client._extract_error_from_smcl = lambda *a: ("failure", "offline failure")
    client._extract_error_and_context = client._extract_error_from_smcl
    client._extract_named_graphs = lambda *a: ["g"]
    client._get_cached_graph_path = lambda *a: None
    client._get_graph_signature = lambda *a: "signature"
    client._get_graph_command_line = lambda *a: "display 1"
    client._command_contains_graph_command = lambda *a: True
    lock = asyncio.Lock()
    client._ensure_graph_ready_lock = lambda: lock

    def combined(*args, **kwargs):
        state["captured_exc"] = args[4]
        return "business output"
    client._build_combined_log = combined

    def export(*args, **kwargs):
        if case in ("export-error", "fallback-error"):
            raise ValueError("export failed")
        return None if case == "export-empty" else "offline.svg"
    client.export_graph = export

    def listing(**kwargs):
        if case == "list-error":
            raise ValueError("list failed")
        return ["g"]
    client.list_graphs = listing

    async def cache_detected():
        if case == "final-cache-error":
            raise ValueError("final cache failed")
        return []
    graph_cache = types.SimpleNamespace(auto_cache=True, cache_detected_graphs_with_pystata=cache_detected)
    client._init_streaming_graph_cache = lambda *a, **kw: graph_cache
    real_poll = client._maybe_cache_graphs_on_chunk

    async def poll(**kwargs):
        if kwargs.get("force"):
            if case == "final-poll-error":
                raise ValueError("final poll failed")
            return await real_poll(**kwargs)
        state["graph_calls"] += 1
        state["graph_active"] += 1
        graph_started.set()
        try:
            await graph_release.wait()
            if case == "poll-error":
                raise ValueError("poll failed")
            return 0
        finally:
            state["graph_active"] -= 1
    client._maybe_cache_graphs_on_chunk = poll

    async def stream(**kwargs):
        for _ in range(500 if case == "flood" else 1):
            await kwargs["on_chunk"]("output")
        await kwargs["done"].wait()
    client._stream_smcl_log = stream

    business_error = ValueError("business failed") if business_rc else None

    def command(**kwargs):
        command_started.set()
        assert command_release.wait(4), "test failed to release command"
        command_finished.set()
        return business_rc, business_error
    client._run_streaming_blocking = command

    async def notify(message):
        if case == "notify-error" and json.loads(message).get("event") == "graph_ready":
            raise ValueError("notify failed")

    request = asyncio.create_task(getattr(client, method)(
        "display 1" if method == "run_command_streaming" else "offline.do",
        notify_log=notify, auto_cache_graphs=True,
        emit_graph_ready=case not in ("success", "flood", "poll-error")))
    try:
        await until(lambda: command_started.is_set() and graph_started.is_set())
        for _ in range(5):
            await anyio.sleep(0.002)
        if candidate:
            assert state["graph_calls"] == 1, state
        elif case == "flood":
            assert state["graph_calls"] == 500, state
        graph_release.set()
        await until(lambda: state["graph_active"] == 0)
        if candidate:
            assert not command_finished.is_set() and not request.done()
        command_release.set()
        result = await request
        assert command_finished.is_set() and state["tee_closed"]
        failure = case not in ("success", "flood")
        if candidate:
            assert result.success == (not failure and not business_rc), result
            assert result.rc == (business_rc or (1 if failure else 0)), result
            if failure:
                assert isinstance(state["captured_exc"], ExceptionGroup)
                if business_error:
                    assert business_error in state["captured_exc"].exceptions
        elif case == "flood":
            assert result.success
        else:
            assert result.success, result
        record(candidate, method + "-" + case, businessRC=business_rc)
    finally:
        command_release.set()
        graph_release.set()
        if not request.done():
            await request


async def poll_error_case(candidate):
    client = load_class("client" if candidate else "originalClient")
    client._is_executing = False
    async def fail():
        raise ValueError("cache poll failed")
    cache = types.SimpleNamespace(auto_cache=True, cache_detected_graphs_with_pystata=fail)
    error = None
    try:
        await client._maybe_cache_graphs_on_chunk(graph_cache=cache, emit_graph_ready=False,
            notify_log=None, graph_ready_task_id=None, graph_ready_format="svg",
            graph_ready_initial=None, last_check=[0.0])
    except ValueError as exc:
        error = exc
    assert bool(error) == candidate
    record(candidate, "poll-propagates-cache-error")


async def callback_case(candidate, case):
    cache = load_class("callbacks" if candidate else "originalCallbacks")
    cache._lock = threading.Lock()
    calls = []
    sync_error = ValueError("sync callback failed")
    async_error = RuntimeError("async callback failed")

    def sync_callback(name, success):
        assert (name, success) == ("g", True)
        calls.append("sync")
        # A callback may register another callback without deadlocking.
        if case == "register":
            with cache._lock:
                cache._cache_callbacks.append(lambda *args: calls.append("registered"))
        if case in ("sync-error", "both-errors"):
            raise sync_error

    async def async_callback(name, success):
        calls.append("async-start")
        await anyio.sleep(0)
        if case == "cancel":
            raise asyncio.CancelledError("callback cancelled")
        calls.append("async-end")
        if case in ("async-error", "both-errors"):
            raise async_error

    class Awaitable:
        def __await__(self):
            async def work():
                await anyio.sleep(0)
                calls.append("awaitable-end")
            return work().__await__()

    cache._cache_callbacks = [] if case == "empty" else [
        sync_callback, async_callback, lambda *args: Awaitable(), lambda *args: calls.append("last")]
    error = None
    try:
        await cache._notify_cache_callbacks("g", True)
    except BaseException as exc:
        error = exc
    expected_errors = [e for flag, e in [(case in ("sync-error", "both-errors"), sync_error),
                                        (case in ("async-error", "both-errors"), async_error)] if flag]
    if case == "cancel":
        assert isinstance(error, asyncio.CancelledError)
        assert calls == ["sync", "async-start"]
    elif case == "empty":
        assert error is None and calls == []
    else:
        assert calls == ["sync", "async-start", "async-end", "awaitable-end", "last"]
        if expected_errors and candidate:
            assert isinstance(error, ExceptionGroup)
            assert list(error.exceptions) == expected_errors
            assert all(e.__notes__ == ["Graph cache callback: g"] for e in expected_errors)
        else:
            assert error is None
        if case == "register":
            assert len(cache._cache_callbacks) == 5
    record(candidate, "real-callback-" + case)


async def main():
    for case in ("empty", "success", "sync-error", "async-error", "both-errors", "register", "cancel"):
        await callback_case(True, case)
    for case in ("sync-error", "async-error", "both-errors"):
        await callback_case(False, case)
    for method in ("cache_detected_graphs", "cache_detected_graphs_with_pystata"):
        for case in ("success", "list-error", "cache-error", "false", "none", "truthy",
                     "partial", "callback-error", "error-and-callback"):
            await detector_case(True, method, case)
        for case in ("list-error", "cache-error", "false", "none", "truthy", "callback-error", "error-and-callback"):
            await detector_case(False, method, case)
    await detector_case(True, "cache_detected_graphs_with_pystata", "detect-error")
    await detector_case(False, "cache_detected_graphs_with_pystata", "detect-error")
    for method in ("run_command_streaming", "run_do_file_streaming"):
        for case in ("success", "flood", "poll-error", "final-cache-error", "final-poll-error",
                     "list-error", "export-error", "fallback-error", "export-empty", "notify-error"):
            for rc in (0, 459):
                await stream_case(True, method, case, rc)
        for case in ("export-error", "export-empty", "notify-error"):
            await stream_case(False, method, case)
    await stream_case(False, "run_do_file_streaming", "flood")
    for candidate in (True, False):
        await poll_error_case(candidate)


anyio.run(main)
print(json.dumps(dict(verdict="PASS", nativeVerified=False, cases=REPORT,
                      candidateCount=sum(r["kind"] == "candidate" for r in REPORT),
                      negativeControls=sum(r["kind"] == "legacy-negative" for r in REPORT))))
