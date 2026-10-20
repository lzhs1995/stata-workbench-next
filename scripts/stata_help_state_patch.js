"use strict";

const crypto = require("node:crypto");
const HELP = String.raw`    def get_help(self, topic: str, plain_text: bool = False) -> str:
        """Read a help file without changing the caller's Stata results."""
        import re
        # A help topic is a file stem, never a Stata expression or command.
        if not isinstance(topic, str) or re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_-]{0,127}', topic) is None:
            raise ValueError('Unsupported help topic: ' + repr(topic))
        with self._exec_lock:
            if self._initialized is not True or self._is_executing:
                raise RuntimeError('Help is unavailable during execution or initialization')
            detector = self._graph_detector
            if detector is None or detector._stata_client is not self:
                raise RuntimeError('Help state guard is unavailable')

            def query(Macro, run):
                try:
                    run('findfile ' + topic + '.sthlp')
                except RuntimeError as error:
                    # Only Stata's file-not-found outcome means absent help.
                    # Restoration errors still escape the surrounding guard.
                    if getattr(error, 'stata_rc', None) == 601:
                        return None
                    raise
                filename = Macro.getGlobal('r(fn)')
                if not isinstance(filename, str) or not filename or '\x00' in filename:
                    raise RuntimeError('Cannot read help filename')
                return filename

            filename = detector._with_graph_probe_state(query)

        if filename is None:
            return f"Help file for '{topic}' not found."
        # A located file that cannot be read is a failure, not missing help.
        with open(filename, 'r', encoding='utf-8', errors='replace') as handle:
            smcl = handle.read()
        if plain_text:
            return self._smcl_to_text(smcl)
        try:
            return smcl_to_markdown(smcl, adopath=os.path.dirname(filename),
                                    current_file=os.path.splitext(os.path.basename(filename))[0])
        except Exception as error:
            # Preserve the existing presentation fallback after a successful read.
            logger.warning('SMCL to Markdown failed, falling back to plain text: %s', error)
            return self._smcl_to_text(smcl)

`;
const BLOCK = {
  name: "get_help", start: "    def get_help(", end: "    def get_stored_results(",
  sha256: "087fd44601c4fbb9459a519eeb84b8a491e885de95c2f1eb726fce797e5e4433",
  replacement: HELP,
};
function patchClient(source) {
  if (source.split(BLOCK.start).length !== 2) throw new Error("missing or ambiguous help method");
  const start = source.indexOf(BLOCK.start), end = source.indexOf(BLOCK.end, start);
  if (end <= start) throw new Error("missing help method boundary");
  const body = source.slice(start, end);
  if (body === HELP) return source;
  if (crypto.createHash("sha256").update(body).digest("hex") !== BLOCK.sha256) {
    throw new Error("unsupported help source");
  }
  return source.slice(0, start) + HELP + source.slice(end);
}
module.exports = { BLOCK, patchClient };
