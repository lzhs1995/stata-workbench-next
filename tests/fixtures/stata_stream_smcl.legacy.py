# Exact method from deployed runtime 3d3e295aead7dbf0c127d20c006a9688f58a5eec166ae5e2c51c6764c9966630.
    async def _stream_smcl_log(
        self,
        *,
        smcl_path: str,
        notify_log: Callable[[str], Awaitable[None]],
        done: anyio.Event,
        on_chunk: Optional[Callable[[str], Awaitable[None]]] = None,
        start_offset: int = 0,
        tee: Optional[FileTeeIO] = None,
        required_tail_marker: Optional[str] = None,
    ) -> None:
        last_pos = start_offset
        emitted_debug_chunks = 0
        has_written = False
        notifications_enabled = True
        notify_budget_remaining = 4000

        async def _write_and_notify(cleaned_chunk: str, label: str) -> None:
            nonlocal notifications_enabled, notify_budget_remaining
            # Workbench notification budget must preserve valid Python source.
            # asyncio.wait_for cannot interrupt a synchronous stdio write after its
            # pipe is full, so keep the cumulative JSON-RPC notification payload
            # below the pipe-risk boundary. The complete visible log remains the
            # authority and is always written before any optional notification.
            if tee:
                try:
                    tee.write(cleaned_chunk)
                except Exception:
                    pass
            if not notifications_enabled or notify_budget_remaining <= 0:
                notifications_enabled = False
                return

            max_notify_chars = 4000
            notify_text = cleaned_chunk
            if len(notify_text) > notify_budget_remaining:
                notice = "\n[Stata Workbench: further progress available in log_path]\n"
                keep = max(0, notify_budget_remaining - len(notice))
                notify_text = notify_text[:keep] + notice[:notify_budget_remaining - keep]
            for offset in range(0, len(notify_text), max_notify_chars):
                piece = notify_text[offset:offset + max_notify_chars]
                try:
                    await asyncio.wait_for(notify_log(piece), timeout=0.25)
                    notify_budget_remaining -= len(piece)
                except asyncio.TimeoutError:
                    notifications_enabled = False
                    logger.warning(
                        "%s timed out at offset %s; continuing with log_path only",
                        label,
                        offset,
                    )
                    break
                except Exception as exc:
                    notifications_enabled = False
                    logger.debug("%s failed at offset %s: %s", label, offset, exc)
                    break
            if notify_budget_remaining <= 0:
                notifications_enabled = False

        # Wait for Stata to create the SMCL file
        while not done.is_set() and not os.path.exists(smcl_path):
            await anyio.sleep(0.05)

        try:
            def _read_content() -> tuple[str, int]:
                try:
                    with open(smcl_path, "rb") as f:
                        f.seek(last_pos)
                        data = f.read()
                    if not data:
                        return "", 0
                    return data.decode("utf-8", errors="replace"), len(data)
                except PermissionError:
                    if is_windows():
                        try:
                            # Use 'type' on Windows to bypass exclusive lock
                            res = subprocess.run(f'type "{smcl_path}"', shell=True, capture_output=True)
                            full_content = res.stdout
                            if len(full_content) > last_pos:
                                data = full_content[last_pos:]
                                return data.decode("utf-8", errors="replace"), len(data)
                            return "", 0
                        except Exception:
                            return "", 0
                    return "", 0
                except FileNotFoundError:
                    return "", 0

            while not done.is_set():
                chunk, chunk_bytes = await anyio.to_thread.run_sync(_read_content)
                if chunk:
                    last_pos += chunk_bytes
                    # Clean chunk before sending to log channel to suppress maintenance leakage
                    cleaned_chunk = self._clean_internal_smcl(
                        chunk,
                        strip_output=False,
                        strip_leading_boilerplate=not has_written,
                    )
                    if cleaned_chunk:
                        await _write_and_notify(cleaned_chunk, "notify_log")
                        has_written = True

                    if on_chunk is not None:
                        try:
                            await on_chunk(chunk)
                        except Exception as exc:
                            logger.debug("on_chunk callback failed: %s", exc)
                await anyio.sleep(0.05)

            # Workbench per-run log must contain its own completion marker before task_done.
            # done can race the final persistent-SMCL flush, so a single read (the
            # old, accidentally loop-indented block) could permanently truncate
            # log_path while the session log continued to a verified completion.
            completion_deadline = time.monotonic() + 5.0
            chunk = ""
            while True:
                chunk, chunk_bytes = await anyio.to_thread.run_sync(_read_content)
                if chunk:
                    last_pos += chunk_bytes
                    cleaned_chunk = self._clean_internal_smcl(
                        chunk,
                        strip_output=False,
                        strip_leading_boilerplate=not has_written,
                    )
                    if cleaned_chunk:
                        await _write_and_notify(cleaned_chunk, "final notify_log")
                        has_written = True
                    if on_chunk is not None:
                        try:
                            await on_chunk(chunk)
                        except Exception as exc:
                            logger.debug("final on_chunk check failed: %s", exc)
                    continue
                if saw_required_tail or time.monotonic() >= completion_deadline:
                    break
                await anyio.sleep(0.05)

            if on_chunk is not None and not chunk:
                try:
                    await on_chunk("")
                except Exception as exc:
                    logger.debug("final on_chunk check failed: %s", exc)

        except Exception as e:
            logger.warning(f"Log streaming failed: {e}")


