    def _run_streaming_blocking(
        self,
        *,
        command: str,
        tee: FileTeeIO,
        cwd: Optional[str],
        trace: bool,
        echo: bool,
        smcl_path: str,
        smcl_log_name: str,
        hold_attr: str,
        require_smcl_log: bool = False,
    ) -> tuple[int, Optional[Exception]]:
        rc = -1
        exc: Optional[Exception] = None
        with self._exec_lock:
            self._is_executing = True
            self._last_results = None # Invalidate results cache
            try:
                from sfi import Scalar, SFIToolkit  # Import SFI tools
                with self._temp_cwd(cwd):
                    logger.debug(
                        "opening SMCL log name=%s path=%s cwd=%s",
                        smcl_log_name,
                        smcl_path,
                        os.getcwd(),
                    )
                    try:
                        if self._persistent_log_path and smcl_path == self._persistent_log_path:
                            # Re-open or resume global session log in append mode to ensure it's active
                            log_opened = self._open_smcl_log(smcl_path, smcl_log_name, quiet=True, append=True)
                        else:
                            log_opened = self._open_smcl_log(smcl_path, smcl_log_name, quiet=True)
                    except Exception as e:
                        log_opened = False
                        logger.warning("_open_smcl_log raised: %r", e)
                    logger.info("SMCL log_opened=%s path=%s", log_opened, smcl_path)
                    if require_smcl_log and not log_opened:
                        exc = RuntimeError("Failed to open SMCL log")
                        logger.error("SMCL log open failed for %s", smcl_path)
                        rc = 1
                    if exc is None:
                        try:
                            # Use an internal buffer to capture the direct output of pystata
                            # rather than writing it raw to the 'tee' (and log_path). 
                            # We rely on _stream_smcl_log to populate the 'tee' with 
                            # cleaned content from the SMCL log.
                            direct_buf = io.StringIO()
                            with self._redirect_io_streaming(direct_buf, direct_buf):
                                try:
                                    if trace:
                                        self.stata.run("set trace on")
                                    
                                    # Hybrid execution: Single-line commands run natively for perfect echoing.
                                    # Multi-line commands use the bundle for error handling and stability.
                                    is_multi_line = "\n" in command.strip()
                                    
                                    if not is_multi_line:
                                        logger.debug("running Stata natively echo=%s", echo)
                                        self._hold_name_stream = f"mcp_hold_{uuid.uuid4().hex[:8]}"
                                        # Reset RC to 0 before running
                                        self._run_internal("scalar _mcp_rc = 0", echo=False)
                                        ret = self.stata.run(command, echo=echo)
                                        # Use _rc if we were in a capture, but here we are native.
                                        # Stata sets c(rc) to the return code of the last command.
                                        self._run_internal(f"scalar _mcp_rc = c(rc)", echo=False)
                                        self._run_internal(f"capture _return hold {self._hold_name_stream}", echo=False)
                                        self._run_internal(f"capture quietly log flush {smcl_log_name}", echo=False)
                                        
                                        # Retrieve RC via SFI
                                        try:
                                            rc_val = Scalar.getValue("_mcp_rc")
                                            rc = int(float(rc_val)) if rc_val is not None else 0
                                        except:
                                            rc = 0
                                    else:
                                        # Optimization: Combined bundle for streaming too.
                                        # Consolidates hold and potentially flush into one call.
                                        self._hold_name_stream = f"mcp_hold_{uuid.uuid4().hex[:8]}"
                                        
                                        # Initialization logic for locals can be sensitive.
                                        # Since each run() in pystata starts a new context for locals unless it's a file,
                                        # we use a global scalar for the return code.
                                        # We use noisily inside the capture block to force echo of commands if requested.
                                        bundle = (
                                            f"capture noisily {{\n"
                                            f"{'noisily {' if echo else ''}\n"
                                            f"{command}\n"
                                            f"{'}' if echo else ''}\n"
                                            f"}}\n"
                                            f"scalar _mcp_rc = _rc\n"
                                            f"capture _return hold {self._hold_name_stream}\n"
                                            f"capture quietly log flush {smcl_log_name}"
                                        )
                                        
                                        logger.debug("running Stata bundle echo=%s", echo)
                                        # Using direct stata.run because tee redirection is already active
                                        ret = self.stata.run(bundle, echo=echo)
                                        
                                        # Retrieve RC via SFI for accuracy
                                        try:
                                            rc_val = Scalar.getValue("_mcp_rc")
                                            rc = int(float(rc_val)) if rc_val is not None else 0
                                        except:
                                            rc = 0
                                        
                                    if isinstance(ret, str) and ret:
                                        # If for some reason SMCL log wasn't working, we can 
                                        # fall back to the raw output, but otherwise we 
                                        # avoid writing raw data to the tee.
                                        pass
                                except Exception as e:
                                    exc = e
                                    logger.error("stata.run bundle failed: %r", e)
                                    if rc in (-1, 0):
                                        parsed_rc = self._parse_rc_from_text(str(e))
                                        if parsed_rc is None:
                                            try:
                                                parsed_rc = self._parse_rc_from_text(direct_buf.getvalue())
                                            except Exception:
                                                parsed_rc = None
                                        rc = parsed_rc if parsed_rc is not None else 1
                                finally:
                                    if trace:
                                        try:
                                            self._run_internal("set trace off")
                                        except Exception:
                                            pass
                        finally:
                            # Only close if it's NOT the persistent session log
                            if not self._persistent_log_name or smcl_log_name != self._persistent_log_name:
                                self._close_smcl_log(smcl_log_name)
                            
                            self._restore_results_from_hold(hold_attr)
                            
                            # Final state restoration (invisibility)
                            try:
                                # Set c(rc) for the environment
                                self._run_internal(f"capture error {rc}" if rc > 0 else "capture", echo=False)
                            except Exception:
                                pass
                        return rc, exc
                    # If we get here, SMCL log failed and we're required to stop.
                    return rc, exc
            finally:
                self._is_executing = False
        return rc, exc

