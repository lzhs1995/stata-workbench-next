"use strict";

const fs = require("fs");
const path = require("path");
const sourceCompat = require("./stata_source_compat_core");

const DARWIN_COMMAND_RE = /\bgraph\s+export\b|\b(?:putdocx|p_tdocx)\s+(?:image|save)\b/i;

function failCode(kind, reason) {
  const safe = String(reason || "unsupported").replace(/"/g, "'").slice(0, 180);
  return `display as error "${kind}: ${safe}"\nexit 693\n`;
}

function prepareVisibleExecution(source, options = {}) {
  const original = String(source == null ? "" : source);
  const platform = options.platform || process.platform;
  const extensionRoot = options.extensionRoot || path.join(__dirname, "..");
  const transformerPath = path.join(extensionRoot, "scripts", "mac", "png_compat_transform.js");
  const pngHelper = path.join(extensionRoot, "scripts", "mac", "png_compat_sips.sh");
  const docxHelper = path.join(extensionRoot, "scripts", "mac", "docx_image_inject.py");
  const darwinRuns = [];

  function transformDarwin(code, context = {}) {
    const input = String(code == null ? "" : code);
    const needed = platform === "darwin" && DARWIN_COMMAND_RE.test(input);
    if (!needed) {
      return {
        code: input,
        diagnostics: { ok: true, needed: false, applied: false, scope: context.scope || null },
      };
    }
    const base = {
      needed: true,
      scope: context.scope || null,
      sourcePath: context.sourcePath || null,
    };
    if (![transformerPath, pngHelper, docxHelper].every((file) => fs.existsSync(file))) {
      const diagnostics = {
        ...base,
        ok: false,
        applied: true,
        error: "DARWIN_COMPAT_HELPER_MISSING",
      };
      return { code: failCode("DARWIN_COMPAT_HELPER_MISSING", "packaged helper missing"), diagnostics };
    }
    try {
      const result = require(transformerPath).transformDoSource(input, {
        platform: "darwin",
        helperScript: pngHelper,
        docxHelperScript: docxHelper,
      });
      const replacements = result.replacements || [];
      const diagnostics = {
        ...base,
        ok: !!result.ok,
        applied: !!result.transformed,
        replacements: replacements.length,
        documentImages: replacements.filter((item) => item.kind === "document-image").length,
        documentSaves: replacements.filter((item) => item.kind === "document-save").length,
        reason: result.reason || result.note || null,
        error: result.error || null,
      };
      if (!result.ok) {
        return {
          code: failCode("DARWIN_COMPAT_UNSUPPORTED", result.reason || result.error),
          diagnostics: { ...diagnostics, applied: true },
        };
      }
      return { code: result.code, diagnostics };
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      return {
        code: failCode("DARWIN_COMPAT_TRANSFORM_EXCEPTION", reason),
        diagnostics: {
          ...base,
          ok: false,
          applied: true,
          error: "DARWIN_COMPAT_TRANSFORM_EXCEPTION",
          reason,
        },
      };
    }
  }

  const compatOptions = {
    platform,
    cwd: options.cwd,
    sourcePath: options.sourcePath,
    workspaceRoots: options.workspaceRoots || [],
    stataRoot: options.stataRoot,
    cnmRoot: options.cnmRoot,
    documentsRoot: options.documentsRoot,
    tempRoot: options.tempRoot,
  };
  if (platform === "darwin") {
    compatOptions.recursiveReferencedDo = true;
    compatOptions.transformReferencedCode = (code, context) => {
      const transformed = transformDarwin(code, { ...context, scope: "referenced-do" });
      if (transformed.diagnostics.needed) darwinRuns.push(transformed.diagnostics);
      if (!transformed.diagnostics.ok) {
        throw new Error(transformed.diagnostics.reason || transformed.diagnostics.error || "Darwin transformation failed");
      }
      return transformed;
    };
  }

  let prepared;
  try {
    prepared = sourceCompat.prepareExecutionCode(original, compatOptions);
  } catch (error) {
    if (platform !== "darwin") throw error;
    const reason = error && error.message ? error.message : String(error);
    return {
      code: failCode("REFERENCED_DO_PREPARATION_FAILED", reason),
      sourceDiagnostics: { applied: false, preparationFailed: true, reason },
      darwinDiagnostics: {
        ok: false, applied: true, replacements: 0, referencedFiles: 0,
        error: "REFERENCED_DO_PREPARATION_FAILED", reason, runs: darwinRuns,
      },
    };
  }
  const direct = transformDarwin(prepared.code, {
    scope: "direct",
    sourcePath: options.sourcePath || null,
  });
  if (direct.diagnostics.needed) darwinRuns.push(direct.diagnostics);

  const diagnostics = platform === "darwin" ? {
    ok: darwinRuns.every((run) => run.ok),
    applied: darwinRuns.some((run) => run.applied),
    replacements: darwinRuns.reduce((sum, run) => sum + (run.replacements || 0), 0),
    documentImages: darwinRuns.reduce((sum, run) => sum + (run.documentImages || 0), 0),
    documentSaves: darwinRuns.reduce((sum, run) => sum + (run.documentSaves || 0), 0),
    referencedFiles: darwinRuns.filter((run) => run.scope === "referenced-do").length,
    runs: darwinRuns,
    reason: darwinRuns.length ? null : "no graph/document compatibility command found",
    error: darwinRuns.find((run) => !run.ok)?.error || null,
  } : {
    ok: true,
    applied: false,
    replacements: 0,
    documentImages: 0,
    documentSaves: 0,
    referencedFiles: 0,
    runs: [],
    reason: "non-darwin",
    error: null,
  };

  return {
    code: direct.code,
    sourceDiagnostics: prepared.diagnostics,
    darwinDiagnostics: diagnostics,
  };
}

module.exports = {
  DARWIN_COMMAND_RE,
  failCode,
  prepareVisibleExecution,
};
