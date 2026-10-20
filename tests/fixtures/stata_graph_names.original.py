import re
_GRAPH_NAME_PATTERN = re.compile(r"name\(\s*(\"[^\"]+\"|'[^']+'|[^,\)\s]+)", re.IGNORECASE)
_VALID_STATA_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_MAKE_VALID_NAME_STRIP_RE = re.compile(r"[^A-Za-z0-9_]")
_MAKE_VALID_NAME_CHECK_RE = re.compile(r"^[A-Za-z_]")
_GRAPH_REWRITE_RE = re.compile(
    r"name\(\s*(?:`\"(?P<cq>[^\"]*)\"'|\"(?P<dq>[^\"]*)\"|(?P<uq>[^,\s\)]+))\s*(?P<rest>[^)]*)\)"
)

class Client:
    def _make_valid_stata_name(self, name: str) -> str:
        """Create a valid Stata name (<=32 chars, [A-Za-z_][A-Za-z0-9_]*)."""
        base = _MAKE_VALID_NAME_STRIP_RE.sub("_", name or "")
        if not base:
            base = "Graph"
        if not _MAKE_VALID_NAME_CHECK_RE.match(base):
            base = f"G_{base}"
        base = base[:32]

        # Avoid collisions.
        candidate = base
        i = 1
        while candidate in getattr(self, "_graph_name_reverse", {}):
            suffix = f"_{i}"
            candidate = (base[: max(0, 32 - len(suffix))] + suffix)[:32]
            i += 1
        return candidate
    def _maybe_rewrite_graph_name_in_command(self, code: str) -> str:
        """Rewrite name("...") to a valid Stata name and store alias mapping."""
        if not code:
            return code
        if not hasattr(self, "_graph_name_aliases"):
            self._graph_name_aliases = {}
            self._graph_name_reverse = {}

        # Handle common patterns: name("..." ...), name(`"..."' ...), or name(unquoted ...)

        def repl(m: re.Match) -> str:
            original = m.group("cq") or m.group("dq") or m.group("uq")
            original = (original or "").strip()
            
            # If it's already an alias we recognize, don't rewrite it again
            if original.startswith("mcp_g_") and original in self._graph_name_reverse:
                return m.group(0)

            internal = self._graph_name_aliases.get(original)
            if not internal:
                # Only rewrite if it's NOT a valid Stata name or has special characters
                if not _VALID_STATA_NAME_RE.match(original) or len(original) > 32:
                    internal = self._make_valid_stata_name(original)
                    self._graph_name_aliases[original] = internal
                    self._graph_name_reverse[internal] = original
                else:
                    # Valid name, use as is but still record it if we want reverse mapping to be consistent
                    internal = original

            rest = m.group("rest") or ""
            return f"name({internal}{rest})"

        return _GRAPH_REWRITE_RE.sub(repl, code)
