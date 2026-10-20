"use strict";
// Stata has no log flush subcommand. Validate the owned log without changing
// its on/off state; command completion and the native tail establish visibility.
const BLOCKS = [
  { old: 'cleanup("capture quietly log flush " + smcl_log_name)', count: 1 },
  { old: 'internal("quietly log flush " + log_name)', count: 2 },
  { old: "detector._with_graph_probe_state(lambda _Macro, run: run('log flush ' + smcl_log_name))", count: 2 },
  { old: 'action = "flush " if use_p else "close "', count: 1,
    replacement: 'action = "query " if use_p else "close "' },
].map(b => ({ ...b, replacement: b.replacement || b.old.replace("log flush ", "log query ") }));
function transform(source, normalize) {
  for (const b of BLOCKS) {
    const oldCount = source.split(b.old).length - 1;
    const newCount = source.split(b.replacement).length - 1;
    if (oldCount + newCount !== b.count || (oldCount && newCount))
      throw new Error("unsupported owned-log query source");
    source = source.split(normalize ? b.replacement : b.old).join(normalize ? b.old : b.replacement);
  }
  return source;
}
module.exports = { BLOCKS, patchClient: s => transform(s, false),
  normalizeClient: s => BLOCKS.some(b => s.includes(b.replacement)) ? transform(s, true) : s };
