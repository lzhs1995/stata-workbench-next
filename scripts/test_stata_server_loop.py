import asyncio,json,sys,types
data=json.load(sys.stdin)
class Manager:
    def __init__(self):self.listener=None;self.stopped=False
    async def start(self):
        self.listener=asyncio.create_task(asyncio.Event().wait())
        self.loop=asyncio.get_running_loop()
    async def stop_all(self):
        self.stopped=True
        self.listener.cancel()
        await asyncio.gather(self.listener,return_exceptions=True)
class MCP:
    def __init__(self,m,fail):self.manager=m;self.fail=fail;self.executed=False
    async def run_stdio_async(self):
        m=self.manager
        assert m.loop is asyncio.get_running_loop() and not m.listener.done(), "listener died before transport"
        self.executed=True
        if self.fail: raise ValueError("transport failure")
    def run(self):asyncio.run(self.run_stdio_async())
def execute(source,fail=False):
    manager=Manager();mcp=MCP(manager,fail)
    env={"asyncio":asyncio,"session_manager":manager,"mcp":mcp}
    exec("def main():\n    async def init_sessions():\n        await session_manager.start()\n"+source,env)
    error=None
    try:env["main"]()
    except Exception as e:error=e
    return manager,mcp,error
m,transport,error=execute(data["old"])
assert isinstance(error,AssertionError) and not transport.executed
for fail in (False,True):
    m,transport,error=execute(data["new"],fail)
    assert transport.executed and m.stopped and m.listener.done()
    assert isinstance(error,ValueError) if fail else error is None
print("SERVER_EVENT_LOOP_PASS: old split-loop negative control + healthy/error shutdown")

