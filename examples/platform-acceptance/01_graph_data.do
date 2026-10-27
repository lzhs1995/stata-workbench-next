version 18
*** Run once in a fresh, isolated acceptance workspace. No research data are read.
assert "`c(frame)'" == "default"
assert _N == 0
mkdir "outputs"
frame create wb_platform
frame change wb_platform
set obs 6
generate long id = _n
generate double x = id
generate double y = 2*x + 1
generate str20 label = "合成样本"
isid id
assert y == 2*x + 1
scalar wb_platform_counter = 40
save "outputs/data.dta", replace
export delimited using "outputs/data.csv", replace
twoway scatter y x, name(wb_platform_graph) title("Synthetic acceptance")
graph save wb_platform_graph "outputs/graph.gph", replace
graph export "outputs/graph.png", name(wb_platform_graph) replace width(800) height(480)
graph use "outputs/graph.gph", name(wb_platform_reload)
graph export "outputs/reloaded.png", name(wb_platform_reload) replace width(800) height(480)
display as text "PLATFORM_FILE_COMPLETE"
sleep 5000
