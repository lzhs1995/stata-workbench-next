"use strict";
// W-P1 diagnostics (rc.7.80), developer tool only. Not part of the product's
// runtime patch chain: mcp_stata_runtime_patch never loads it, so the patched
// runtime bytes are the same with or without any environment variable.
// The inserted lines would also break the next patchRuntime pass (the session
// lifecycle check refuses blocks it does not know), so the tool never writes to
// the runtime it is given. It reads that runtime, copies it into a new directory
// that must not exist yet (regular files only: links are followed and copied as
// content, so no file in the output shares an inode or a target with the source)
// and instruments only that copy:
//   node scripts/stata_timing_patch.js <source-runtime> [--out <new-dir>]
// Without --out the copy goes to a fresh directory under the system temp dir.
// There is no revert; delete the copy. The instrumented copy writes one JSON line
// per milestone between "worker spawned" and "log_path published" to the file
// named by STATA_WORKBENCH_TIMING_FILE, and nothing while that variable is unset.
// Every inserted statement sits in its own try/except; the file writes are
// synchronous, so timings taken with it include that I/O cost. The fields are
// the literal names below; this side has no per-event allowlist of its own.
const MARKER = "Workbench W-P1 timing (diagnostic copy only; writes only when STATA_WORKBENCH_TIMING_FILE is set)";
const ENV = "STATA_WORKBENCH_TIMING_FILE";

const HELPER = `
# ${MARKER}
_WB_FIRST_LOG = set()


def _wb_timing(event, **fields):
    target = os.environ.get("${ENV}")
    if not target:
        return
    try:
        import json as _wb_json
        import time as _wb_time
        record = {"event": event, "wall": _wb_time.time(), "mono": _wb_time.monotonic(), "pid": os.getpid(), "src": "py"}
        record.update(fields)
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(_wb_json.dumps(record, default=str) + "\\n")
    except Exception:
        pass
`;

const WAIT_ORIGINAL = `async def _wait_for_log_path(task_info: BackgroundTask) -> None:
    while task_info.log_path is None and not task_info.done:
        await anyio.sleep(0.01)
`;
const WAIT_TIMED = `async def _wait_for_log_path(task_info: BackgroundTask) -> None:
    try:
        _wb_timing("server_wait_log_path_start", task_id=task_info.task_id, kind=task_info.kind)
    except Exception:
        pass
    while task_info.log_path is None and not task_info.done:
        await anyio.sleep(0.01)
    try:
        _wb_timing("server_wait_log_path_end", task_id=task_info.task_id, has_log_path=task_info.log_path is not None, done=bool(task_info.done))
    except Exception:
        pass
`;

