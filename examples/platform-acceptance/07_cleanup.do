version 18
*** First verify cancellation restored the data; then remove only test objects.
assert "`c(frame)'" == "wb_platform"
assert _N == 6
assert wb_platform_counter == 42
assert wb_platform_queue == 3
capture confirm variable wb_platform_cancel_probe
local probe_rc = _rc
assert `probe_rc' == 111
assert y == 2*x + 1
display as text "PLATFORM_CANCEL_RESTORATION_VERIFIED"
capture graph drop wb_platform_graph wb_platform_reload
local graph_rc = _rc
capture scalar drop wb_platform_counter wb_platform_queue
local scalar_rc = _rc
capture frame change default
local frame_rc = _rc
capture frame drop wb_platform
local drop_rc = _rc
display as text "PLATFORM_CLEANUP graph=" `graph_rc' " scalar=" `scalar_rc' " frame=" `frame_rc' " drop=" `drop_rc'
assert `graph_rc' == 0
assert `scalar_rc' == 0
assert `frame_rc' == 0
assert `drop_rc' == 0
assert "`c(frame)'" == "default"
assert _N == 0
display as text "PLATFORM_CLEANUP_COMPLETE"
