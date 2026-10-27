version 18
*** Must dispatch only after the first client releases its profile lock.
assert "`c(frame)'" == "wb_platform"
assert wb_platform_queue == 2
scalar wb_platform_queue = 3
display as text "PLATFORM_QUEUE_SECOND=3"
