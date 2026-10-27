version 18
*** Select these lines in the editor and use Run Selection/Current Line once.
assert "`c(frame)'" == "wb_platform"
assert wb_platform_counter == 42
assert _N == 6
display as text "PLATFORM_SELECTION_SAME_STATE=42"
