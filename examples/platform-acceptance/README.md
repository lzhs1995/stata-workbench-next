# Licensed desktop acceptance fixtures

These seven synthetic programs cover one continuous Workbench session: editor
Run File, Python client, editor selection, two queued clients, Stop, and cleanup.
Use a fresh workspace and isolated profile with an empty `default` frame. Set
`stataMcp.runFileWorkingDirectory` to `${fileDir}` and give the client the same
workspace through `--cwd`. The first program intentionally refuses an existing
`outputs` directory or occupied test frame.

Run them in numeric order, observing the GUI and checking the original receipt
before each dependent step. The queue pair runs from two clients, and the
cancellation program requires a Stop operation before its final marker. If Stop
was missed, preserve that result: the cleanup assertion will correctly fail.
Never rerun an uncertain submission or use Clear/reset to make a check pass.

Expected files: 6-row, 4-variable `data.csv` and `data.dta`, a native `graph.gph`,
and two decoded 800×480 PNGs. Stata-generated metadata can differ between runs;
compare data and pixels, and retain file hashes as identity evidence. On Mac,
record SVG+sips when the compatibility converter is used. On Windows, record
the actual renderer, Stata edition, Python and editor versions.

The named programs are portable adaptations of the retained Mac synthetic
checks; shipping them does not certify execution on a Windows desktop. Full
instructions and expected receipts: [Windows acceptance](../../docs/WINDOWS_ACCEPTANCE.md).
