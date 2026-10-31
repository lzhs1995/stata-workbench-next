"use strict";
// mcp-stata 1.26.1 StataClient.init(): the pre-flight subprocess starts a second
// Stata just to run `display 1`, with a hard 60 s limit. On a loaded Windows
// machine (rc.7.44 runbook step 1, 2026-10-30) Stata 18 MP printed its banner but
// did not return within 60 s, the worker failed to initialize and the default
// session stayed in "error". Read the limit from MCP_STATA_PREFLIGHT_TIMEOUT
// (seconds, default 180, clamped to 60..900); refuse unknown sources.
const ORIGINAL = `                                # Increased timeout to 60s to handle cold starts and license checks on macOS
                                res = subprocess.run(
                                    [py_exe, "-c", preflight_code],
                                    capture_output=True, text=True, timeout=60, env=env
                                )
`;
const MARKER = "Workbench pre-flight timeout follows MCP_STATA_PREFLIGHT_TIMEOUT";
const REPLACEMENT = `                                # ${MARKER} (default 180 s, clamped to 60..900 s).
                                try:
                                    preflight_timeout = float(os.environ.get("MCP_STATA_PREFLIGHT_TIMEOUT", "180"))
                                except ValueError:
                                    preflight_timeout = 180.0
                                if not preflight_timeout == preflight_timeout:
                                    preflight_timeout = 180.0
                                preflight_timeout = min(max(preflight_timeout, 60.0), 900.0)
                                res = subprocess.run(
                                    [py_exe, "-c", preflight_code],
                                    capture_output=True, text=True, timeout=preflight_timeout, env=env
                                )
`;

function patchClient(source) {
  const originals = source.split(ORIGINAL).length - 1;
  const patched = source.split(REPLACEMENT).length - 1;
  if (patched === 1 && originals === 0) return source;
  if (source.includes(MARKER) || originals !== 1 || patched !== 0) {
    throw new Error("unsupported pre-flight timeout source");
  }
  return source.replace(ORIGINAL, () => REPLACEMENT);
}

module.exports = { ORIGINAL, REPLACEMENT, MARKER, patchClient };
