version 18
*** Continue state created by the editor's Run Current File command.
assert "`c(frame)'" == "wb_platform"
assert _N == 6
assert wb_platform_counter == 40
scalar wb_platform_counter = wb_platform_counter + 2
assert wb_platform_counter == 42
display as text "PLATFORM_AGENT_SHARED_STATE=42"
