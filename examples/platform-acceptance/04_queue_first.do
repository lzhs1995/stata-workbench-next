version 18
*** Start the second client while this request is busy.
assert "`c(frame)'" == "wb_platform"
assert wb_platform_counter == 42
scalar wb_platform_queue = 1
display as text "PLATFORM_QUEUE_FIRST_START"
sleep 6000
scalar wb_platform_queue = 2
display as text "PLATFORM_QUEUE_FIRST_END"
