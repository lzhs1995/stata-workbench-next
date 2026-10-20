"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { scanDoReferences } = require("./stata_do_references");

function slash(value) {
  return value ? String(value).replace(/\\/g, "/").replace(/\/$/, "") : null;
}

function firstExistingRoot(options = {}) {
  const candidates = [];
  const add = (value) => {
    if (!value) return;
    const resolved = path.resolve(String(value));
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };
  add(options.stataRoot);
  add(options.sourcePath && path.dirname(options.sourcePath));
  add(options.cwd);
  for (const root of options.workspaceRoots || []) {
    add(root);
    add(path.join(root, "开题报告"));
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, "demo.do")) ||
          fs.existsSync(path.join(candidate, "WORLD_STRICT_EXTREME_PRESSURE_TEST_PLAN.md"))) {
        return candidate;
      }
    } catch {}
  }
  return candidates[0] || null;
}

function deriveRoots(options = {}) {
  const stataRoot = firstExistingRoot(options);
  let cnmRoot = options.cnmRoot ? path.resolve(String(options.cnmRoot)) : null;
  if (!cnmRoot && stataRoot) {
    const normalized = slash(stataRoot);
    const marker = "/cnm/";
    const index = normalized.indexOf(marker);
    if (index >= 0) cnmRoot = normalized.slice(0, index + marker.length - 1);
  }
  const documentsRoot = options.documentsRoot
    ? path.resolve(String(options.documentsRoot))
    : (cnmRoot ? path.dirname(cnmRoot) : null);
  return {
    stataRoot: slash(stataRoot),
    cnmRoot: slash(cnmRoot),
    documentsRoot: slash(documentsRoot),
  };
}

function rewriteQuotedPathSeparators(source) {
  let count = 0;
  const code = String(source).replace(/"([^"\r\n]*)"/g, (quoted, inner) => {
    const pathLike = /[A-Za-z]:[\\/]/.test(inner) ||
      /(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)\\/.test(inner) ||
      /\/Users\//.test(inner);
    if (!pathLike) return quoted;
    const replaced = inner.replace(/\\(?=[^\s"'\\])/g, () => {
      count += 1;
      return "/";
    });
    return `"${replaced}"`;
  });
  return { code, count };
}

function protectDynamicGraphNames(source) {
  const input = String(source);
  const macroName = `__ws_nopt_${sha256(Buffer.from(input)).slice(0, 8)}`;
  let count = 0;
  let code = input.replace(
    /\bname\((?=[^)\r\n]*`[^)\r\n]*')/g,
    () => {
      count += 1;
      return "`" + macroName + "'(";
    },
  );
  if (count > 0) {
    code = `local ${macroName} name\n${code}\ncapture macro drop ${macroName}\n`;
  }
  return { code, count, macroName: count > 0 ? macroName : null };
}

function ensurePaginationOff(source) {
  const input = String(source == null ? "" : source);
  if (!input.trim()) return { code: input, applied: false };
  if (/^\s*(?:capture\s+)?set\s+more\s+off(?:\s*(?:\/\/[^\r\n]*)?)?(?:\r?\n|$)/i.test(input)) {
    return { code: input, applied: false };
  }
  return { code: `set more off\n${input}`, applied: true };
}

function protectTransportLog(source) {
  // codex patch rc.7.10.33: every visible entry point preserves the live transport log.
  let count = 0;
  const code = String(source == null ? "" : source).replace(
    /^\s*(?:capture\s+)?log\s+close\s+_all\s*(?:(?:\/\/|\*)[^\r\n]*)?$/gmi,
    () => {
      count += 1;
      return 'display as text "[Workbench transport guard] skipped log close _all to preserve live Terminal log"';
    },
  );
  return { code, count };
}

