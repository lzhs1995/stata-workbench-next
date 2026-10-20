// Offline deterministic terminal memory patch. No installation or runtime access.
'use strict';
const edits = [
  {
    "before": "        const statusLabel = entry.success ? 'Stata Output' : 'Stata Output (error)';\n        if (entry.stderr) {\n            outputContent += \\`<div class=\"output-content error\">\\${window.stataUI.smclToHtml(entry.stderr)}</div>\\`;\n        }\n        if (entry.stdout) {\n            outputContent += '<div class=\"output-content\">' + window.stataUI.smclToHtml(entry.stdout) + '</div>';\n        }\n        \n",
    "after": "        const statusLabel = entry.success ? 'Stata Output' : 'Stata Output (error)';\n        if (entry.stderr) {\n            outputContent += \\`<div class=\"output-content error\">\\${window.stataUI.smclToHtml(boundedTerminalText(entry.stderr))}</div>\\`;\n        }\n        if (entry.stdout) {\n            outputContent += '<div class=\"output-content\">' + window.stataUI.smclToHtml(boundedTerminalText(entry.stdout)) + '</div>';\n        }\n        \n"
  },
  {
    "before": "            +     '</div>'\n            +     '<div class=\"output-pane active\" data-tab=\"result\">'\n            +       (entry.stderr ? ('<div class=\"output-content error\">' + window.stataUI.smclToHtml(entry.stderr) + '</div>') : '')\n            +       (entry.stdout ? ('<div class=\"output-content\">' + window.stataUI.smclToHtml(entry.stdout) + '</div>') : '')\n            +     '</div>'\n            +     '<div class=\"output-pane\" data-tab=\"log\">'\n",
    "after": "            +     '</div>'\n            +     '<div class=\"output-pane active\" data-tab=\"result\">'\n            +       (entry.stderr ? ('<div class=\"output-content error\">' + window.stataUI.smclToHtml(boundedTerminalText(entry.stderr)) + '</div>') : '')\n            +       (entry.stdout ? ('<div class=\"output-content\">' + window.stataUI.smclToHtml(boundedTerminalText(entry.stdout)) + '</div>') : '')\n            +     '</div>'\n            +     '<div class=\"output-pane\" data-tab=\"log\">'\n"
  },
  {
    "before": "        // Fill HTML immediately if provided\n        if (msg.stdout && run.stdoutEl) {\n            const finalStdout = window.stataUI.smclToHtml(String(msg.stdout || ''));\n            const currentStdout = run.stdoutEl.innerHTML;\n            // No-replacement optimization: if what we have looks like a match for what just came in, avoid flicker.\n",
    "after": "        // Fill HTML immediately if provided\n        if (msg.stdout && run.stdoutEl) {\n            const finalStdout = window.stataUI.smclToHtml(boundedTerminalText(msg.stdout));\n            const currentStdout = run.stdoutEl.innerHTML;\n            // No-replacement optimization: if what we have looks like a match for what just came in, avoid flicker.\n"
  },
  {
    "before": "        const run = runs[runId];\n        if (!run) return;\n        const success = msg.success === true;\n        const hasError = msg.hasError === true;\n",
    "after": "        const run = runs[runId];\n        if (!run) return;\n        run.settled = true;\n        const success = msg.success === true;\n        const hasError = msg.hasError === true;\n"
  },
  {
    "before": "              run.viewer = new LogViewer(run.stdoutEl, msg.logPath, msg.logSize, runId, { autoLoadAll: true });\n            } else {\n                const finalStdout = window.stataUI.smclToHtml(String(msg.stdout || ''));\n                const currentStdout = run.stdoutEl ? run.stdoutEl.innerHTML : '';\n                const skipReplace = run._taskDoneApplied === true || (currentStdout && Math.abs(currentStdout.length - finalStdout.length) < 20);\n",
    "after": "              run.viewer = new LogViewer(run.stdoutEl, msg.logPath, msg.logSize, runId, { autoLoadAll: true });\n            } else {\n                const finalStdout = window.stataUI.smclToHtml(boundedTerminalText(msg.stdout));\n                const currentStdout = run.stdoutEl ? run.stdoutEl.innerHTML : '';\n                const skipReplace = run._taskDoneApplied === true || (currentStdout && Math.abs(currentStdout.length - finalStdout.length) < 20);\n"
  },
  {
    "before": "             // SUCCESS + NO LOG: \n             // Keep the streamed content (backfilled if needed)\n             const finalStdout = window.stataUI.smclToHtml(String(msg.stdout || ''));\n             if (run.stdoutEl && finalStdout) {\n                 const current = run.stdoutEl.innerHTML || '';\n",
    "after": "             // SUCCESS + NO LOG: \n             // Keep the streamed content (backfilled if needed)\n             const finalStdout = window.stataUI.smclToHtml(boundedTerminalText(msg.stdout));\n             if (run.stdoutEl && finalStdout) {\n                 const current = run.stdoutEl.innerHTML || '';\n"
  },
  {
    "before": "             } else {\n                 // Fallback to memory content\n                 run.logEl.innerHTML = window.stataUI.smclToHtml(String(msg.fullStdout || ''));\n             }\n        }\n",
    "after": "             } else {\n                 // Fallback to memory content\n                 run.logEl.innerHTML = window.stataUI.smclToHtml(boundedTerminalText(msg.fullStdout));\n             }\n        }\n"
  },
  {
    "before": "        }\n\n        const stderr = String(msg.stderr || '');\n        if (stderr && run.stderrEl) {\n            run.stderrEl.style.display = 'block';\n",
    "after": "        }\n\n        const stderr = boundedTerminalText(msg.stderr);\n        if (stderr && run.stderrEl) {\n            run.stderrEl.style.display = 'block';\n"
  },
  {
    "before": "    try {\n        const savedState = vscode.getState();\n        if (savedState && savedState.chatHtml) {\n            chatStream.innerHTML = savedState.chatHtml;\n            // Restore runs tracking references\n",
    "after": "    try {\n        const savedState = vscode.getState();\n        if (savedState && typeof savedState.chatHtml === 'string' && savedState.chatHtml.length <= 2_000_000) {\n            chatStream.innerHTML = savedState.chatHtml;\n            // Restore runs tracking references\n"
  },
  {
    "before": "                    runs[runId] = {\n                        group: group,\n                        stdoutEl: document.getElementById('run-stdout-' + runId),\n                        stderrEl: document.getElementById('run-stderr-' + runId),\n",
    "after": "                    runs[runId] = {\n                        group: group,\n                        settled: !!(document.getElementById('run-rc-' + runId)?.textContent),\n                        stdoutEl: document.getElementById('run-stdout-' + runId),\n                        stderrEl: document.getElementById('run-stderr-' + runId),\n"
  },
  {
    "before": "            }\n        } else if (initialEntries && initialEntries.length > 0) {\n            initialEntries.forEach(appendEntry);\n        }\n\n",
    "after": "            }\n        } else if (initialEntries && initialEntries.length > 0) {\n            initialEntries.slice(-20).forEach(appendEntry);\n        }\n\n"
  },
  {
    "before": "    }\n\n    // Capture state repeatedly for seamless tab moves\n    function saveState() {\n        if (!chatStream) return;\n        vscode.setState({\n            chatHtml: chatStream.innerHTML,\n            sessionArtifacts: sessionArtifacts,\n            history: history\n        });\n    }\n",
    "after": "    }\n\n    // Bound both live cards and serialized restore state. Full logs remain on disk.\n    // Do not serialize an unbounded innerHTML merely to measure its size.\n    function boundedTerminalText(value) {\n        const text = String(value || '');\n        return text.length > 50_000\n            ? '[Earlier output omitted from preview; open Log for the full file.]\\\\n' + safeSliceTail(text, 50_000)\n            : text;\n    }\n\n    function pruneTerminalHistory() {\n        const groups = Array.from(chatStream.children);\n        const settled = groups.filter(group => {\n            const run = runs[group.dataset.runId];\n            return !run || run.settled === true;\n        });\n        for (const group of settled.slice(0, Math.max(0, settled.length - 20))) {\n            const id = group.dataset.runId;\n            const run = runs[id];\n            if (run && run.viewer) run.viewer.dispose();\n            if (id) {\n                searchControllers.delete(id);\n                taskDoneRuns.delete(id);\n                logUpdateQueued.delete(id);\n                delete runs[id];\n            }\n            group.remove();\n        }\n    }\n\n    function saveState() {\n        if (!chatStream) return;\n        pruneTerminalHistory();\n        if (history.length > 100) history.splice(0, history.length - 100);\n        let chatHtml = '';\n        // Serialize only individually bounded recent cards, never the entire stream.\n        const groups = Array.from(chatStream.children).slice(-20);\n        for (let index = groups.length - 1; index >= 0; index--) {\n            const html = groups[index].outerHTML;\n            if (chatHtml.length + html.length > 2_000_000) break;\n            chatHtml = html + chatHtml;\n        }\n        vscode.setState({\n            chatHtml,\n            sessionArtifacts: sessionArtifacts.slice(-100),\n            history: history.slice(-100).map(code => String(code).slice(0, 50_000)),\n            previewOnly: true\n        });\n    }\n"
  },
  {
    "before": "        this.offset = 0; \n        const defaultMax = Number.isFinite(options.maxBytes) ? options.maxBytes : 50000;\n        this.maxBytes = (options.autoLoadAll === true && Number.isFinite(this.logSize) && this.logSize > 0)\n          ? this.logSize\n          : defaultMax;\n        this.autoLoadAll = options.autoLoadAll === true;\n            this.isFirstLoad = true;\n            this.isLoading = false;\n",
    "after": "        this.offset = 0; \n        const defaultMax = Number.isFinite(options.maxBytes) ? options.maxBytes : 50000;\n        this.maxBytes = Math.max(1, Math.min(50000, defaultMax));\n        // A completed run must never hydrate a whole disk log into the webview.\n        this.autoLoadAll = false;\n        this.disposed = false;\n            this.isFirstLoad = true;\n            this.isLoading = false;\n"
  },
  {
    "before": "            // Force container to be scrollable\n            this.container.classList.add('scrollable-log');\n            this.container.addEventListener('scroll', this.onScroll.bind(this));\n            \n            console.log('[LogViewer] Initializing. Size:', this.logSize, 'Start Offset:', this.offset, 'AutoLoadAll:', this.autoLoadAll);\n",
    "after": "            // Force container to be scrollable\n            this.container.classList.add('scrollable-log');\n            this.boundScroll = this.onScroll.bind(this);\n            this.container.addEventListener('scroll', this.boundScroll);\n            this.container.title = 'Recent log preview; open Log for the complete file.';\n            \n            console.log('[LogViewer] Initializing. Size:', this.logSize, 'Start Offset:', this.offset, 'AutoLoadAll:', this.autoLoadAll);\n"
  },
  {
    "before": "        }\n        \n        onScroll() {\n            if (this.isLoading) return;\n            // Native scrolling Up\n            // Use a threshold (e.g. 50px) instead of strictly 0 to handle faster scrolls or sub-pixel differences\n",
    "after": "        }\n        \n        dispose() {\n            this.disposed = true;\n            this.container.removeEventListener('scroll', this.boundScroll);\n        }\n\n        onScroll() {\n            if (this.disposed || this.isLoading) return;\n            // Native scrolling Up\n            // Use a threshold (e.g. 50px) instead of strictly 0 to handle faster scrolls or sub-pixel differences\n"
  },
  {
    "before": "        \n        fetchChunk(offset, isPrepend = false) {\n            this.isLoading = true;\n            this.pendingPrepend = isPrepend;\n",
    "after": "        \n        fetchChunk(offset, isPrepend = false) {\n            if (this.disposed) return;\n            this.isLoading = true;\n            this.pendingPrepend = isPrepend;\n"
  },
  {
    "before": "        \n        appendData(data, nextOffset) {\n             this.isLoading = false;\n             \n",
    "after": "        \n        appendData(data, nextOffset) {\n             if (this.disposed) return;\n             this.isLoading = false;\n             \n"
  },
  {
    "before": "             const div = document.createElement('div');\n             div.className = 'log-chunk';\n             div.innerHTML = window.stataUI.smclToHtml(data || '');\n             \n             if (this.pendingPrepend) {\n",
    "after": "             const div = document.createElement('div');\n             div.className = 'log-chunk';\n             div.innerHTML = window.stataUI.smclToHtml(boundedTerminalText(data));\n             \n             if (this.pendingPrepend) {\n"
  },
  {
    "before": "                 const oldHeight = this.container.scrollHeight;\n                 this.container.prepend(div);\n                 const newHeight = this.container.scrollHeight;\n                 this.container.scrollTop = newHeight -oldHeight;\n",
    "after": "                 const oldHeight = this.container.scrollHeight;\n                 this.container.prepend(div);\n                 while (this.container.children.length > 4) this.container.lastElementChild.remove();\n                 const newHeight = this.container.scrollHeight;\n                 this.container.scrollTop = newHeight -oldHeight;\n"
  },
  {
    "before": "                 // Append (Initial load or scroll down if implemented)\n                 this.container.appendChild(div);\n                 scheduleHighlight();\n                 // If initial tail load, autoscroll to bottom?\n",
    "after": "                 // Append (Initial load or scroll down if implemented)\n                 this.container.appendChild(div);\n                 while (this.container.children.length > 4) this.container.firstElementChild.remove();\n                 scheduleHighlight();\n                 // If initial tail load, autoscroll to bottom?\n"
  }
];
function patchBundle(source, options = {}) {
  let text = source;
  for (const [index, edit] of edits.entries()) {
    const beforeCount = text.split(edit.before).length - 1;
    const afterCount = text.split(edit.after).length - 1;
    if (beforeCount === 0 && afterCount === 1) continue;
    if (beforeCount !== 1 || afterCount !== 0) throw Error('terminal-memory anchor drift: ' + index);
    text = text.replace(edit.before, () => edit.after);
  }
  return options.finalize === false ? text : require('./finalize_bundle_identity').finalize(text).text;
}
module.exports = {patchBundle};
