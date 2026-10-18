"use strict";

const crypto = require("node:crypto");
const RESULTS = String.raw`    def get_stored_results(self, force_fresh: bool = False) -> Dict[str, Any]:
        """Read UI scalar/macro results; this is not a complete Stata checkpoint."""
        import copy
        import re
        import uuid
        with self._exec_lock:
            if self._initialized is not True or self._is_executing:
                raise RuntimeError('Stored results are unavailable during execution or initialization')
            if not force_fresh and self._last_results is not None:
                return copy.deepcopy(self._last_results)
            # A failed fresh read must not leave a stale success available.
            self._last_results = None
            from sfi import Scalar, Macro

            def read_rc():
                value = Scalar.getValue('c(rc)')
                if (type(value) not in (int, float) or not 0 <= value <= 2147483647
                        or (type(value) is float and not value.is_integer())):
                    raise RuntimeError('Cannot read stored-results return code')
                return int(value)

            entry_rc = read_rc()
            token = '_wb_sr_' + uuid.uuid4().hex[:20]
            names_macro, rc_macro = token + '_n', token + '_c'
            saved, touched = {}, []
            failure, cleanup_errors = None, []
            results = {'r': {}, 'e': {}, 's': {}}
            try:
                # No _return hold: it clears the r() values we need to read.
                # SFI setters preserve literal macro content without expansion.
                for name in (names_macro, rc_macro):
                    value = Macro.getGlobal(name)
                    if not isinstance(value, str):
                        raise RuntimeError('Cannot snapshot stored-results scratch macro')
                    saved[name] = value
                for rclass, kind in (('r', 'scalars'), ('r', 'macros'),
                                     ('e', 'scalars'), ('e', 'macros'), ('s', 'macros')):
                    for name in (names_macro, rc_macro):
                        if name not in touched:
                            touched.append(name)
                        Macro.setGlobal(name, '!pending!')
                    # Extended macro enumeration does not alter r/e/s values.
                    # Save the native RC inside this call, before PyStata can reset it.
                    self.stata.run('nobreak {\ncapture quietly global ' + names_macro +
                                   ' : ' + rclass + '(' + kind + ')\nglobal ' +
                                   rc_macro + ' = _rc\n}', echo=False)
                    raw_rc = Macro.getGlobal(rc_macro)
                    if (not isinstance(raw_rc, str)
                            or re.fullmatch(r'0|[1-9][0-9]{0,9}', raw_rc) is None
                            or int(raw_rc) > 2147483647):
                        raise RuntimeError('Cannot read stored-results enumeration return code')
                    if int(raw_rc):
                        error = RuntimeError('Stored-results enumeration failed with r(' + raw_rc + ')')
                        error.stata_rc = int(raw_rc)
                        raise error
                    raw_names = Macro.getGlobal(names_macro)
                    if not isinstance(raw_names, str):
                        raise RuntimeError('Cannot read stored-results names')
                    names = raw_names.split()
                    if (len(names) != len(set(names)) or any(
                            re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]{0,31}', name) is None for name in names)):
                        raise RuntimeError('Unsupported or duplicate stored-results names')
                    for name in names:
                        if name in results[rclass]:
                            raise RuntimeError('Ambiguous scalar/macro result name: ' + rclass + '(' + name + ')')
                        reference = rclass + '(' + name + ')'
                        value = Scalar.getValue(reference) if kind == 'scalars' else Macro.getGlobal(reference)
                        if ((kind == 'scalars' and type(value) not in (int, float))
                                or (kind == 'macros' and not isinstance(value, str))):
                            raise RuntimeError('Cannot read stored result: ' + reference)
                        results[rclass][name] = value
            except BaseException as error:
                failure = error
            finally:
                for name in reversed(touched):
                    try:
                        Macro.setGlobal(name, saved[name])
                        if Macro.getGlobal(name) != saved[name]:
                            raise RuntimeError('Stored-results scratch macro was not restored: ' + name)
                    except BaseException as error:
                        cleanup_errors.append(error)
                if touched:
                    try:
                        self.stata.run('nobreak {\ncapture error ' + str(entry_rc) + '\n}', echo=False)
                        if read_rc() != entry_rc:
                            raise RuntimeError('Stored-results entry return code was not restored')
                    except BaseException as error:
                        cleanup_errors.append(error)

            errors = ([failure] if failure is not None else []) + cleanup_errors
            if len(errors) == 1:
                raise errors[0]
            if errors:
                raise BaseExceptionGroup('Stored-results query and restoration failed', errors)
            self._last_results = copy.deepcopy(results)
            return results

`;
const BLOCK = {
  name: "get_stored_results", start: "    def get_stored_results(", end: "    def invalidate_graph_cache(",
  sha256: "cfe3e37ac893d3b85ca4733009f60e628edce479d48abb39610f40d2ebdabc06",
  replacement: RESULTS,
};
function patchClient(source) {
  if (source.split(BLOCK.start).length !== 2 || source.split(BLOCK.end).length !== 2) {
    throw new Error("missing or ambiguous stored-results boundary");
  }
  const start = source.indexOf(BLOCK.start), end = source.indexOf(BLOCK.end, start);
  if (end <= start) throw new Error("missing stored-results method boundary");
  const body = source.slice(start, end);
  if (body === RESULTS) return source;
  if (crypto.createHash("sha256").update(body).digest("hex") !== BLOCK.sha256) {
    throw new Error("unsupported stored-results source");
  }
  return source.slice(0, start) + RESULTS + source.slice(end);
}
module.exports = { BLOCK, patchClient };
