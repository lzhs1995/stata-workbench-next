"use strict";

const crypto = require("node:crypto");
const fixture = require("./runtime/stata_bulk_cache.original.json");
const GET = String.raw`    def _get_cached_graph_path(self, graph_name: str) -> Optional[str]:
        # Every path taking both locks uses execution -> cache, including reads.
        with self._exec_lock:
            if not hasattr(self, '_graph_cache_records'):
                return None
            signature = self._get_graph_signature(graph_name)
            with self._cache_lock:
                record = self._graph_cache_records.get(graph_name)
                if record is None or not self._graph_cache_record_valid(record, signature):
                    return None
                record['access'] = time.monotonic()
                self._cache_access_times[graph_name] = record['access']
                return record['path']

`;
const MANAGE = String.raw`    def invalidate_graph_cache(self, graph_name: str = None) -> None:
        with self._exec_lock:
            self._initialize_cache()
            with self._cache_lock:
                records = dict(self._graph_cache_records)
                removed = list(records.values()) if graph_name is None else [records.get(graph_name)]
                if graph_name is None:
                    records.clear()
                else:
                    records.pop(graph_name, None)
                self._publish_graph_cache_records(records)
            # Published invalidation stays valid even if physical cleanup fails.
            self._remove_graph_cache_files([r['path'] for r in removed if r is not None])

    def _initialize_cache(self) -> None:
        import tempfile
        import threading
        import atexit
        with self._exec_lock:
            with StataClient._cache_init_lock:
                if not hasattr(self, '_cache_lock'):
                    self._cache_lock = threading.Lock()
                with self._cache_lock:
                    if not getattr(self, '_preemptive_cache_dir', None) or not os.path.isdir(self._preemptive_cache_dir):
                        self._preemptive_cache_dir = tempfile.mkdtemp(prefix='wb-graph-cache-', dir=get_writable_temp_dir())
                        register_temp_dir(self._preemptive_cache_dir)
                        self._publish_graph_cache_records({})
                    elif not hasattr(self, '_graph_cache_records'):
                        # Legacy mixed name/hash/signature keys cannot be trusted as records.
                        self._publish_graph_cache_records({})
                    if not getattr(self, '_cache_initialized', False):
                        atexit.register(self._cleanup_cache)
                        self._cache_initialized = True

    def _publish_graph_cache_records(self, records):
        # Caller owns _cache_lock; prepare all projections before publishing.
        paths = {name: item['path'] for name, item in records.items()}
        sizes = {name: item['size'] for name, item in records.items()}
        access = {name: item['access'] for name, item in records.items()}
        total = sum(sizes.values())
        self._graph_cache_records = records
        self._preemptive_cache = paths
        self._cache_sizes = sizes
        self._cache_access_times = access
        self._total_cache_size = total

    def _remove_graph_cache_files(self, paths):
        errors = []
        for filename in dict.fromkeys(paths):
            try:
                pathlib.Path(filename).unlink(missing_ok=True)
            except BaseException as error:
                errors.append(error)
        if len(errors) == 1:
            raise errors[0]
        if errors:
            raise BaseExceptionGroup('Graph cache cleanup failed', errors)

    def _cleanup_cache(self) -> None:
        import shutil
        with self._exec_lock:
            if not hasattr(self, '_cache_lock'):
                return
            with self._cache_lock:
                directory = getattr(self, '_preemptive_cache_dir', None)
                self._publish_graph_cache_records({})
                if directory:
                    try:
                        shutil.rmtree(directory)
                    except FileNotFoundError:
                        pass

    def _evict_cache_if_needed(self, new_item_size: int = 0) -> None:
        # Legacy internal entrypoint: caller owns _cache_lock, never query Stata.
        records = dict(self._graph_cache_records)
        removed = []
        for name in sorted(records, key=lambda key: records[key]['access']):
            if len(records) <= self.MAX_CACHE_SIZE and sum(r['size'] for r in records.values()) + new_item_size <= self.MAX_CACHE_BYTES:
                break
            removed.append(records.pop(name)['path'])
        self._publish_graph_cache_records(records)
        self._remove_graph_cache_files(removed)

`;
const EXPORT = String.raw`    def _is_cache_valid(self, graph_name: str, cache_path: str) -> bool:
        with self._exec_lock:
            if not hasattr(self, '_graph_cache_records'):
                return False
            signature = self._get_graph_signature(graph_name)
            with self._cache_lock:
                record = self._graph_cache_records.get(graph_name)
                return bool(record and record['path'] == cache_path and self._graph_cache_record_valid(record, signature))

    def _graph_cache_record_valid(self, record, signature):
        import stat
        import hashlib
        if record['signature'] != signature or record['command_idx'] != self._command_idx:
            return False
        try:
            info = pathlib.Path(record['path']).lstat()
        except FileNotFoundError:
            return False
        if not stat.S_ISREG(info.st_mode) or info.st_size != record['size'] or not 0 < info.st_size <= self.MAX_GRAPH_BYTES:
            return False
        # Permission/IO/cancellation errors are real failures, not cache misses.
        with open(record['path'], 'rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        return digest == record['sha256']

    def _export_graph_cache_batch(self, graph_names, *, force=False):
        import stat
        import hashlib
        with self._exec_lock:
            self._initialize_cache()
            names = list(dict.fromkeys(graph_names))
            with self._cache_lock:
                original = {name: dict(record) for name, record in self._graph_cache_records.items()}
            records = dict(original)
            new_paths, result, failure, committed = [], {}, None, False
            try:
                for name in names:
                    signature = self._get_graph_signature(name)
                    record = records.get(name)
                    if force or record is None or not self._graph_cache_record_valid(record, signature):
                        target = pathlib.Path(self._preemptive_cache_dir) / (uuid.uuid4().hex + '.svg')
                        if target.exists():
                            raise RuntimeError('Graph cache staging destination already exists')
                        new_paths.append(str(target))
                        exported = self.export_graph(name, filename=str(target), format='svg')
                        if exported != str(target):
                            raise RuntimeError('Graph export returned an unexpected cache path')
                        info = target.lstat()
                        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= self.MAX_GRAPH_BYTES:
                            raise RuntimeError('Graph cache export produced an invalid file')
                        with target.open('rb') as stream:
                            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                        record = {'path': str(target), 'size': info.st_size, 'sha256': digest,
                                  'signature': signature, 'command_idx': self._command_idx,
                                  'access': time.monotonic()}
                    else:
                        record = dict(record, access=time.monotonic())
                    records[name] = record
                    result[name] = record['path']

                # Response paths must survive cache eviction, even for a batch
                # larger than the cache. Such outputs join normal temp cleanup.
                for name in sorted(records, key=lambda key: records[key]['access']):
                    if len(records) <= self.MAX_CACHE_SIZE and sum(r['size'] for r in records.values()) <= self.MAX_CACHE_BYTES:
                        break
                    records.pop(name)
                retained = {record['path'] for record in records.values()}
                returned = set(result.values())
                for filename in returned - retained:
                    register_temp_file(pathlib.Path(filename))
                with self._cache_lock:
                    self._publish_graph_cache_records(records)
                    committed = True
                obsolete = {record['path'] for record in original.values()} - retained - returned
                # No native retry after failure. Post-commit cleanup errors are
                # visible; the newly published cache remains internally valid.
                self._remove_graph_cache_files(obsolete)
            except BaseException as error:
                failure = error
            cleanup_errors = []
            if not committed:
                try:
                    self._remove_graph_cache_files(new_paths)
                except BaseException as error:
                    cleanup_errors.append(error)
            errors = ([failure] if failure is not None else []) + cleanup_errors
            if len(errors) == 1:
                raise errors[0]
            if errors:
                raise BaseExceptionGroup('Graph cache export and cleanup failed', errors)
            return result

    def export_graphs_all(self) -> GraphExportResponse:
        with self._exec_lock:
            names = self.list_graphs(force_refresh=True)
            if not names:
                return GraphExportResponse(graphs=[])
            paths = self._export_graph_cache_batch(names)
            return GraphExportResponse(graphs=[GraphExport(name=name, file_path=filename) for name, filename in paths.items()])

    def cache_graph_on_creation(self, graph_name: str) -> bool:
        with self._exec_lock:
            self.invalidate_list_graphs_cache()
            # Explicit creation can replace a same-name graph within one command
            # and Stata timestamps have only second precision: force a fresh export.
            self._graph_signature_cache = {}
            self._graph_signature_cache_cmd_idx = -1
            self._export_graph_cache_batch([graph_name], force=True)
            return True

`;
const emission = require("./stata_graph_error_patch").BLOCKS.find(b => b.name === "emission");
const retryStart = emission.replacement.indexOf("                    last_exc = None\n");
const retryEnd = emission.replacement.indexOf("                if not export_path:\n", retryStart);
if (retryStart < 0 || retryEnd < 0) throw new Error("unsupported graph emission retry source");
const EMISSION = emission.replacement.slice(0, retryStart) + String.raw`                    export_path = await anyio.to_thread.run_sync(
                        lambda: self.export_graph(graph_name, format=fmt)
                    )
` + emission.replacement.slice(retryEnd);
const replacements = {get: GET, manage: MANAGE, exports: EXPORT, emission: EMISSION};
const BLOCKS = fixture.blocks.map(block => ({...block, replacement: replacements[block.name]}));
function transform(source, normalize) {
  let result = source;
  const states = [];
  for (const block of BLOCKS) {
    if (crypto.createHash("sha256").update(block.original).digest("hex") !== block.sha256) throw new Error("invalid bulk cache fixture");
    if (result.split(block.start).length !== 2) throw new Error("missing or ambiguous bulk cache start: " + block.name);
    const start = result.indexOf(block.start), end = result.indexOf(block.end, start);
    if (end <= start) throw new Error("missing bulk cache boundary: " + block.name);
    const body = result.slice(start, end);
    const upstreamEmission = normalize && block.name === "emission" && body === emission.original;
    if (body !== block.original && body !== block.replacement && !upstreamEmission) throw new Error("unsupported bulk cache source: " + block.name);
    states.push(body === block.replacement ? "candidate" : "original");
    if (normalize ? block.name === "emission" && !upstreamEmission : true) {
      result = result.slice(0, start) + (normalize ? block.original : block.replacement) + result.slice(end);
    }
  }
  if (normalize && states.includes("candidate") && states.includes("original")) throw new Error("mixed bulk cache source");
  return result;
}
module.exports = { BLOCKS, patchClient: source => transform(source, false), normalizeClient: source => transform(source, true) };
