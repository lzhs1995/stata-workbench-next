"""Exercise the deployed method after the complete production patch pipeline.

Only file I/O, notification callbacks and scheduling are stubbed; the method
under test comes from patchRuntime's output, not a reconstructed helper.
"""
from __future__ import annotations

import asyncio
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import types


async def exercise(method, initial, appends, marker, *, fail_notify=False):
    clock = types.SimpleNamespace(value=0.0)
    warnings = []
    notices = []
    with tempfile.TemporaryDirectory() as root:
        log = Path(root) / "stream.smcl"
        log.write_text(initial)

        async def sleep(seconds):
            clock.value += seconds
            if appends:
                with log.open("a") as out:
                    out.write(appends.pop(0))

        async def run_sync(fn):
            return fn()

        async def notify(text):
            if fail_notify:
                raise RuntimeError("notification unavailable")
            notices.append(text)

        namespace = dict(asyncio=asyncio, re=re, os=os,
                         time=types.SimpleNamespace(monotonic=lambda: clock.value),
                         anyio=types.SimpleNamespace(sleep=sleep, to_thread=types.SimpleNamespace(run_sync=run_sync)),
                         logger=types.SimpleNamespace(warning=lambda *args: warnings.append(str(args)), debug=lambda *args: None))
        exec("from __future__ import annotations\nclass Client:\n" + method, namespace)
        client = namespace["Client"]()
        client._clean_internal_smcl = lambda chunk, **kwargs: chunk
        tee = io.StringIO()
        await client._stream_smcl_log(smcl_path=str(log), notify_log=notify,
                                     done=types.SimpleNamespace(is_set=lambda: True),
                                     tee=tee, required_tail_marker=marker)
        return tee.getvalue(), clock.value, warnings, "".join(notices)


async def main():
    payload = json.load(sys.stdin)
    marker = "___CODEX_RUN_DONE_composed___"
    old = await exercise(payload["legacy"], "", [marker + "\n"], marker)
    assert any("saw_required_tail" in warning for warning in old[2]), old

    method = payload["candidate"]
    ready = await exercise(method, marker + "\n", [], marker)
    assert ready[0] == marker + "\n" and ready[1] == 0 and not ready[2], ready
    delayed = await exercise(method, "header\n", ["tail\n", "{res}" + marker + "\n"], marker)
    assert marker in delayed[0] and 0 < delayed[1] < 5 and not delayed[2], delayed
    split = await exercise(method, "", [marker[:12], marker[12:] + "\n"], marker)
    assert split[0] == marker + "\n" and split[1] < 5 and not split[2], split
    echo = await exercise(method, '. display as text "' + marker + '"\n', [], marker)
    assert echo[1] >= 5 and not echo[2], echo
    no_marker = await exercise(method, "tail\n", [], None)
    assert no_marker[0] == "tail\n" and no_marker[1] == 0 and not no_marker[2], no_marker
    for fail in (False, True):
        full = await exercise(method, "x" * 5000 + "\n", [marker + "\n"], marker, fail_notify=fail)
        assert len(full[0]) > 5000 and marker in full[0] and full[1] < 5 and not full[2], full
        assert len(full[3]) <= 4000, len(full[3])
    print("STREAM_COMPOSED_BEHAVIOR_PASS: legacy failure plus 7 candidate cases")


asyncio.run(main())