function transformSource(source, options = {}) {
  const input = String(source == null ? "" : source);
  const platform = options.platform || process.platform;
  const roots = deriveRoots(options);
  const diagnostics = {
    platform,
    applied: false,
    bomStripped: false,
    rootRewrites: 0,
    separatorRewrites: 0,
    dynamicGraphNameProtections: 0,
    dynamicGraphNameMacro: null,
    roots,
  };
  let code = input;
  if (platform === "darwin") {
    if (code.charCodeAt(0) === 0xfeff) {
      code = code.slice(1);
      diagnostics.bomStripped = true;
    }
    const patterns = [
      [/(?:C:)[\\/]+Users[\\/]+LZHS[\\/]+Desktop[\\/]+开题报告/gi, roots.stataRoot],
      [/(?:C:)[\\/]+Users[\\/]+LZHS[\\/]+Desktop[\\/]+cnm/gi, roots.cnmRoot],
      [/(?:C:)[\\/]+Users[\\/]+LZHS[\\/]+Desktop/gi, roots.documentsRoot],
    ];
    for (const [pattern, replacement] of patterns) {
      if (!replacement) continue;
      code = code.replace(pattern, () => {
        diagnostics.rootRewrites += 1;
        return replacement;
      });
    }
    const separated = rewriteQuotedPathSeparators(code);
    code = separated.code;
    diagnostics.separatorRewrites = separated.count;
    const graphNames = protectDynamicGraphNames(code);
    code = graphNames.code;
    diagnostics.dynamicGraphNameProtections = graphNames.count;
    diagnostics.dynamicGraphNameMacro = graphNames.macroName;
  }
  const transportLog = options.protectTransportLog
    ? protectTransportLog(code)
    : { code, count: 0 };
  code = transportLog.code;
  diagnostics.transportLogCloseGuards = transportLog.count;
  diagnostics.applied = code !== input;
  return { code, diagnostics };
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function makeCompatCopy(sourcePath, options = {}) {
  const original = fs.readFileSync(sourcePath);
  const originalText = original.toString("utf8");
  const transformed = transformSource(original.toString("utf8"), {
    ...options,
    sourcePath,
  });
  let code = transformed.code;
  // Descendants are prepared before the parent's PNG/DOCX conversion. Only
  // execution copies are rewritten, never the author's source files.
  if (options.recursiveReferencedDo && options.referenceState) {
    code = prepareReferences(code, { ...options, sourcePath }, options.referenceState);
  }
  let secondaryTransform = null;
  if (typeof options.transformReferencedCode === "function") {
    const secondary = options.transformReferencedCode(code, {
      platform: options.platform || process.platform,
      sourcePath,
      diagnostics: transformed.diagnostics,
    });
    if (typeof secondary === "string") {
      code = secondary;
    } else if (secondary && typeof secondary.code === "string") {
      code = secondary.code;
      secondaryTransform = secondary.diagnostics || null;
    } else if (secondary != null) {
      throw new Error("transformReferencedCode must return a string or { code, diagnostics }");
    }
  }
  if (code === originalText) {
    return {
      path: sourcePath,
      changed: false,
      diagnostics: { ...transformed.diagnostics, secondaryTransform },
    };
  }
  const tempRoot = fs.mkdtempSync(path.join(options.tempRoot || os.tmpdir(),
    "stata-workbench-compat-"));
  const target = path.join(tempRoot, path.basename(sourcePath));
  fs.writeFileSync(target, code, "utf8");
  const originalAfter = fs.readFileSync(sourcePath);
  if (sha256(original) !== sha256(originalAfter)) {
    throw new Error("source file changed while preparing compatibility copy");
  }
  return {
    path: target,
    changed: true,
    diagnostics: {
      ...transformed.diagnostics,
      applied: true,
      secondaryTransform,
      sourcePath,
      tempPath: target,
      sourceSha256: sha256(original),
      sourceIntact: true,
    },
  };
}

function referenceError(reason, sourcePath) {
  const error = new Error(`${reason}: ${sourcePath}`);
  error.code = "REFERENCED_DO_PREPARATION_FAILED";
  return error;
}

function prepareReferences(source, options, state) {
  const scan = scanDoReferences(source);
  state.unsupported.push(...scan.unsupported.map(item => ({ ...item, sourcePath: options.sourcePath || null })));
  // A dynamic child or a cd anywhere in a file defeats a static cwd inference.
  // Absolute paths are still safe to resolve without guessing Stata's cwd.
  if (scan.changesCwd || scan.unsupported.length) state.cwdUncertain = true;
  const replacements = [];
  for (const ref of scan.refs) {
    if (state.cwdUncertain && !path.isAbsolute(ref.filePath)) {
      if (options.recursiveReferencedDo) throw referenceError("relative DO after uncertain working directory", ref.filePath);
      continue;
    }
    const resolved = path.resolve(options.cwd || process.cwd(), ref.filePath);
    try {
      const canonical = fs.realpathSync(resolved);
      if (!fs.statSync(canonical).isFile()) throw referenceError("DO is not a regular file", resolved);
      if (state.active.has(canonical)) throw referenceError("cyclic DO reference", resolved);
      if (state.active.size >= 16) throw referenceError("DO reference depth exceeds 16", resolved);
      if (++state.visits > 256) throw referenceError("DO reference count exceeds 256", resolved);
      // Bound synchronous reads on the extension-host event loop.
      state.bytes += fs.statSync(canonical).size;
      if (state.bytes > 16 * 1024 * 1024) throw referenceError("DO source budget exceeds 16 MiB", resolved);
      state.active.add(canonical);
      let copy;
      try {
        copy = makeCompatCopy(resolved, { ...options, referenceState: state });
      } finally {
        state.active.delete(canonical);
      }
      if (copy.changed) {
        state.copies.push(copy.diagnostics);
        replacements.push({ ...ref, path: slash(copy.path) });
      }
    } catch (error) {
      // Darwin must not silently run the original after a failed transform.
      if (options.recursiveReferencedDo) throw referenceError(error.message, resolved);
      state.unsupported.push({ sourcePath: resolved, reason: error.message });
    }
  }
  let code = source;
  for (const ref of replacements.reverse()) code = code.slice(0, ref.start) + ref.path + code.slice(ref.end);
  return code;
}

function prepareExecutionCode(source, options = {}) {
  const compatOptions = {
    ...options,
    protectTransportLog: options.protectTransportLog !== false,
  };
  let transformed = transformSource(source, compatOptions);
  const state = { copies: [], unsupported: [], active: new Set(), visits: 0, bytes: 0, cwdUncertain: false };
  const copies = state.copies;
  let code = prepareReferences(transformed.code, compatOptions, state);
  const pagination = ensurePaginationOff(code);
  code = pagination.code;
  transformed = {
    code,
    diagnostics: {
      ...transformed.diagnostics,
      applied: transformed.diagnostics.applied || copies.length > 0 || pagination.applied,
      paginationGuardApplied: pagination.applied,
      referencedDoCopies: copies,
      unresolvedDoReferences: state.unsupported,
      referenceCoverage: state.unsupported.length ? "partial-static" : "literal-do-only",
    },
  };
  return transformed;
}

module.exports = {
  deriveRoots,
  ensurePaginationOff,
  makeCompatCopy,
  prepareExecutionCode,
  protectDynamicGraphNames,
  protectTransportLog,
  rewriteQuotedPathSeparators,
  transformSource,
};
