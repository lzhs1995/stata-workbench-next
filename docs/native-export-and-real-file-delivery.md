# Native export failures and usable research delivery

## Establish native termination before continuing

A cancelled HTTP request, a settled transport promise and an exited controller
do not establish that embedded Stata has stopped. Record these separately from
the native worker's state. Inspect the original worker identity, open output
files, log progress and a bounded native stack sample where available. Never
clear readiness flags, launch a replacement backend or replay a request simply
because its transport returned a terminal result.

In one macOS shared-session incident, the first PNG export left a zero-byte
file open. A native sample showed the Stata bitmap conversion path waiting in
Java/AWT AppKit initialization while the Python main thread remained in its
event loop. This supports a native wait in that observed process; it does not
prove the root cause of every graph timeout, a general macOS defect or a remedy.
An earlier Windows graphics incident is not evidence for the same cause.

A bridge cleanup patch can repair its own request bookkeeping without releasing
that native wait. Keep its offline tests, installation, loaded code and actual
session recovery as separate statuses. Use only supported recovery on the bound
session, and preserve failed receipts. Do not repeatedly send breaks or escalate
to resetting shared state without the necessary recovery authority.

## Follow the actual wire through nested DO files

The incident also exposed a plugin coverage gap. The installed adapter prepared
one referenced DO, but did not inspect a second DO called by that wrapper. The
recorded request reported zero Darwin conversions and no compatibility copies;
an offline replay of that exact wire reproduced those diagnostics. Recursive
preparation reached the 24 raster exports in the inner export file. This ties
the compatibility gap to the failed request without claiming that VS Code as
a whole stopped responding or that the underlying Java/AWT defect is fixed.

The adapter now prepares literal, double-quoted `.do` references recursively on
macOS, writing temporary execution copies from child to parent. It preserves
the author's source bytes and path-token surrounding text. Commented and quoted
examples, including multiline compound strings, are not DO commands. Retain
`sourceCompatibility` and `darwinCompatibility` from the same request as its
wire, cwd, source hashes, and prepared copy hashes.

This is a bounded static scanner, not a Stata interpreter:

- Only line-start `do` with optional capture/quietly/noisily prefixes is followed.
  Macro paths, `run`, `include`, and semicolon-delimited references are reported
  as `partial-static` and retained; other dynamic command forms are not certified.
- A changed or uncertain working directory prevents guessing relative DO paths.
  Use explicit absolute paths in an isolated execution wrapper when needed.
- Missing literal files, cycles, more than 16 nested files, 256 reference visits,
  or 16 MiB cumulative source reads fail preparation. A literal file generated
  later at run time must be split into a separately prepared stage after it exists.
- A descendant conversion failure rejects the complete prepared submission;
  `capture do` cannot hide that failure and continue the rest of the wrapper.
- Unsupported dynamic references are not a complete graph safety guarantee.
  Inspect/materialize the actual export DO before using that route for raster
  export. Do not send native PNG probes into an occupied research session.

SVG plus the macOS converter avoids this observed native raster path, but is
not a claim of pixel identity with Stata's native PNG rendering. Source tests,
package dependency tests, installed code, loaded code, and real graph output
must each be evidenced separately. Offline conversion of a DO is not a graph.

A bounded recovery on the existing Workbench successfully reloaded a saved GPH
and exported it through a frozen, preconverted SVG/converter DO: Stata returned
0 and produced a decoded, nonblank 1200 × 800 RGB PNG (93,621 bytes). No data or
model was recalculated. The earlier recovery attempt used `graph use ..., nodraw`
and failed at SVG export with `could not find Graph window`, r(693), before the
converter ran. Removing `nodraw` in a new isolated recovery copy resolved that
specific failure. Retain both attempts; r(693) alone is not a disk-full diagnosis.

The successful recovery used the candidate's prepared files through the existing
extension; the candidate extension itself was not installed or hot-loaded. This
initially validated one saved-graph recovery. A subsequent single submission
used the audited saved DTA for the remaining 23 PNG/GPH pairs, without rerunning
data cleaning, scores or models. All 24 PNGs decoded, were nonblank and were
visually reviewed in a contact sheet. The 23-pair run returned 0; its data
signature, frame, graph inventory and current-graph restoration assertions
passed, and the same backend was ready afterward. These are bounded recovery
checks, not pixel identity with native raster output or full candidate live
acceptance. Preserve the original failed run separately.

Loading/drawing a private graph inside Stata does not require stealing OS
focus when the user has authorized covered or hidden Workbench execution.

The shared Python client preserves a failed `_httperror` response verbatim and
extracts its run/request identity and return code into a separate diagnostic
file. Conflicting envelope fields are not combined. HTTP errors remain failed
even if nested or top-level fields look successful, and a missing ID never
authorizes a retry. Record HTTP settlement and native termination separately.

## Export data before independent graph stages

Save data checkpoints before graph conversion. Put precision CSV exports in a
separate saved DO file with its own receipt, output directory and completion
markers. Graph export failures must not prevent delivery of an already-saved
dataset. For an existing failed run, bind audited DTA inputs by hash and export
them to a new directory after the native session is genuinely available; do not
recompute a successful data block merely to recover its missing CSV files.

