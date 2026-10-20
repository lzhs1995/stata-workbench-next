#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  transformDoSource,
  defaultDocxHelperScript,
} = require("./png_compat_transform");
const python = process.env.PYTHON || "/usr/bin/python3";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}: ${error.stack || error}`);
  }
}

check("putdocx and p_tdocx images use markers and post-save injection", () => {
  const source = [
    "putdocx begin",
    "forvalues i = 1/2 {",
    '    p_tdocx image "${figdir}/d_`i\'.png", width(4in) height(3in)',
    "}",
    'p_tdocx save "${docdir}/report.docx", replace',
  ].join("\n");
  const result = transformDoSource(source, { platform: "darwin" });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.strictEqual(result.transformed, true);
  assert.strictEqual(result.replacements.filter((item) => item.kind === "document-image").length, 1);
  assert.strictEqual(result.replacements.filter((item) => item.kind === "document-save").length, 1);
  assert.ok(result.code.includes("__CODEX_DOCX_IMAGE_V1__|path=${figdir}/d_`i'.png"));
  assert.ok(result.code.includes("width=4in|height=3in"));
  assert.ok(result.code.includes("docx_image_inject.py"));
  assert.ok(!/^\s*p_tdocx\s+image\b/im.test(result.code));
});

check("DOCX transform is idempotent", () => {
  const source = [
    'putdocx image "/tmp/a.png", width(4)',
    'putdocx save "/tmp/a.docx", replace',
  ].join("\n");
  const first = transformDoSource(source, { platform: "darwin" });
  const second = transformDoSource(first.code, { platform: "darwin" });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.code, first.code);
  assert.strictEqual(second.transformed, false);
});

check("SVG document images convert to a temporary PNG before marker insertion", () => {
  const source = [
    'putdocx image "${figdir}/chart.svg", width(4)',
    'putdocx save "${docdir}/chart.docx", replace',
  ].join("\n");
  const result = transformDoSource(source, { platform: "darwin" });
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.ok(result.code.includes("chart.__docxcompat__.png"));
  assert.ok(result.code.includes("png_compat_sips.sh"));
  assert.ok(!/^\s*putdocx\s+image\b/im.test(result.code));
});

check("non-Darwin document commands remain byte-identical", () => {
  const source = 'putdocx image "/tmp/a.png"\nputdocx save "/tmp/a.docx", replace\n';
  const result = transformDoSource(source, { platform: "win32" });
  assert.strictEqual(result.code, source);
  assert.strictEqual(result.transformed, false);
});

check("DOCX helper exists and compiles", () => {
  const helper = defaultDocxHelperScript();
  assert.ok(fs.existsSync(helper), helper);
  if (process.platform !== "darwin") return;
  const result = spawnSync(python, ["-B", "-c",
    "import pathlib, sys; compile(pathlib.Path(sys.argv[1]).read_bytes(), sys.argv[1], 'exec')", helper],
  { encoding: "utf8" });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
});

