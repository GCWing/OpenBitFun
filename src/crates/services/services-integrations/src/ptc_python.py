"""PTC Python worker. Process isolation is not a security sandbox."""
import asyncio
import json
import sys
import textwrap
import uuid

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
_wire_in = sys.stdin
_wire_out = sys.stdout
_token = uuid.uuid4().hex
_pending = {}
_logs = []
_limit = 8 * 1024 * 1024


class OutputLimitError(Exception):
    pass


def write(value):
    _wire_out.write(json.dumps(value, ensure_ascii=True, allow_nan=False) + "\n")
    _wire_out.flush()


def log(*values, sep=" ", end="\n", **kwargs):
    _logs.append(sep.join(str(value) for value in values) + end.rstrip("\n"))
    if len(json.dumps(_logs).encode("utf-8")) > _limit:
        raise OutputLimitError("PTC logs exceed output limit")


class Tools:
    def __init__(self, bindings):
        self._names = {binding["name"] for binding in bindings}

    def __getattr__(self, name):
        async def call(arguments):
            if name not in self._names:
                raise ValueError("tool '%s' is not available in this PTC snapshot" % name)
            return await self._call(name, arguments, True)
        return call

    def __getitem__(self, name):
        return self.__getattr__(name)

    async def _call(self, name, arguments, enforce_binding):
        if not isinstance(arguments, dict):
            raise ValueError("arguments for '%s' must be an object" % name)
        return await self._request({"kind": "tool_call", "toolName": name,
                                    "arguments": arguments, "enforceBinding": enforce_binding})

    async def callTool(self, name, arguments):
        return await self._call(name, arguments, False)

    async def getToolSpec(self, name):
        if not isinstance(name, str) or not name:
            raise ValueError("getToolSpec requires a non-empty tool name")
        return await self._request({"kind": "get_tool_spec", "toolName": name})

    async def _request(self, frame):
        operation_id = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        _pending[operation_id] = future
        try:
            write(dict(frame, token=_token, operationId=operation_id))
            return await future
        finally:
            _pending.pop(operation_id, None)


async def execute(message):
    global _limit, _logs
    _limit = message.get("maxOutputBytes") or 8 * 1024 * 1024
    _logs = []
    try:
        # Like the Node worker, run an async function body with a return value.
        source = "async def __ptc_program(tools):\n" + textwrap.indent(message["source"], "    ")
        namespace = {"print": log}
        exec(compile(source, "openbitfun-ptc.py", "exec"), namespace)
        value = await namespace["__ptc_program"](Tools(message.get("bindings", [])))
        encoded = json.dumps(value, allow_nan=False)
        if len(encoded.encode("utf-8")) > _limit:
            raise OutputLimitError("PTC result exceeds output limit")
        write({"kind": "complete", "token": _token, "id": message["id"], "ok": True,
               "result": {"value": value, "logs": _logs}})
    except BaseException as error:
        write({"kind": "complete", "token": _token, "id": message["id"], "ok": False,
               "errorKind": "output_limit" if isinstance(error, OutputLimitError) else "exception",
               "error": str(error)[:4096]})


async def main():
    # A blocking stdin reader in an executor works with Windows anonymous pipes,
    # unlike add_reader/connect_read_pipe. Only this task reads protocol frames.
    loop = asyncio.get_running_loop()
    task = None
    write({"kind": "ready", "token": _token})
    while True:
        line = await loop.run_in_executor(None, _wire_in.readline)
        if not line:
            break
        message = json.loads(line)
        if message.get("type") == "execute":
            task = asyncio.create_task(execute(message))
        elif message.get("type") == "tool_result":
            future = _pending.get(message["operationId"])
            if future is not None and not future.done():
                if message.get("ok"):
                    future.set_result(message.get("value"))
                else:
                    future.set_exception(RuntimeError(message.get("error", "nested tool call failed")))
    if task is not None:
        task.cancel()


# Keep ordinary Python stdout/stderr writes away from protocol framing. The
# worker remains trusted code execution, not an authenticated protocol boundary.
class LogStream:
    def write(self, value):
        if value.strip():
            log(value.rstrip("\n"))
        return len(value)

    def flush(self):
        pass


sys.stdout = LogStream()
sys.stderr = LogStream()
asyncio.run(main())
