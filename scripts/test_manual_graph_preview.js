'use strict';
// 回归：用户点击 Terminal 中已有图形链接 → Stata Graphs 预览；不调用 Stata。
// 直接从生产 bundle 提取 openArtifact 消息分支、__codexOpenGraphPreview、
// __codexResolveArtifactPath 与 __codexHandleArtifact 运行，而不是复写其逻辑。
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../dist/extension.js'), 'utf8');
// The maintenance replay must preserve the same bytes, with strict anchors.
const patch = require('./apply_manual_graph_preview_patch');
const fingerprint = require('./finalize_bundle_identity');
const crypto = require('node:crypto');
const previous = fingerprint.finalize(source.replace(patch.HELPER, '').replace(patch.AFTER, patch.BEFORE)).text;
assert.equal(crypto.createHash('sha256').update(previous).digest('hex'),
  '5519c6f04a0ca6a46ea81d8f2e6e2c293a006b7d620214eec6bef7bfff63fbea', 'previous bundle fixture must be exact');
assert.equal(patch.patchBundle(previous), source, 'maintenance replay must reproduce sealed bundle');
assert.equal(patch.patchBundle(source), source, 'patch must be idempotent');
assert.throws(() => patch.patchBundle(previous.replace(patch.BEFORE, 'missingRoute')), /anchor/);
assert.throws(() => patch.patchBundle(previous + patch.BEFORE), /anchor/);
assert.throws(() => patch.patchBundle(source.replace(patch.AFTER, patch.BEFORE)), /anchor|mixed/);
assert.throws(() => patch.patchBundle(source.replace('manual-terminal-click', 'changed-click')), /modified/);
function extract(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, 'bundle segment not found: ' + start);
  assert.equal(source.indexOf(start, a + 1), -1, 'bundle segment not unique: ' + start);
  return source.slice(a, b);
}

const existing = new Set(['/runs/r8/graph_001.svg', '/runs/r8/plot.png', '/runs/r8/output.log']);
const calls = { pag: [], help: [], ensure: 0, reveal: 0, snapshots: 0, stata: 0, appended: [] };
const panel = { viewColumn: 2, visible: false, webview: { asWebviewUri: (u) => ({ toString: () => 'webview:' + String(u) }) }, reveal() { calls.reveal++; } };
const stataTrap = new Proxy({}, { get() { calls.stata++; throw new Error('Stata must not be invoked'); } });
const context = {
  JA: { existsSync: (p) => existing.has(p) },
  rg: { isAbsolute: (p) => p.startsWith('/'), resolve: (a, b) => path.posix.resolve(a, b), basename: (p) => p.split('/').at(-1) },
  Gg: { appendRunArtifact: (id, a) => calls.appended.push([id, a]) },
  zg: stataTrap,
  __codexGraphPanel: null,
  __codexGraphPanelDiag: { revealCount: 0 },
  __codexGraphState: { runId: 'run_original', graphs: [{absPath: '/runs/old/a.svg'}, {absPath: '/runs/old/b.svg'}], version: 3 },
  __codexUriFile: (p) => p,
  __codexGraphLog() {},
  __codexGraphTargetColumn: () => 2,
  __codexQueueGraphSnapshot() { calls.snapshots++; },
  __codexEnsureGraphPanel() { calls.ensure++; context.__codexGraphPanel = panel; return panel; },
  pag: (p, base) => calls.pag.push([p, base]),
};
context.__codexGraphMark = (p) => Object.assign(context.__codexGraphPanelDiag, p);
vm.createContext(context);
vm.runInContext(extract('function __codexArtifactIsHelp(', 'function __codexCreateGraphSnapshot('), context);
vm.runInContext(extract('var __codexManualPreviewSeq = 0;', 'function __codexHandleArtifact('), context);
vm.runInContext(extract('function __codexHandleArtifact(', 'var kM='), context);
// 生产 webview 消息分支（minified，参数 g=panel 实例，I=message）。
const clause = extract('I.type==="openArtifact"&&', ',I.type==="revealArtifact"');
assert(clause.includes('__codexOpenGraphPreview(I)||pag(I.path,I.baseDir)'), 'handler must try preview before pag fallback');
vm.runInContext('function __dispatch(g,I){' + clause + '}', context);
const terminal = { _openHelpPanel: (p, l) => calls.help.push([p, l]) };
const send = (m) => context.__dispatch(terminal, Object.assign({ type: 'openArtifact' }, m));

// 1. 无图形面板时，用户点击已有 SVG：创建并显示 Graphs，独立 preview runId，不走 pag。
send({ path: '/runs/r8/graph_001.svg', label: 'graph_001' });
assert.equal(calls.ensure, 1); assert.equal(calls.reveal, 1); assert.equal(calls.pag.length, 0);
assert.match(context.__codexGraphState.runId, /^manual-preview-\d+-1$/);
assert.equal(context.__codexGraphState.graphs.length, 1, 'manual click replaces the displayed batch with a single preview');
assert.equal(context.__codexGraphState.graphs[0].absPath, '/runs/r8/graph_001.svg');
assert.equal(context.__codexGraphPanelDiag.lastBatchSource, 'manual-terminal-click');
// 2. 相对路径 + baseDir 的 PNG：面板已存在，复用并解析绝对路径。
send({ path: 'plot.png', baseDir: '/runs/r8', label: 'plot' });
assert.equal(calls.ensure, 2, 'existing ensure path still called'); assert.equal(calls.reveal, 2);
assert.equal(context.__codexGraphState.graphs.at(-1).absPath, '/runs/r8/plot.png'); assert.equal(calls.pag.length, 0);
// 3. 非图形文件：保持原 pag 行为。
send({ path: '/runs/r8/output.log' });
assert.deepEqual(calls.pag.at(-1), ['/runs/r8/output.log', undefined]); assert.equal(calls.reveal, 2);
// 4. help：保持 help 面板。
send({ path: 'regress', label: 'help regress', artifactType: 'help' });
assert.deepEqual(calls.help, [['regress', 'help regress']]); assert.equal(calls.pag.length, 1); assert.equal(calls.reveal, 2);
// 5. 不存在的图形：交回 pag（其自身报 not found），不建面板、不伪造图。
send({ path: '/runs/r8/missing.svg' });
assert.deepEqual(calls.pag.at(-1), ['/runs/r8/missing.svg', undefined]); assert.equal(calls.reveal, 2);
assert.equal(context.__codexGraphState.graphs.length, 1, 'missing file not added');
// 6. 全程未调用 Stata，也未写入 run 产物。
assert.equal(calls.stata, 0); assert.equal(calls.appended.length, 0);
console.log('MANUAL_GRAPH_PREVIEW_PASS: click opens Graphs without panel, relative+baseDir, non-graph/help/missing keep original, Stata calls 0');