check("DOCX helper injects images and preserves package namespaces across calls", () => {
  if (process.platform !== "darwin") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docx-image-compat-"));
  const word = path.join(root, "word");
  fs.mkdirSync(path.join(root, "_rels"), { recursive: true });
  fs.mkdirSync(path.join(word, "_rels"), { recursive: true });
  const imagePath = path.join(root, "figure.png");
  fs.writeFileSync(
    imagePath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  );
  const marker =
    `__CODEX_DOCX_IMAGE_V1__|path=${imagePath}|width=4in|height=3in` +
    `|__END_CODEX_DOCX_IMAGE_V1__`;
  fs.writeFileSync(
    path.join(root, "[Content_Types].xml"),
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  fs.writeFileSync(
    path.join(root, "_rels", ".rels"),
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  fs.writeFileSync(
    path.join(word, "document.xml"),
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>${marker}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`
  );
  fs.writeFileSync(
    path.join(word, "_rels", "document.xml.rels"),
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
  );
  const docx = path.join(root, "fixture.docx");
  const zipped = spawnSync(
    "/usr/bin/zip",
    ["-q", "-r", docx, "[Content_Types].xml", "_rels", "word"],
    { cwd: root, encoding: "utf8" }
  );
  assert.strictEqual(zipped.status, 0, zipped.stderr || zipped.stdout);
  const batch = [path.join(root, "batch1.docx"), path.join(root, "batch2.docx")];
  for (const file of batch) fs.copyFileSync(docx, file);
  const injected = spawnSync(python, ["-B", defaultDocxHelperScript(), "--docx", docx], {
    encoding: "utf8",
  });
  assert.strictEqual(injected.status, 0, injected.stderr || injected.stdout);
  assert.strictEqual(injected.stdout, "",
    "successful DOCX injection must stay silent so repeated Stata shell calls cannot fill a pipe");
  const markerPath = docx + ".__docxcompat_ok";
  assert.ok(fs.existsSync(markerPath));
  const result = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  assert.strictEqual(result.injected, 1);
  // One interpreter exercises ElementTree's shared namespace registry. A
  // content-types fix must not prefix relationships on the next document.
  const repeated = spawnSync(python, ["-B", "-c", [
    "import pathlib, runpy, sys",
    "inject = runpy.run_path(sys.argv[1])['inject']",
    "for name in sys.argv[2:]:",
    "    file = pathlib.Path(name)",
    "    assert inject(file)['injected'] == 1",
    "    before = file.read_bytes()",
    "    assert inject(file)['unchanged'] is True",
    "    assert file.read_bytes() == before",
  ].join("\n"), defaultDocxHelperScript(), ...batch], { encoding: "utf8" });
  assert.strictEqual(repeated.status, 0, repeated.stderr || repeated.stdout);
  for (const file of [docx, ...batch]) {
    const documentXml = spawnSync("/usr/bin/unzip", ["-p", file, "word/document.xml"], {
      encoding: "utf8",
    }).stdout;
    const rels = spawnSync("/usr/bin/unzip", ["-p", file, "word/_rels/document.xml.rels"], {
      encoding: "utf8",
    }).stdout;
    // unzip treats brackets as a glob; use Python's exact ZIP member lookup.
    const exactTypes = spawnSync(python, ["-B", "-c",
      "import sys, zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read('[Content_Types].xml'))",
      file], { encoding: "utf8" });
    assert.strictEqual(exactTypes.status, 0, exactTypes.stderr);
    assert.match(exactTypes.stdout, /<Types xmlns="http:\/\/schemas.openxmlformats.org\/package\/2006\/content-types"/);
    assert.match(rels, /<Relationships xmlns="http:\/\/schemas.openxmlformats.org\/package\/2006\/relationships"/);
    const entries = spawnSync("/usr/bin/unzip", ["-Z1", file], { encoding: "utf8" }).stdout;
    assert.ok(documentXml.includes("wp:extent"), documentXml);
    assert.ok(documentXml.includes('cx="3657600"'));
    assert.ok(documentXml.includes('cy="2743200"'));
    assert.ok(!documentXml.includes("__CODEX_DOCX_IMAGE_V1__"));
    assert.ok(rels.includes("relationships/image"));
    assert.ok(entries.includes("word/media/imageCodex1.png"), entries);
    const embedded = spawnSync("/usr/bin/unzip", ["-p", file, "word/media/imageCodex1.png"]).stdout;
    assert.deepStrictEqual(embedded, fs.readFileSync(imagePath));
    const packageRels = spawnSync("/usr/bin/unzip", ["-p", file, "_rels/.rels"]).stdout;
    assert.deepStrictEqual(packageRels, fs.readFileSync(path.join(root, "_rels", ".rels")));
  }
  assert.ok(fs.existsSync(markerPath));
});

check("DOCX preserves QName namespace values and nested scope", () => {
  const result = spawnSync(python, ["-B", path.join(__dirname, "test_docx_namespace_unit.py")], {
    encoding: "utf8",
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
});

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nDOCX_IMAGE_COMPAT_UNIT_PASS");
