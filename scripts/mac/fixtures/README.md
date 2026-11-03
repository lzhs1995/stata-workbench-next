# DOCX namespace regression fixture

`python-docx-document.xml` was generated with python-docx 1.2.0 using
`Document()`, a paragraph, a two-by-two table, and a Workbench image-marker
paragraph, then extracted from `word/document.xml` without XML rewriting.
SHA-256: `295444694683be40ddf99a1bc3072155a5fcd798e5ef430057bf63fa309eb046`.

The default template declares `w14` and `wp14` only for the root
`mc:Ignorable` value. Removing those declarations reproduces the native Word
unreadable-content prompt. Tests use the frozen XML and only the Python standard
library; they do not require python-docx to be installed.

# Synthetic realbatch corpus

`realbatch-synthetic/` stands in for the local real-batch corpus
(`开题报告/7_temp/realbatch/tmpdo/`), which only exists on the author's Mac and
may be empty. `test_png_compat_unit.js` scans it with the same classifier as
the real corpus and asserts exact counts: 4 raster files, 2 transformed
(`.png`, `.jpg` with `as(jpg)`), 1 noop (raster export only in a comment),
1 unsupported (`#delimit ;` with a raster export,
`delimit_semicolon_with_darwin_compat_command`); the `.svg`-only file is
skipped by the raster prefilter. The unsupported file is the positive control
for the real-corpus `unsupported === 0` check.