Preserve variable order, literal string identifiers, Stata missing-value codes
and the author's naming. Record formatting changes such as `%24.17g` separately
from transformations of stored values. Compare exported strings and numeric
values against the saved DTA, including missing values and column membership;
CSV has no substitute for the DTA's labels, types and metadata. Keep the
author's rounded export as a separate historical artifact.

Use short, readable Stata commands and comments explaining each narrow change.
Shared-session protection belongs in a clearly identified wrapper. Do not bury
the author's transformation logic in an unrelated framework. A prepared DO is
not an executed DO, a source span is not dynamic branch coverage, and completed
stage counts are not counts of fully reproduced source files.

## Deliver files a researcher can open

Organize actual DTA, CSV and executable/commented DO files under chapter folders,
with upstream inputs and historical comparisons. If chapter attribution is
unresolved, use an explicitly named cross-chapter folder and explain the gap.
The chapter README should link the real files, state their execution order,
distinguish runnable and review-only code, and list concrete unresolved issues.
JSON manifests and hashes support this delivery; they do not replace the files.

For large remote files, provide a verified retrieval location and instructions
only after upload and ordinary roundtrip content verification. A requested path
or local archive is not a cloud download link. Distinguish full-file equality,
common-column value equality, metadata differences and unverified historical R
adoption. Do not infer downstream adoption or alter manuscripts from equal N.

Backup budgets include the user's reserve plus peak upload/download/extraction
writes. Process bounded packages and recheck actual free space. Files still open
by a failed worker can be retained as clearly labelled failure snapshots; they
are not terminal outputs and must not be cleaned up as completed work. See
[storage and recovery](storage-and-log-recovery.md).

This is operational guidance from a bounded incident and delivery audit. It
does not install a runtime fix, certify native recovery, establish scientific
validity or certify simultaneous execution in multiple Stata instances.

## Preserve existing Mata state before table commands

A shared session may already contain Mata objects created by the Workbench's
own checkpoint code. A precondition that Mata must be empty can reject a table
stage before any author command executes. In one recorded incident, four
`__codex_*` objects were present; this did not establish a frozen VS Code window
or a failure of `asdoc`. Keep the failed request and its skipped checks. A later
diagnostic cannot retroactively certify restoration steps the failed wrapper
did not run.

Inventory existing names and protect supported Mata values, matrices, scalars,
macros and open handles in a separate execution wrapper. Do not clear shared
Mata or close unknown handles to satisfy a guard. The bounded successor saved
and restored the existing ordinary objects and verified seven return markers.
This is evidence for that inventory and wrapper, not a universal serializer for
pointers, external resources or every possible Mata type.

Stata's extended macro-list `==` comparison is order-sensitive; `===` checks
membership irrespective of order. For an unordered name inventory use `===`,
then separately verify each saved value and whether the name originally
existed. A set comparison alone does not protect macro content. Match a
versioned verifier to the exact restoration markers; preserve the execution
receipt and add an offline verifier when marker names change, rather than
repeating successful Stata work just to satisfy an old regex.

## Separate RTF text encoding from table numbers and page layout

One actual `asdoc` output declared ANSI while containing raw UTF-8 Chinese
labels. Four original RTF files and their precision CSVs were retained. The
successor display copies converted only non-ASCII text to standard RTF Unicode
escapes; inverse text recovery was exact and all 124 table numbers were
independently checked against the saved DTA. Native text readback confirmed
readable Chinese. No new calculation was needed.

Inspect the actual bytes and declarations before choosing a conversion; do not
blindly re-encode arbitrary RTF or change its control syntax. Keep the native
file separate from the labelled display copy and pin both hashes. Successful
text parsing is not Word page-rendering acceptance, and rounded RTF figures
must use their printed precision while the CSV is checked at full precision.

## Keep preserve/restore boundaries and historical numbers explicit

A final `save` after `restore` saves the restored dataset, not the temporary
dataset used inside `preserve`. Audit the full boundary. If the temporary sample
is useful for checking a table, save it as an explicitly new isolated checkpoint
before restoration; do not pretend it was an original author output or merge
its variables into the final panel. Keep new logging/export commands annotated.

In the bounded follow-up, two saved DTA/CSV pairs contained 2,293,608 cells that
matched independent reconstruction, and 146 returned scalars from seven
t-tests and four contingency tables matched independent calculations. Four
statistics differed from comments in the historical DO; those old numbers
were retained and reported beside the new results. Matching a test calculation
does not validate its independence assumptions for repeated panel observations
or establish that historical R scripts adopted the regenerated data.

DTA sort-list entries terminate at the first zero. Compare only active sort
indices, not reserved trailing storage. Retain a failed offline checker and
document its correction; do not rerun statistical work because an audit reader
mistook unused bytes for active metadata.

These additions describe observed execution and bounded checks. They do not
install/reload the extension, certify every export path or guarantee that
future operating-system graphics failures cannot occur.

## Preserve column order, coding direction and stored precision

