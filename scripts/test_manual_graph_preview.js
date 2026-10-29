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
// Later bundle patches are reverted exactly; this chain pins the dev.4/dev.5 bytes.
const sealed = require('./apply_backend_cold_start_patch').revertBundle(source);
const beforeContainerFix = fingerprint.finalize(sealed.replace(patch.CLEAR_AFTER, patch.CLEAR_BEFORE)).text;
assert.equal(crypto.createHash('sha256').update(beforeContainerFix).digest('hex'),
  'f26e06f9b42d650dff797f3ad44021d6826c02600bd94d41958fd40a5c653377', 'deployed dev.4 bundle is exact');
assert.equal(patch.patchBundle(beforeContainerFix), sealed, 'upgrade the deployed Terminal restore path');
const previous = fingerprint.finalize(beforeContainerFix.replace(patch.HELPER, '').replace(patch.AFTER, patch.BEFORE)).text;
assert.equal(crypto.createHash('sha256').update(previous).digest('hex'),
  '5519c6f04a0ca6a46ea81d8f2e6e2c293a006b7d620214eec6bef7bfff63fbea', 'previous bundle fixture must be exact');
assert.equal(patch.patchBundle(previous), sealed, 'maintenance replay must reproduce sealed bundle');
const legacy = fingerprint.finalize(previous.replace(patch.BEFORE, patch.LEGACY_AFTER)
  .replace(patch.ANCHOR, patch.LEGACY_HELPER + patch.ANCHOR)).text;
assert.equal(crypto.createHash('sha256').update(legacy).digest('hex'),
  '23ba6d13cd0d5711b07d62fefbd0a6a9e02e55dd69639fc8596b3d8e99f579fc', 'deployed legacy candidate is exact');
assert.equal(patch.patchBundle(legacy), sealed, 'upgrade the exact deployed helper and route together');
assert.equal(patch.patchBundle(source), source, 'patch must be idempotent');
assert.throws(() => patch.patchBundle(previous.replace(patch.BEFORE, 'missingRoute')), /anchor/);
assert.throws(() => patch.patchBundle(previous + patch.BEFORE), /anchor/);
assert.throws(() => patch.patchBundle(source.replace(patch.AFTER, patch.BEFORE)), /anchor|mixed/);
assert.throws(() => patch.patchBundle(source.replace('manual-terminal-click', 'changed-click')), /modified/);
assert.throws(() => patch.patchBundle(source.replace(patch.CLEAR_AFTER, 'unknownClear')), /anchor/);
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
const provider = extract('var __codexManualPreviewSeq = 0;', 'var kM=');
// 生产 webview 消息分支（minified，参数 g=panel 实例，I=message）。
const clause = extract('I.type==="openArtifact"&&', ',I.type==="revealArtifact"');
assert(clause.includes('globalThis.__codexOpenGraphPreview(I)||pag(I.path,I.baseDir)'), 'handler must try the exported preview before pag fallback');
// Production providers are sibling bundled modules. The old same-scope harness
// made a private callback visible to the Terminal and incorrectly passed.
const oldProvider = provider.replace('globalThis.__codexOpenGraphPreview = __codexOpenGraphPreview;\n\n', '');
vm.runInContext('(function(){' + oldProvider + '})();', context);
vm.runInContext('(function(){globalThis.__legacyDispatch=function(g,I){' + clause.replace(patch.AFTER, patch.LEGACY_AFTER) + '}})();', context);
const terminal = { _openHelpPanel: (p, l) => calls.help.push([p, l]) };
context.__legacyDispatch(terminal, { type: 'openArtifact', path: '/runs/r8/graph_001.svg' });
assert.equal(calls.ensure, 0, 'legacy module-private callback must reproduce the native failure');
assert.equal(calls.pag.length, 1, 'legacy click falls back to the ordinary editor');
calls.pag.length = 0;
vm.runInContext('(function(){' + provider + '})();', context);
vm.runInContext('(function(){globalThis.__dispatch=function(g,I){' + clause + '}})();', context);
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

// Restore/clear removed the captured artifact element from the real Terminal.
// Exercise the production clear and render functions with DOM detach semantics;
// retaining an off-screen object is not a visible artifact delivery.
class Element {
  constructor(root = false) { this.root = root; this.parentNode = null; this.children = []; this.html = ''; }
  get isConnected() { return this.root || !!this.parentNode?.isConnected; }
  set innerHTML(value) { this.html = value; for (const child of this.children) child.parentNode = null; this.children = []; }
  get innerHTML() { return this.html; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  querySelectorAll() { return []; }
}
const clearFunction = extract('    function clearAllOutput() {', '\n    function ');
const artifactFunctions = extract('    function renderSessionArtifacts() {', '    function removeSessionArtifact(');
function restoration(withFix) {
  const stream = new Element(true), artifacts = new Element();
  stream.appendChild(artifacts);
  const state = { chatStream: stream, sessionArtifactsEl: artifacts, runs: { old: {} },
    sessionArtifacts: [], sessionArtifactKeys: new Set(), history: ['old'], historyIndex: 0,
    updateLastCommand() {}, updateStatusIndicator() {}, scrollToBottom() {},
    renderArtifacts: items => items.map(item => item.path).join(','), bindArtifactImageEvents() {}, console: { log() {} } };
  vm.createContext(state);
  vm.runInContext((withFix ? clearFunction : clearFunction.replace(patch.CLEAR_AFTER, patch.CLEAR_BEFORE)) + artifactFunctions, state);
  for (let i = 0; i < 2; i++) {
    state.clearAllOutput();
    assert.equal(state.history.length, 0);
    assert.equal(Object.keys(state.runs).length, 0);
    assert.equal(state.sessionArtifacts.length, 0);
    assert.equal(state.addSessionArtifact({ path: '/saved/graph-' + i + '.svg', label: 'saved' }), true);
    state.renderSessionArtifacts();
    assert.equal(artifacts.innerHTML, '/saved/graph-' + i + '.svg');
    assert.equal(artifacts.isConnected, withFix, 'graph preview must be in the document after restore/clear');
    assert.equal(stream.children.length, withFix ? 1 : 0, 'reuse exactly one artifact container');
  }
}
restoration(false); // Exact old body reproduces the disconnected native result.
restoration(true);
console.log('MANUAL_GRAPH_PREVIEW_PASS: click opens Graphs without panel, relative+baseDir, non-graph/help/missing keep original, Stata calls 0');
