"use strict";

const BLOCKS = [
  {
    "name": "command-prepare",
    "original": "        _log_file, log_path, tail, tee = self._create_streaming_log(trace=trace)\n\n        # Create SMCL log path for authoritative output capture\n        start_offset = 0\n        if self._persistent_log_path:\n            smcl_path = self._persistent_log_path\n            smcl_log_name = self._persistent_log_name\n            try:\n                start_offset = os.path.getsize(smcl_path)\n            except OSError:\n                start_offset = 0\n        else:\n            smcl_path = self._create_smcl_log_path()\n            smcl_log_name = self._make_smcl_log_name()\n\n        # Inform the MCP client immediately where to read/tail the output.\n        # We provide the cleaned plain-text log_path as the primary 'path' to satisfy \n        # requirements for clean logs without maintenance boilerplate.\n        await notify_log(json.dumps({\n            \"event\": \"log_path\", \n            \"path\": log_path, \n            \"smcl_path\": smcl_path,\n            \"task_id\": graph_ready_task_id,\n        }))\n\n        rc = -1\n        path_for_stata = code.replace(\"\\\\\", \"/\")\n        command = f'{path_for_stata}'\n\n        # Capture initial graph signatures to detect additions/changes\n        graph_ready_initial = self._capture_graph_state(graph_cache, emit_graph_ready)\n        self._current_command_code = code\n        \n        # Increment AFTER capture so detected modifications are based on state BEFORE this command\n        self._increment_command_idx()\n\n",
    "replacement": "        _log_file, log_path, tail, tee = self._create_streaming_log(trace=trace)\n        try:\n\n            # Create SMCL log path for authoritative output capture\n            start_offset = 0\n            if self._persistent_log_path:\n                smcl_path = self._persistent_log_path\n                smcl_log_name = self._persistent_log_name\n                with self._exec_lock:\n                    if self._initialized is not True or self._is_executing:\n                        raise RuntimeError('Persistent streaming log is unavailable')\n                    if not isinstance(smcl_log_name, str) or re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]{0,31}', smcl_log_name) is None:\n                        raise ValueError('Invalid persistent log name')\n                    detector = self._graph_detector\n                    if detector is None or detector._stata_client is not self:\n                        raise RuntimeError('Persistent streaming log state guard is unavailable')\n                    detector._with_graph_probe_state(lambda _Macro, run: run('log flush ' + smcl_log_name))\n                    start_offset = os.path.getsize(smcl_path)\n            else:\n                smcl_path = self._create_smcl_log_path()\n                smcl_log_name = self._make_smcl_log_name()\n\n            # Inform the MCP client immediately where to read/tail the output.\n            # We provide the cleaned plain-text log_path as the primary 'path' to satisfy \n            # requirements for clean logs without maintenance boilerplate.\n            await notify_log(json.dumps({\n                \"event\": \"log_path\", \n                \"path\": log_path, \n                \"smcl_path\": smcl_path,\n                \"task_id\": graph_ready_task_id,\n            }))\n\n            rc = -1\n            path_for_stata = code.replace(\"\\\\\", \"/\")\n            command = f'{path_for_stata}'\n\n            # Capture initial graph signatures to detect additions/changes\n            graph_ready_initial = self._capture_graph_state(graph_cache, emit_graph_ready)\n            self._current_command_code = code\n        \n            # Increment AFTER capture so detected modifications are based on state BEFORE this command\n            self._increment_command_idx()\n\n        except BaseException as preparation_error:\n            try:\n                tee.close()\n            except BaseException as close_error:\n                raise BaseExceptionGroup('Streaming preparation and log close failed',\n                                         [preparation_error, close_error]) from None\n            raise\n\n",
    "count": 1,
    "sha256": "0d7c0beec108534d338f5bf275fd23f17df6201253457182efa7149d3e55ba97"
  },
  {
    "name": "dofile-prepare",
    "original": "        _log_file, log_path, tail, tee = self._create_streaming_log(trace=trace)\n\n        smcl_path = self._create_smcl_log_path()\n        smcl_log_name = self._make_smcl_log_name()\n        start_offset = 0\n        if self._persistent_log_path:\n            smcl_path = self._persistent_log_path\n            smcl_log_name = self._persistent_log_name\n            try:\n                self.stata.run(f\"capture quietly log flush {smcl_log_name}\", echo=False)\n                start_offset = os.path.getsize(smcl_path)\n            except OSError:\n                start_offset = 0\n\n        # Inform the MCP client immediately where to read/tail the output.\n        # We provide the cleaned plain-text log_path as the primary 'path' to satisfy \n        # requirements for clean logs without maintenance boilerplate.\n        await notify_log(json.dumps({\n            \"event\": \"log_path\", \n            \"path\": log_path, \n            \"smcl_path\": smcl_path,\n            \"task_id\": graph_ready_task_id,\n        }))\n\n        rc = -1\n        graph_ready_initial = self._capture_graph_state(graph_cache, emit_graph_ready)\n        self._current_command_code = dofile_text if dofile_text else command\n        \n        # Increment AFTER capture\n        self._increment_command_idx()\n        \n",
    "replacement": "        _log_file, log_path, tail, tee = self._create_streaming_log(trace=trace)\n        try:\n\n            smcl_path = self._create_smcl_log_path()\n            smcl_log_name = self._make_smcl_log_name()\n            start_offset = 0\n            if self._persistent_log_path:\n                smcl_path = self._persistent_log_path\n                smcl_log_name = self._persistent_log_name\n                with self._exec_lock:\n                    if self._initialized is not True or self._is_executing:\n                        raise RuntimeError('Persistent streaming log is unavailable')\n                    if not isinstance(smcl_log_name, str) or re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]{0,31}', smcl_log_name) is None:\n                        raise ValueError('Invalid persistent log name')\n                    detector = self._graph_detector\n                    if detector is None or detector._stata_client is not self:\n                        raise RuntimeError('Persistent streaming log state guard is unavailable')\n                    detector._with_graph_probe_state(lambda _Macro, run: run('log flush ' + smcl_log_name))\n                    start_offset = os.path.getsize(smcl_path)\n\n            # Inform the MCP client immediately where to read/tail the output.\n            # We provide the cleaned plain-text log_path as the primary 'path' to satisfy \n            # requirements for clean logs without maintenance boilerplate.\n            await notify_log(json.dumps({\n                \"event\": \"log_path\", \n                \"path\": log_path, \n                \"smcl_path\": smcl_path,\n                \"task_id\": graph_ready_task_id,\n            }))\n\n            rc = -1\n            graph_ready_initial = self._capture_graph_state(graph_cache, emit_graph_ready)\n            self._current_command_code = dofile_text if dofile_text else command\n        \n            # Increment AFTER capture\n            self._increment_command_idx()\n        \n        except BaseException as preparation_error:\n            try:\n                tee.close()\n            except BaseException as close_error:\n                raise BaseExceptionGroup('Streaming preparation and log close failed',\n                                         [preparation_error, close_error]) from None\n            raise\n\n",
    "count": 1,
    "sha256": "077ee54cf597ab461e7a0378a85eb0409c389f036cd4f14ddbb7d8ebd7bbb351"
  },
  {
    "name": "help-failure",
    "original": "            except Exception as e:\n                logger.warning(\"Early help interception failed for %s: %s\", early_help_topic, e)\n",
    "replacement": "            except Exception:\n                # A failed help lookup, write or notification is not a successful request.\n                raise\n",
    "count": 1,
    "sha256": "4d0ae3d083f15fd746caeaa0ba5ae403ebdae36a3c756dfed80735b75f96b18a"
  },
  {
    "name": "stream-error",
    "original": "                    except Exception as exc:\n                        logger.debug(\"SMCL streaming failed: %s\", exc)\n",
    "replacement": "                    except Exception as stream_error:\n                        # Keep the command running; report the stream error after drain.\n                        graph_poll_errors.append(stream_error)\n",
    "count": 2,
    "sha256": "5bee1d1dbe9d8daa3750943c55de5b0137962553280e7cf7c8eba8b6d4e6e648"
  },
  {
    "name": "worker-once",
    "original": "                    try:\n                        rc, exc = await anyio.to_thread.run_sync(\n                            run_blocking,\n                            abandon_on_cancel=True,\n                        )\n                    except TypeError:\n                        rc, exc = await anyio.to_thread.run_sync(run_blocking)\n",
    "replacement": "                    # TypeError may originate inside the worker: never retry dispatch.\n                    rc, exc = await self._run_owned_streaming_worker(run_blocking)\n",
    "count": 2,
    "sha256": "0931544c6f5c3633cd87c4c10cb0eec8ef9589db53a12c45294c9bbc3affa9b2"
  },
  {
    "name": "cancel-drained",
    "original": "                except get_cancelled_exc_class():\n                    self._request_break_in()\n                    await self._wait_for_stata_stop()\n                    raise\n",
    "replacement": "                except get_cancelled_exc_class():\n                    # The owned worker requested Break and drained before cancellation.\n                    raise\n",
    "count": 2,
    "sha256": "498731025c79bc90e0d42299b516dfca50acd722adea4afa8a38756ca6c8af84"
  },
  {
    "name": "log-factory-and-owned-worker",
    "original": "    def _create_streaming_log(self, *, trace: bool) -> tuple[tempfile.NamedTemporaryFile, str, TailBuffer, FileTeeIO]:\n        log_file = tempfile.NamedTemporaryFile(\n            prefix=\"mcp_stata_\",\n            suffix=\".log\",\n            dir=get_writable_temp_dir(),\n            delete=False,\n            mode=\"w\",\n            encoding=\"utf-8\",\n            errors=\"replace\",\n            buffering=1,\n        )\n        log_path = log_file.name\n        register_temp_file(log_path)\n        tail = TailBuffer(max_chars=200000 if trace else 20000)\n        tee = FileTeeIO(log_file, tail)\n        return log_file, log_path, tail, tee\n\n",
    "replacement": "    def _create_streaming_log(self, *, trace: bool) -> tuple[tempfile.NamedTemporaryFile, str, TailBuffer, FileTeeIO]:\n        log_file = tempfile.NamedTemporaryFile(\n            prefix=\"mcp_stata_\",\n            suffix=\".log\",\n            dir=get_writable_temp_dir(),\n            delete=False,\n            mode=\"w\",\n            encoding=\"utf-8\",\n            errors=\"replace\",\n            buffering=1,\n        )\n        try:\n            log_path = log_file.name\n            register_temp_file(log_path)\n            tail = TailBuffer(max_chars=200000 if trace else 20000)\n            tee = FileTeeIO(log_file, tail)\n            return log_file, log_path, tail, tee\n\n        except BaseException as preparation_error:\n            try:\n                log_file.close()\n            except BaseException as close_error:\n                raise BaseExceptionGroup('Streaming log creation and close failed',\n                                         [preparation_error, close_error]) from None\n            raise\n\n    async def _run_owned_streaming_worker(self, run_blocking):\n        # The request owns the actual OS thread, including repeated cancellation.\n        # This backend already requires asyncio for streaming and graph polling.\n        import asyncio\n        worker = asyncio.create_task(asyncio.to_thread(run_blocking))\n        try:\n            await asyncio.wait({worker})\n            await anyio.lowlevel.checkpoint()\n        except asyncio.CancelledError as cancellation:\n            failures = [cancellation]\n            if not worker.done():\n                try:\n                    self._request_break_in()\n                except BaseException as break_error:\n                    failures.append(break_error)\n            with anyio.CancelScope(shield=True):\n                while not worker.done():\n                    try:\n                        await asyncio.wait({worker})\n                    except asyncio.CancelledError:\n                        # A second Task.cancel() must not release a live worker.\n                        pass\n            try:\n                result = worker.result()\n                if isinstance(result, tuple) and len(result) == 2 and isinstance(result[1], BaseException):\n                    failures.append(result[1])\n            except BaseException as worker_error:\n                failures.append(worker_error)\n            if len(failures) > 1:\n                raise BaseExceptionGroup('Streaming cancellation and worker failures', failures) from None\n            raise cancellation\n        return worker.result()\n\n",
    "count": 1,
    "sha256": "bd9cd77f0d8ab1c4f34b4c2bbc728f74e8592005f7700066de312bce2542e5a7"
  },
  {
    "name": "execution-error-and-close",
    "original": "        except* Exception as exc_group:\n            logger.debug(\"SMCL streaming task group failed: %s\", exc_group)\n            graph_poll_errors.append(exc_group)\n        finally:\n            tee.close()\n",
    "replacement": "        except BaseException as execution_error:\n            try:\n                tee.close()\n            except BaseException as close_error:\n                raise BaseExceptionGroup('Streaming execution and log close failed',\n                                         [execution_error, close_error]) from None\n            if not isinstance(execution_error, Exception):\n                # Do not split cancellation groups and discard their worker errors.\n                raise\n            graph_poll_errors.append(execution_error)\n        else:\n            try:\n                tee.close()\n            except Exception as close_error:\n                graph_poll_errors.append(close_error)\n",
    "count": 2,
    "sha256": "71dff498a1011555381cdb5d3165cb7300349c18ffe42b3ed549b34f8477ed00"
  }
];

function patchClient(source) {
  let result = source;
  const states = [];
  for (const block of BLOCKS) {
    const originals = result.split(block.original).length - 1;
    const candidates = result.split(block.replacement).length - 1;
    if (originals === 0 && candidates === block.count) { states.push("candidate"); continue; }
    if (originals !== block.count || candidates !== 0) {
      throw new Error("unsupported streaming lifecycle source: " + block.name);
    }
    states.push("original");
    result = result.replaceAll(block.original, block.replacement);
  }
  if (new Set(states).size !== 1) throw new Error("mixed streaming lifecycle source");
  return result;
}
function normalizeClient(source) {
  if (!BLOCKS.some(block => source.includes(block.replacement))) return source;
  // Validate every final block before exposing earlier graph anchors in memory.
  // Partial or edited candidates must never be repaired by normalization.
  if (patchClient(source) !== source) throw new Error("mixed streaming lifecycle source");
  let result = source;
  for (const block of [...BLOCKS].reverse()) {
    result = result.replaceAll(block.replacement, block.original);
  }
  return result;
}
module.exports = { BLOCKS, patchClient, normalizeClient };