// where: "after" inserts below the anchor, "before" above it; the inserted lines
// take the indentation of the anchor's first (before) or last (after) line.
// all: the anchor may occur more than once (run_command and run_do_file share it).
const POINTS = {
  server: {
    helperAnchor: '\nlogger = logging.getLogger("mcp_stata")\n',
    points: [
      { event: "server_tool_call", where: "after", lines: ['_wb_timing("server_tool_call", tool=tool_name, request_id=str(request_id))'],
        anchor: '    logger.info("MCP tool call: %s request_id=%s", tool_name, request_id)\n' },
      { event: "server_wait_log_path_start", replace: [WAIT_ORIGINAL, WAIT_TIMED] },
    ],
  },
  session: {
    helperAnchor: '\nlogger = logging.getLogger("mcp_stata.sessions")\n',
    points: [
      { event: "session_spawned", where: "after",
        lines: ['_wb_timing("session_spawned", session=self.id, worker_pid=getattr(self._process, "pid", None))'],
        anchor: "        self._listener_task = asyncio.create_task(self._listen_to_worker())\n" },
      { event: "session_ready", where: "after", lines: ['_wb_timing("session_ready", session=self.id, worker_pid=self.pid)'],
        anchor: '            logger.info(f"Session {self.id} ready (PID: {self.pid})")\n' },
      { event: "session_call_send", where: "before", lines: ['_wb_timing("session_call_send", session=self.id, method=method, msg_id=msg_id)'],
        anchor: '            await self._send({"type": method, "id": msg_id, "args": args})\n' },
      { event: "session_first_log", where: "after", indent: "            ",
        lines: ["if msg_id not in _WB_FIRST_LOG and len(_WB_FIRST_LOG) < 4096:",
          "    _WB_FIRST_LOG.add(msg_id)",
          '    _wb_timing("session_first_log", session=self.id, msg_id=msg_id)'],
        anchor: '        elif event == "log":\n' },
      { event: "session_result", where: "after", indent: "            ",
        lines: ['_wb_timing("session_result", session=self.id, msg_id=msg_id)'],
        anchor: '        elif event == "result":\n' },
    ],
  },
  client: {
    helperAnchor: '\nlogger = logging.getLogger("mcp_stata")\n',
    points: [
      { event: "client_init_start", where: "before", lines: ['_wb_timing("client_init_start", candidates=len(discovery_candidates))'],
        anchor: '            logger.info("Initializing Stata engine (attempting up to %d candidate binaries)...", len(discovery_candidates))\n' },
      { event: "client_preflight_start", where: "before", lines: ['_wb_timing("client_preflight_start")'],
        anchor: '                                res = subprocess.run(\n                                    [py_exe, "-c", preflight_code],\n' },
      { event: "client_preflight_end", where: "before", lines: ['_wb_timing("client_preflight_end", rc=res.returncode)'],
        anchor: '                                if res.returncode != 0:\n                                    sys.stderr.write(f"[mcp_stata] Pre-flight failed (rc={res.returncode})' },
      { event: "client_config_ok", where: "after", lines: ['_wb_timing("client_config_ok")'],
        anchor: '                        logger.info("stata_setup.config succeeded with path: %s", path)\n' },
      { event: "client_init_end", where: "after", lines: ['_wb_timing("client_init_end", edition=str(edition))'],
        anchor: '            logger.info("StataClient initialized successfully with %s (%s)", stata_exec_path, edition)\n' },
      { event: "client_startup_do", where: "before", lines: ['_wb_timing("client_startup_do")'],
        anchor: "                logger.info('Loading startup do file from %s', path)\n" },
      { event: "client_stream_enter", where: "after", all: true, lines: ['_wb_timing("client_stream_enter")'],
        anchor: "        self._break_requested = False\n\n        code = self._maybe_rewrite_graph_name_in_command(code)\n" },
      { event: "client_log_path_notify", where: "before", all: true, lines: ['_wb_timing("client_log_path_notify")'],
        anchor: "            # Inform the MCP client immediately where to read/tail the output.\n" },
    ],
  },
};

function count(source, needle) { return source.split(needle).length - 1; }
function indentOf(line) { return /^[ ]*/.exec(line)[0]; }

function insertPoint(source, point) {
  if (point.replace) {
    const [original, timed] = point.replace;
    const n = count(source, original);
    if (n !== 1) return { source, status: n === 0 ? "missing" : "ambiguous" };
    return { source: source.replace(original, () => timed), status: "applied" };
  }
  const n = count(source, point.anchor);
  if (n === 0) return { source, status: "missing" };
  if (n > 1 && !point.all) return { source, status: "ambiguous" };
  const anchorLines = point.anchor.split("\n");
  const ref = point.where === "before" ? anchorLines[0]
    : (point.anchor.endsWith("\n") ? anchorLines[anchorLines.length - 2] : anchorLines[anchorLines.length - 1]);
  const indent = point.indent != null ? point.indent : indentOf(ref);
  // Each point is its own try/except: field lookups and set updates included.
  const block = [indent + "try:\n", ...point.lines.map((line) => indent + "    " + line + "\n"),
    indent + "except Exception:\n", indent + "    pass\n"].join("");
  const next = point.where === "before"
    ? source.split(point.anchor).join(block + point.anchor)
    : source.split(point.anchor).join(point.anchor + block);
  return { source: next, status: "applied" };
}

// Returns { source, status: { helper, <event>: applied|already|missing|ambiguous } }.
function patchComponent(component, source) {
  const spec = POINTS[component];
  if (!spec) throw new Error("unknown timing component " + component);
  const status = {};
  if (source.includes(MARKER)) status.helper = "already";
  else if (count(source, spec.helperAnchor) === 1) {
    source = source.replace(spec.helperAnchor, () => spec.helperAnchor + HELPER);
    status.helper = "applied";
  } else {
    status.helper = "missing";
    return { source, status };
  }
  for (const point of spec.points) {
    if (source.includes(`_wb_timing("${point.event}"`)) { status[point.event] = "already"; continue; }
    const result = insertPoint(source, point);
    source = result.source;
    status[point.event] = result.status;
  }
  return { source, status };
}

