"use strict";

const crypto = require("node:crypto");
const EXPORT = String.raw`    def export_graph(self, graph_name: str = None, filename: str = None, format: str = "pdf") -> str:
        """Publish one validated export after restoring the caller's graph/results."""
        import tempfile
        import stat
        import re

        fmt = (format or 'pdf').strip().lower()
        if fmt not in {'pdf', 'png', 'svg'}:
            raise ValueError('Unsupported graph export format: ' + repr(format))
        if graph_name is not None and (not isinstance(graph_name, str) or not graph_name):
            raise ValueError('Invalid graph name')

        def stata_path(path):
            text = path.as_posix()
            if any(c in text for c in ('"', '$', chr(96), '\n', '\r', '\x00')):
                raise ValueError('Unsupported characters in graph export directory')
            return '"' + text + '"'

        def fingerprint(path):
            try:
                value = path.lstat()
            except FileNotFoundError:
                return None
            if not stat.S_ISREG(value.st_mode):
                raise ValueError('Graph export destination must be a regular file')
            return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)

        with self._exec_lock:
            if self._initialized is not True or self._is_executing:
                raise RuntimeError('Graph export is unavailable during execution or initialization')
            detector = self._graph_detector
            if detector is None or detector._stata_client is not self:
                raise RuntimeError('Graph export state guard is unavailable')
            resolved = detector._graph_probe_name(self._resolve_graph_name_for_stata(graph_name)) if graph_name is not None else None
            generated = filename is None or filename == ''
            target = (pathlib.Path(get_writable_temp_dir()) / ('mcp_stata_' + uuid.uuid4().hex + '.' + fmt)
                      if generated else pathlib.Path(filename).absolute())
            target = target.absolute()
            # Only our staging filename enters Stata, but its directory is user chosen.
            stata_path(target.parent)
            original_target = fingerprint(target)
            if generated and original_target is not None:
                raise RuntimeError('Generated graph export destination already exists')
            if generated:
                register_temp_file(target)

            staged = None
            failure, cleanup_errors, published = None, [], False
            try:
                descriptor, stage_name = tempfile.mkstemp(prefix='.wb-export-', suffix='.' + fmt, dir=target.parent)
                staged = pathlib.Path(stage_name)
                os.close(descriptor)

                def query(Macro, run):
                    run('graph describe')
                    entry = detector._graph_probe_name(Macro.getGlobal('r(fn)'))
                    selected = resolved if resolved is not None else entry
                    switched, error, restoration_errors = False, None, []
                    try:
                        if selected != entry:
                            # Mark intent before the boundary: it may mutate then raise.
                            switched = True
                            run('graph display ' + selected)
                        if fmt == 'png' and is_windows():
                            # ASIS avoids gr_save's filename/dirty metadata and T_* globals.
                            # Keep the existing Windows external-renderer workaround.
                            directory = tempfile.TemporaryDirectory(prefix='wb-graph-', dir=get_writable_temp_dir())
                            render_errors = []
                            try:
                                work = pathlib.Path(directory.name)
                                gph, dofile = work / 'source.gph', work / 'export.do'
                                run('graph save ' + stata_path(gph) + ', asis replace')
                                if not gph.is_file() or gph.stat().st_size == 0:
                                    raise RuntimeError('Graph save produced no data')
                                executable = getattr(self, '_stata_exec_path', None)
                                if not executable or not pathlib.Path(executable).is_file():
                                    raise RuntimeError('Stata executable path unavailable for PNG export')
                                dofile.write_text('quietly graph use ' + stata_path(gph) + '\nquietly graph export ' +
                                                  stata_path(staged) + ', replace as(png)\nexit\n', encoding='utf-8')
                                completed = subprocess.run([str(executable), '/e', 'do', str(dofile)],
                                                           capture_output=True, text=True, timeout=30, cwd=work)
                                if completed.returncode != 0:
                                    raise RuntimeError('External Stata export failed: ' +
                                                       (completed.stderr.strip() or completed.stdout.strip() or str(completed.returncode)))
                            except BaseException as exc:
                                render_errors.append(exc)
                            finally:
                                try:
                                    directory.cleanup()
                                except BaseException as exc:
                                    render_errors.append(exc)
                            if len(render_errors) == 1:
                                raise render_errors[0]
                            if render_errors:
                                raise BaseExceptionGroup('Graph renderer and workspace cleanup failed', render_errors)
                        else:
                            # One export attempt. Cancellation and native errors are not retried.
                            run('graph export ' + stata_path(staged) + ', replace as(' + fmt + ')')
                    except BaseException as exc:
                        error = exc
                    finally:
                        if switched:
                            try:
                                run('graph display ' + entry)
                            except BaseException as exc:
                                restoration_errors.append(exc)
                        try:
                            run('graph describe')
                            if detector._graph_probe_name(Macro.getGlobal('r(fn)')) != entry:
                                raise RuntimeError('Graph export did not restore the current graph')
                        except BaseException as exc:
                            restoration_errors.append(exc)
                    errors = ([error] if error is not None else []) + restoration_errors
                    if len(errors) == 1:
                        raise errors[0]
                    if errors:
                        raise BaseExceptionGroup('Graph export and graph restoration failed', errors)

                detector._with_graph_probe_state(query)
                info = staged.lstat()
                if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= self.MAX_GRAPH_BYTES:
                    raise RuntimeError('Graph export produced an invalid or oversized file')
                if fingerprint(target) != original_target:
                    raise RuntimeError('Graph export destination changed during export')
                # Commit only after graph/r()/s()/RC restoration and validation succeeded.
                os.replace(staged, target)
                published = True
            except BaseException as exc:
                failure = exc
            finally:
                if staged is not None and not published:
                    try:
                        staged.unlink(missing_ok=True)
                    except BaseException as exc:
                        cleanup_errors.append(exc)
            errors = ([failure] if failure is not None else []) + cleanup_errors
            if len(errors) == 1:
                raise errors[0]
            if errors:
                raise BaseExceptionGroup('Graph export and file cleanup failed', errors)
            return str(target)

`;
const BLOCK = { name: "export_graph", start: "    def export_graph(", end: "    def get_help(",
  sha256: "29b2a7ba37f1c4b270a3db9b6fe4fe75e260d5a99f015d16b83e03c289112c54", replacement: EXPORT };
function patchClient(source) {
  if (source.split(BLOCK.start).length !== 2) throw new Error("missing or ambiguous export method");
  const start = source.indexOf(BLOCK.start), end = source.indexOf(BLOCK.end, start);
  if (end <= start) throw new Error("missing export method boundary");
  const body = source.slice(start, end);
  if (body === EXPORT) return source;
  if (crypto.createHash("sha256").update(body).digest("hex") !== BLOCK.sha256) throw new Error("unsupported export source");
  return source.slice(0, start) + EXPORT + source.slice(end);
}
module.exports = { BLOCK, patchClient };
