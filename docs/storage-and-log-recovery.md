# Disk planning, verified backup and SMCL receipts

These lessons concern long historical Stata pipelines in an existing shared
Workbench. They supplement [execution policy and concurrency](shared-execution-and-concurrency.md).
They do not change the runtime, create a cloud connector or certify concurrent
Stata instances.

## Budget each unsubmitted stage

Measure free space before dispatch. Estimate the largest simultaneous DTA, CSV,
temporary and verification files, plus a reserve for the shared machine. A small
input can expand sharply after reshape or join; compressed backup size is not
the space needed to execute or restore it. Stage large exports one branch at a
time. Preserve any disk-full error and partial outputs before versioning a repair.

When space is insufficient, defer that write-heavy stage and continue independent
source review, receipt reconciliation, documentation and backup preparation.
Do not lower the budget merely to pass a check, restart the backend or submit a
completed stage again. A user-permitted covered window is a separate condition
and does not prevent these activities.

## Trigger backup before crossing the free-space reserve

Record the user's reserve in bytes and check it before every large stage. In the
2026-10-01 historical case the user requested **10 GB = 10,000,000,000 bytes**.
The documented 2026-10-18 continuation has an explicit **20 GB = 20,000,000,000
bytes** user requirement, which takes precedence for that task. Start backup of
completed large files when current free space is below the applicable reserve,
or when the next stage's estimated peak writes would take it below the reserve.
Keep any higher existing stage budget. These are task policies, not new runtime
defaults.

Prepare manifests and bounded packages early and send them to the authorized
**dedicated task folder** through the existing transfer coordinator. Budget the
upload cache, downloaded verification copy and packaging temporary files too.
Recheck free space after a queue or lock wait and between large packages; a past
measurement cannot account for other writers on the same disk. Reserve enough
space for the backup itself before dispatching further large research exports.

Uploading alone frees no local space. Reclaim only the owned, completed files
allowed by the task's storage policy after complete round-trip SHA verification
and settlement. Preserve raw inputs, frozen scientific bytes and failure records.
Continue source review, dependency tracing and documentation while a write-heavy
stage waits; do not pause all work, lower its budget or replay successful stages.

A short contention on the existing transfer-consumer lock may be handled by a
bounded acquisition wait before any transfer submission. Preserve the lock's
inode, record timeout as zero submission only when the evidence proves it, and
recheck identity and disk budget after acquiring it. This is distinct from the
short desktop-focus lease and never authorizes retrying a cloud operation whose
outcome is unknown. The local successor uses a 60-second consumer wait while
retaining 20-second focus holds and 8-second input idle checks; these are local
coordination settings, not universal product limits.

## Back up before reclaiming local storage

1. Select owned, completed, stable outputs. Keep raw inputs, failed attempts and
   active work outside the reclamation set. Record paths, bytes, SHA-256, file
   identity and terminal receipts in a manifest.
2. Build bounded packages and stream-check the complete member set and every
   member's bytes against the manifest. Recheck source stability. A local archive
   is prepared evidence, not a remote backup.
3. Use the authorized destination and existing client/account binding. Coordinate
   its transfer consumer through the existing owner and queue. Desktop focus is
   a separate short lease; network waits need not hold focus. Do not change account
   settings, operate another owner's transfer or create a competing queue.
4. Record upload intent once, then inspect that task to settlement. Remote listing,
   size or an upload success code alone is insufficient. Download through the
   normal client into a new private location and verify the entire SHA-256.
   Keep the manifest recoverable with the package. An unknown transfer is never
   an instruction to upload or download it again.
5. Reconcile controller/child terminal receipts and consumer release. Only then
   consider explicitly authorized local reclamation. Record the exact files and
   the measured allocation change; do not infer free space from logical bytes.

