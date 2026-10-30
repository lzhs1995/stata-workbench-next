version 18
*** Click Stop after PLATFORM_CANCEL_STARTED, before this bounded loop finishes.
assert "`c(frame)'" == "wb_platform"
assert wb_platform_counter == 42
assert wb_platform_queue == 3
generate byte wb_platform_cancel_probe = 1
display as text "PLATFORM_CANCEL_STARTED"
forvalues tick = 1/200 {
    sleep 100
}
display as text "PLATFORM_CANCEL_FINISHED"
