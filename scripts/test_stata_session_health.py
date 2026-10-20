import asyncio
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
if __name__ == "__main__":
    TMP = Path(tempfile.mkdtemp(prefix="session-health-", dir=ROOT))
    PKG = TMP / "mcp_stata"
    PKG.mkdir()
    (PKG / "__init__.py").write_text("")
    (PKG / "models.py").write_text("class SessionInfo:\n def __init__(self, **kw): self.__dict__.update(kw)\nclass CommandResponse: pass\n")
    shutil.copyfile(Path(os.environ["STATA_SESSION_MODULE"]), PKG / "sessions.py")
    (PKG / "worker.py").write_text('import os, time\ndef main(conn):\n    mode = os.environ.get("SESSION_STUB_MODE", "normal")\n    if mode == "die_start": os._exit(23)\n    if mode == "error_start":\n        conn.send({"event":"error", "message":"stub startup failure"})\n        conn.close()\n        return\n    conn.send({"event":"ready", "pid":os.getpid()})\n    if mode == "no_read":\n        time.sleep(8)\n        return\n    waiting = None\n    while True:\n        msg = conn.recv()\n        kind = msg["type"]\n        if kind == "die": os._exit(24)\n        if kind == "wait_break":\n            waiting = msg["id"]\n            continue\n        if kind == "break":\n            if waiting:\n                time.sleep(.2)\n                conn.send({"event":"error", "id":waiting, "message":"real break acknowledgement"})\n                waiting = None\n            continue\n        if kind == "stop": return\n        conn.send({"event":"result", "id":msg["id"], "result":msg["args"]})\n')
    sys.path.insert(0, str(TMP))
from mcp_stata.sessions import StataSession, SessionManager


class Health(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sessions = []
        self.unhandled = []
        asyncio.get_running_loop().set_exception_handler(lambda _loop, ctx: self.unhandled.append(ctx))

    async def session(self, mode="normal"):
        os.environ["SESSION_STUB_MODE"] = mode
        s = StataSession(mode)
        self.sessions.append(s)
        for _ in range(300):
            if s.status != "starting": break
            await asyncio.sleep(.01)
        return s

    async def asyncTearDown(self):
        for s in self.sessions:
            await asyncio.wait_for(s.stop(.3), 3)
            self.assertFalse(s._process.is_alive())
            self.assertTrue(s._parent_conn.closed)
            self.assertFalse(s._send_tasks)
            self.assertFalse(s._pending_requests)
        await asyncio.sleep(.01)
        self.assertEqual(self.unhandled, [])

    async def test_normal_concurrent_messages(self):
        s = await self.session()
        results = await asyncio.gather(*(s.call("echo", {"i":i,"data":"x"*50000}) for i in range(12)))
        self.assertEqual([x["i"] for x in results], list(range(12)))
        self.assertEqual(s.get_info().status, "running")
        self.assertTrue(s._child_conn.closed)

    async def test_startup_crash(self):
        s = await self.session("die_start")
        self.assertEqual(s.get_info().status, "error")
        with self.assertRaises(RuntimeError): await s.call("echo", {})

    async def test_startup_reported_error(self):
        s = await self.session("error_start")
        self.assertEqual(s.status, "error")
        with self.assertRaises(RuntimeError): await s.call("echo", {})

    async def test_death_settles_all_pending(self):
        s = await self.session()
        calls = [asyncio.create_task(s.call("wait_break", {})) for _ in range(4)]
        calls.append(asyncio.create_task(s.call("die", {})))
        results = await asyncio.wait_for(asyncio.gather(*calls, return_exceptions=True), 2)
        self.assertTrue(all(isinstance(x, RuntimeError) for x in results))
        self.assertEqual(s.get_info().status, "error")

    async def test_cancel_waits_for_real_worker_ack(self):
        s = await self.session()
        call = asyncio.create_task(s.call("wait_break", {}))
        await asyncio.sleep(.04)
        call.cancel()
        await asyncio.sleep(.05)
        self.assertFalse(call.done())
        call.cancel()
        with self.assertRaises(asyncio.CancelledError): await asyncio.wait_for(call, 2)
        self.assertEqual(await s.call("echo", {"next":True}), {"next":True})

    async def test_anyio_cancel_waits_for_ack(self):
        import anyio
        s = await self.session()
        started = asyncio.get_running_loop().time()
        with anyio.move_on_after(.05) as scope:
            await s.call("wait_break", {})
        self.assertTrue(scope.cancel_called)
        self.assertGreater(asyncio.get_running_loop().time()-started, .2)
        self.assertEqual(await s.call("echo", {"after":True}), {"after":True})

    async def test_full_pipe_does_not_block_loop_and_stop_drains(self):
        s = await self.session("no_read")
        call = asyncio.create_task(s.call("echo", {"data":"x"*8_000_000}))
        await asyncio.sleep(.08)
        self.assertFalse(call.done())
        ticks = 0
        for _ in range(5):
            await asyncio.sleep(.01)
            ticks += 1
        self.assertEqual(ticks, 5)
        await asyncio.wait_for(s.stop(.3), 2)
        with self.assertRaises(RuntimeError): await call

    async def test_cancel_full_pipe_then_explicit_stop(self):
        s = await self.session("no_read")
        call = asyncio.create_task(s.call("echo", {"data":"x"*8_000_000}))
        await asyncio.sleep(.08)
        call.cancel()
        await asyncio.sleep(.04)
        self.assertFalse(call.done())
        await asyncio.wait_for(s.stop(.3), 2)
        with self.assertRaises(asyncio.CancelledError): await call

    async def test_manager_shutdown_drains_peers_after_one_failure(self):
        from types import SimpleNamespace
        finished = []
        class Failed:
            async def stop(self):
                finished.append("failed")
                raise RuntimeError("still alive")
        class Slow:
            async def stop(self):
                await asyncio.sleep(.05)
                finished.append("stopped")
        manager = SimpleNamespace(_sessions={"failed": Failed(), "slow": Slow()})
        with self.assertRaises(BaseExceptionGroup) as failure:
            await SessionManager.stop_all(manager)
        self.assertEqual(finished, ["failed", "stopped"])
        self.assertEqual(list(manager._sessions), ["failed"])
        self.assertEqual(len(failure.exception.exceptions), 1)


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        shutil.rmtree(TMP)