On macOS, transparent filesystem compression can preserve ordinary file bytes
and paths. Before replacing a generated file, verify ownership, terminal status,
absence of open handles, no symlink/hard-link ambiguity and sufficient temporary
space. Verify the compressed copy's complete ordinary SHA, size, mode and mtime,
recheck the source identity, then replace and verify again. Record both inodes
and allocated blocks. Never rewrite old manifests to conceal the inode change;
publish a storage-maintenance receipt. This is not a change to Stata data values.

Project evidence recorded four complete cloud round trips and twenty generated
DTA files transparently compressed with ordinary bytes preserved. Later batches
must earn their own receipts. This is experience with a task-specific adapter,
not a universal Baidu API or product support guarantee.

## Resume the verified prefix and distinguish transfer intent

Keep the transfer state explicit: prepared, intent recorded, native submission
observed, upload settled, downloaded, full hash verified, consumer released.
An intent written before a focus-lock timeout does not prove a native upload.
Conversely, a missing result file does not prove that no transfer occurred.
Inspect the original processes, native transfer history and destination before
choosing the first unsubmitted operation. Never repeat an unknown operation.

A reviewed successor must pin its code and request, reuse the verified prefix,
and list upload-only, download-only and untouched packages separately. An older
admission does not authorize changed successor code. Preserve failed attempts;
combine receipts from all attempts for final acceptance. A partly verified batch
does not satisfy a whole-batch compression contract. Reclamation must bind the
actual combined final receipt and required coordinator acceptance, not an old
single-attempt success path that never existed.

Waiting for a shared focus lock and holding it are separate limits. A longer
bounded acquisition wait must not lengthen the short focus transaction, weaken
input-idle checks or retain focus through network transfer. Recheck conditions
at acquisition; reject stale callbacks before any desktop input.

## Reclaim duplicate caches without invalidating backup evidence

Once an owned transfer is terminal and its full round trip is accepted, redundant
upload/download caches may be reclaimed under the applicable storage policy.
First verify the retained canonical archive and manifest, source stability,
cache identity and bytes, absence of open handles, and the existing consumer
lease. Keep the accepted receipts and cloud copy. Remove only the enumerated
duplicate paths; a directory name or apparent age is not proof of ownership.

Publish a maintenance receipt linking the original acceptance, removed cache
paths/hashes and retained canonical package. Readers should use that receipt
to explain an old cache path's absence, not treat it as lost research data or
automatically download it again. A maintenance receipt without retained content
verification cannot establish recoverability. Measure free space again after
cleanup; shared-machine writes can consume the allocation just reclaimed.

These lessons include a local 21-package backup whose first 14 round trips were
verified over two failed attempts, with the remaining seven unsubmitted at the
time of review. They do not claim that the whole batch passed or authorize its
compression. Queue ownership and runtime bindings remain unchanged.

## Read SMCL markers without mistaking echoed code for output

A successful native Stata log may prefix a printed marker with `{res}`, `{txt}`
or `{err}`. A plain line-start regex can reject that output even when the actual
request succeeded. Preserve the raw log and repair only the reader in a new
version; do not rerun the successful producer to fix a verifier.

For a marker contract tested with these prefixes, remove only consecutive known
prefix tokens at the start of each line, then require an exact complete marker
line with the expected stage identity and return code. Do not strip all braces,
search for an arbitrary substring or interpret the color token as the return
status. For example:

```text
{res}{txt}TASK_RETURN_example=0       accepted by the prefix reader
. display "TASK_RETURN_example=0"    rejected: echoed command
TASK_RETURN_example=602              rejected when the contract requires 0
TASK_RETURN_example=0junk            rejected: trailing text
{foo}TASK_RETURN_example=0            rejected: unknown prefix
```

The example's explanations are not part of a marker. Reader acceptance is only
one check: still bind the raw log, program SHA, request/run/backend identity,
terminal status and actual outputs. A missing or uncertain execution outcome
stays unresolved. Preserve the old failed verification, add the supplemental
result and resume only the unsubmitted suffix after all dependencies pass.

The local repair passed nine positive/negative fixtures, accepted the original
native marker and preserved four producer/verifier predecessor versions. It did
not change the raw logs, fit models or establish scientific validity.