const FILES = { server: "server.py", session: "sessions.py", client: "stata_client.py" };

// Finds <root>/**/site-packages/mcp_stata (Lib/site-packages on Windows).
function packageDir(root) {
  const fs = require("node:fs");
  const path = require("node:path");
  for (const lib of ["Lib", "lib"]) {
    const base = path.join(root, lib);
    if (!fs.existsSync(base)) continue;
    const direct = path.join(base, "site-packages", "mcp_stata");
    if (fs.existsSync(path.join(direct, "sessions.py"))) return direct;
    for (const name of fs.readdirSync(base)) {
      const dir = path.join(base, name, "site-packages", "mcp_stata");
      if (fs.existsSync(path.join(dir, "sessions.py"))) return dir;
    }
  }
  return null;
}

function inside(child, parent) {
  const path = require("node:path");
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Copies source into out as plain files and directories. Links (symlinks,
// junctions) are followed; a directory reached twice through links is refused.
function copyPlain(source, out, seen = new Set()) {
  const fs = require("node:fs");
  const path = require("node:path");
  const real = fs.realpathSync(source);
  if (seen.has(real)) throw new Error("link cycle at " + source);
  seen.add(real);
  fs.mkdirSync(out);
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name), to = path.join(out, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyPlain(from, to, seen);
    else if (st.isFile()) {
      fs.writeFileSync(to, fs.readFileSync(from), { flag: "wx", mode: st.mode & 0o777 });
    }
  }
  seen.delete(real);
}

// Reads `source`, never writes it; returns the new instrumented copy.
function instrumentCopy(source, { out } = {}) {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  if (!source || !fs.existsSync(source)) return { ok: false, status: "source-not-found", source };
  const sourceReal = fs.realpathSync(source);
  if (!packageDir(sourceReal)) return { ok: false, status: "not-a-runtime", source };
  let target;
  if (out) {
    target = path.resolve(out);
    if (fs.existsSync(target)) return { ok: false, status: "output-exists", out: target };
    const parentReal = fs.realpathSync(path.dirname(target));
    const targetReal = path.join(parentReal, path.basename(target));
    if (inside(targetReal, sourceReal) || inside(sourceReal, targetReal)) {
      return { ok: false, status: "output-overlaps-source", out: target };
    }
  } else {
    target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wp1-timing-runtime-")), "runtime");
  }
  copyPlain(sourceReal, target);
  const dir = packageDir(target);
  const targetReal = fs.realpathSync(target);
  // Check every file to be rewritten before writing any of them.
  const plan = [];
  for (const [component, name] of Object.entries(FILES)) {
    const file = path.join(dir, name);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || !inside(fs.realpathSync(file), targetReal)) {
      return { ok: false, status: "unsafe-output-file", file };
    }
    const raw = fs.readFileSync(file, "utf8");
    const crlf = raw.includes("\r\n");
    const result = patchComponent(component, crlf ? raw.replace(/\r\n/g, "\n") : raw);
    plan.push({ component, file, raw, status: result.status,
      text: crlf ? result.source.replace(/\n/g, "\r\n") : result.source });
  }
  const report = { ok: true, status: "written", source: sourceReal, out: target, dir, components: {} };
  for (const item of plan) {
    report.components[item.component] = item.status;
    if (item.text !== item.raw) fs.writeFileSync(item.file, item.text, "utf8");
  }
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--out");
  const out = at >= 0 ? args[at + 1] : undefined;
  const source = args.find((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));
  if (!source || (at >= 0 && !out)) {
    console.error("usage: node scripts/stata_timing_patch.js <source-runtime> [--out <new-dir>]  (source is read only)");
    process.exit(2);
  }
  const report = instrumentCopy(source, { out });
  console.log(JSON.stringify(report));
  process.exit(report.ok ? 0 : 1);
}

module.exports = { MARKER, ENV, HELPER, POINTS, WAIT_ORIGINAL, WAIT_TIMED, patchComponent, instrumentCopy, packageDir };
