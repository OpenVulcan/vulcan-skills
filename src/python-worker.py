import asyncio
import importlib.util
import inspect
import json
import os
import sys
from pathlib import Path

# Keep terminal output separate from the worker's response stream.
# 将普通终端输出与 Worker 响应流分开。
protocol = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)
modules = {}


def invoke(request):
    """Call an entry from the leased package and return its JSON value.
    调用已租用包中的入口并返回 JSON 值。
    """
    entry = Path(request["entry"])
    if entry not in modules:
        name = "_vulcanskills_entry_" + str(len(modules))
        spec = importlib.util.spec_from_file_location(name, entry)
        module = importlib.util.module_from_spec(spec)
        saved_path = sys.path.copy()
        sys.path[:0] = [str(entry.parent), request["moduleRoot"]]
        sys.modules[name] = module
        try:
            spec.loader.exec_module(module)
        except BaseException:
            sys.modules.pop(name, None)
            raise
        finally:
            sys.path[:] = saved_path
        modules[entry] = module
    run = getattr(modules[entry], request["export"])
    saved_path = sys.path.copy()
    sys.path[:0] = [str(entry.parent), request["moduleRoot"]]
    try:
        value = run(request["args"], request["context"])
        return asyncio.run(value) if inspect.isawaitable(value) else value
    finally:
        sys.path[:] = saved_path


for line in sys.stdin:
    request = json.loads(line)
    try:
        value = invoke(request)
        encoded = json.dumps({"id": request["id"], "ok": True, "value": value}, allow_nan=False)
    except Exception as error:
        encoded = json.dumps({"id": request["id"], "ok": False, "error": str(error)})
    protocol.write("\nVS1 " + encoded + "\n")