`keep` selects variables without necessarily reordering them. If a supplemental
DTA must match an author's CSV column list, use a separately annotated `order`
after `keep`; verify the ordered names as well as all values. A recode before
`preserve` remains in force after `restore`. Trace the actual sequence before
assuming a later graph or export still uses the original categories.

In one bounded comparison, the current source collapsed seven frequency
categories to five before a positive linear transformation. Historical exports
instead matched a seven-category reverse transformation after float32 storage.
That finding identifies a reproducible value relationship, not the unknown
historical executed program. Retain the author track and report the difference;
do not silently change it to force equality with a same-named historical file.

Report CSV text equality, full stored-value equality and float32 roundtrip
separately. A default CSV can look close yet fail roundtrip for a few cells;
a precision CSV checked against every saved DTA cell resolves export loss,
not a category/direction mismatch. Same-name DTA files can have different row
counts, columns and versions. Compare common keys and unmatched rows, including
literal string IDs; actual differences between two string IDs are not merely a
numeric display-format issue. Do not expose individual identifiers in public
experience reports.

Rank ties can leave a percentile-defined low group empty. Preserve the author's
missing result and report it instead of splitting ties to manufacture a group.
Reconstruct calculations using the actual float/double storage at each step:
rounding a transformed score can create ties that unrounded arithmetic lacks.
Execution agreement does not validate a claimed scientific property of a score.

## Larger graph batches remain bounded output checks

A later single request read an already audited checkpoint and produced 84 PNG
and 84 native GPH files, expanding four author plotting statements across 21
variables and performing seven display commands. Frozen SVG/converter copies
provided raster export; no data cleaning, scoring or model was repeated. All
PNG files decoded and all seven contact sheets were visually inspected. Eight
recorded restoration checks passed and the same backend was ready afterward.

Keep graph filenames and author titles; use private in-memory graph names.
Record expanded-command coverage, original and prepared source hashes, native
terminal evidence and the exact scope of restoration. Native GPH headers plus
successful saves do not establish separate reload acceptance. Contact sheets
do not establish every-pixel or historical/native-PNG identity. This larger
batch demonstrates that recovery route only; it neither installs the candidate
extension nor permanently fixes native Java/AWT initialization or certifies
multiple simultaneous Stata backends.


## Preserve installed repairs when preparing a new candidate

Before installation, compare the actual installed bundle and runtime modules
with the candidate, not just version numbers or a green pull-request check.
In this release review, the recursive-export candidate initially omitted the
installed finalizer, bounded Terminal history, source-column/graph routing and
log-tail yielding repairs. Installing it would have reverted those changes.

The maintenance replay now includes all four installed patch modules and the
finalizer return-code parser. Their behavioral regressions run in the release
check, while the candidate retains recursive DO preparation and its isolated
package dependency tests. The rebuilt bundle matches the installed bundle; the
new export behavior resides in the separately pinned compatibility modules.
Verify both bundle and module hashes inside the final VSIX. These offline
checks do not prove that an existing VS Code host has loaded the candidate or
that its actual graph/table output passes live acceptance.


## Diagnose DOCX package compatibility before repeating Stata

A saved DOCX can pass ZIP integrity and XML parsing while an office application
still refuses to load it. Preserve that file and compare isolated copies before
rerunning its Stata producer. In one bounded failure, changing only the content
types element's namespace serialization let LibreOffice load the document; the
original prefixed XML was well-formed. This identified a package compatibility
problem rather than a failed calculation or a generally broken office install.

The image injection helper now serializes `[Content_Types].xml` with the package
content-types namespace as the default. Python ElementTree's namespace registry
is process-global: restore the relationships default namespace in `finally`,
including on failure, so a second injection in the same interpreter preserves
its relationship serialization. Check consecutive calls, image bytes, unchanged
package members, and a marker-free call that leaves the file byte-identical.

The regression used the same synthetic table and PNG with the old helper and
the repaired helper. The old result failed to load in LibreOffice; two repaired
documents converted to PDF and both one-page renders were visually inspected.
Their table cells and embedded PNG bytes matched, and only `[Content_Types].xml`
differed among the unzipped old/new package members. Six helper/adapter controls
passed. This validates the helper's bounded package and LibreOffice behavior,
not Microsoft Word, a newly installed runtime, or all document layouts. Preserve
the original failure and keep helper, package, application and page acceptance
separate. No Stata rerun or active runtime reload was needed for this diagnosis.

## Bind source checks to the submitted request

A complete source inventory includes the entry DO, every expected nested DO and
ADO, and actual temporary execution copies. Require every expected pre- and
post-execution hash; an empty or missing inventory must fail instead of passing
vacuously. Bind diagnostics to the exact HTTP request and actual submitted code
hash. A predicted transformed-source hash from an offline replay is not observed
runtime evidence. Check conflicting IDs or copies as failures, and keep missing
evidence unknown. These checks do not establish scientific correctness by themselves.

Comment scanners may preserve character offsets while replacing newlines inside
block comments. Use offsets from the original text when resolving line-based
citations; splitting the mask into lines can incorrectly mark executable source
as commented out. Preserve both a reviewer-checker correction and an executor
erratum when applicable; neither justifies repeating already accepted Stata work.
