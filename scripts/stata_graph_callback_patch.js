"use strict";

const ORIGINAL = "    async def _notify_cache_callbacks(self, graph_name: str, success: bool) -> None:\n        for callback in self._cache_callbacks:\n            try:\n                result = callback(graph_name, success)\n                if inspect.isawaitable(result):\n                    await result\n            except Exception as e:\n                logger.warning(f\"Cache callback failed for {graph_name}: {e}\")\n";
const ORIGINAL_SHA256 = "0cbb3b59507fca8974ea0a6ec6aed2814997f866181e4d59fbeec8ce3bebf9e8";

const MARKER = "# Workbench graph callbacks report every failure to their request.";
const CANDIDATE = String.raw`    async def _notify_cache_callbacks(self, graph_name: str, success: bool) -> None:
        # Workbench graph callbacks report every failure to their request.
        with self._lock:
            callbacks = list(self._cache_callbacks)
        errors = []
        for callback in callbacks:
            try:
                result = callback(graph_name, success)
                if inspect.isawaitable(result):
                    await result
            except Exception as error:
                error.add_note("Graph cache callback: " + graph_name)
                errors.append(error)
        if errors:
            raise ExceptionGroup("Graph cache callbacks failed: " + graph_name, errors)
`;

function patchDetector(source) {
  const oldCount = source.split(ORIGINAL).length - 1;
  const newCount = source.split(CANDIDATE).length - 1;
  if (!oldCount && newCount === 1 && source.split(MARKER).length === 2) return source;
  if (oldCount !== 1 || newCount || source.includes(MARKER)) {
    throw new Error("unsupported graph callback source");
  }
  return source.replace(ORIGINAL, CANDIDATE);
}
module.exports = { patchDetector, ORIGINAL, ORIGINAL_SHA256, CANDIDATE };
