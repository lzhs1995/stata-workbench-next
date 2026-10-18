"use strict";

const state = require("./stata_detector_state_patch");
const start = "    def _with_graph_probe_state(self, query):\n";
const previous = state.BLOCKS[0].replacement.slice(state.BLOCKS[0].replacement.indexOf(start));
const replacement = String.raw`    def _with_graph_probe_state(self, query):
        # graph describe's nametype clears s(). Guard r(), s() and c(rc) together.
        # This is not a full e/frame/Mata/preserve or current-graph checkpoint.
        with self._graph_probe_lock():
            client = self._stata_client
            if getattr(client, '_initialized', False) is not True:
                raise RuntimeError('Graph detector backend is not initialized')
            from sfi import Macro, Scalar
            token = uuid.uuid4().hex[:24]
            holder, scalar, scratch = '_wb_dh_' + token, '_wb_dr_' + token, '_wb_ds_' + token
            entry_rc = None
            held_attempted = scalar_attempted = scratch_attempted = False
            saved_s, saved_global = None, None
            failure, cleanup_errors, result = None, [], None

            def read_rc(name):
                value = Scalar.getValue(name)
                if (type(value) not in (int, float) or not 0 <= value <= 2147483647
                        or (type(value) is float and not value.is_integer())):
                    raise RuntimeError('Cannot read graph probe return code: ' + name)
                return int(value)

            def internal(statement):
                client.stata.run('nobreak {\n' + statement + '\n}', echo=False)

            def run(statement):
                internal('scalar ' + scalar + ' = .')
                client.stata.run('capture quietly ' + statement + '\nscalar ' + scalar + ' = _rc\n', echo=False)
                rc = read_rc(scalar)
                if rc:
                    error = RuntimeError('Graph probe failed with r(' + str(rc) + '): ' + statement)
                    error.stata_rc = rc
                    raise error

            def read_macro(name):
                value = Macro.getGlobal(name)
                if not isinstance(value, str):
                    raise RuntimeError('Cannot read graph probe macro: ' + name)
                return value

            def read_s():
                # Only generated identifiers enter Stata code. SFI moves values
                # literally, preserving quotes, newlines, backticks and dollars.
                run('global ' + scratch + ' : s(macros)')
                names = read_macro(scratch).split()
                if (len(set(names)) != len(names) or any(
                        re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]{0,31}', name) is None
                        for name in names)):
                    raise RuntimeError('Cannot enumerate graph probe s() macros')
                return {name: read_macro('s(' + name + ')') for name in names}

            def attempt(action):
                try:
                    action()
                except BaseException as error:
                    cleanup_errors.append(error)

            def restore_global():
                Macro.setGlobal(scratch, saved_global)
                if read_macro(scratch) != saved_global:
                    raise RuntimeError('Graph probe temporary global was not restored')

            def verify_s():
                if read_s() != saved_s:
                    raise RuntimeError('Graph probe s() results were not restored')

            def restore_rc():
                internal('capture error ' + str(entry_rc))
                if read_rc('c(rc)') != entry_rc:
                    raise RuntimeError('Graph probe entry return code was not restored')

            try:
                entry_rc = read_rc('c(rc)')
                held_attempted = True
                internal('_return hold ' + holder)
                scalar_attempted = True
                internal('scalar ' + scalar + ' = .')
                # Preserve a coincident caller global as well as an absent one.
                saved_global = read_macro(scratch)
                scratch_attempted = True
                saved_s = read_s()
                # No query may run after an incomplete snapshot.
                result = query(Macro, run)
            except BaseException as error:
                failure = error
            finally:
                if saved_s is not None:
                    attempt(lambda: run('sreturn clear'))
                    for name, value in saved_s.items():
                        attempt(lambda name=name, value=value: Macro.setGlobal('s(' + name + ')', value))
                    attempt(verify_s)
                if scratch_attempted:
                    attempt(restore_global)
                if scalar_attempted:
                    attempt(lambda: internal('scalar drop ' + scalar))
                if held_attempted:
                    attempt(lambda: internal('_return restore ' + holder))
                if entry_rc is not None:
                    attempt(restore_rc)

            errors = ([failure] if failure is not None else []) + cleanup_errors
            if len(errors) == 1:
                raise errors[0]
            if errors:
                raise BaseExceptionGroup('Graph probe and state restoration failed', errors)
            return result

`;
const end = "    def _get_graph_timestamp(";

function transform(source, normalize) {
  const count = source.split(start).length - 1;
  // An unmodified upstream detector has no helper; the upstream patch checks it.
  if (normalize && count === 0) return source;
  if (count !== 1) throw new Error("missing or ambiguous detector sreturn helper");
  const offset = source.indexOf(start), finish = source.indexOf(end, offset);
  if (finish <= offset) throw new Error("missing detector sreturn boundary");
  const body = source.slice(offset, finish);
  if (body !== previous && body !== replacement) throw new Error("unsupported detector sreturn source");
  return source.slice(0, offset) + (normalize ? previous : replacement) + source.slice(finish);
}

module.exports = { start, previous, replacement,
  patchDetector: source => transform(source, false),
  normalizeDetector: source => transform(source, true) };
