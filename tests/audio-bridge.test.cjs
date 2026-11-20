const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../desktop/audio-interface.js'), 'utf8')
  .replace('import.meta.url', JSON.stringify('tauri://localhost/synth-smsgear/synth.js'));
function boot({url = 'tauri://localhost/', subframe = false, native = true, save = true} = {}) {
  const documentEvents = new Map(), windowEvents = new Map();
  const trace = {ready: 0, stopped: 0, released: 0, cancelled: 0, pitch: .5, created: 0, projects: [], saved: []};
  const window = {addEventListener(type, listener) {windowEvents.set(type, listener);},
    dispatchEvent(event) {windowEvents.get(event.type)?.(event);},
    tetoricaSynthSave: async (bytes, filename, mime) => {trace.saved.push({bytes, filename, mime}); return save;}};
  if (native) window.__TAURI_INTERNALS__ = {invoke: async () => {}};
  window.top = subframe ? {} : window;
  const document = {readyState: 'complete', getElementById() {return null;},
    addEventListener(type, listener) {const list = documentEvents.get(type) ?? []; list.push(listener); documentEvents.set(type, list);}};
  windowEvents.set('tetorica-synth-ready', () => {trace.ready++;});
  vm.runInNewContext(`
    let audio = null;
    const clone = structuredClone, preset = {format: 'tetorica-smsgear-voice', psg: {attenuation: 3}}, keys = new Map([['key:z', {}]]);
    let pitch = .5, songMode = 'playing', songBusy = false, songState = {timeSamples: 44100};
    const host = {
      controls: {cancelPendingExecution() {trace.cancelled++;}, async flush() {return true;}},
      project: {exportProject() {return new Uint8Array([80,75]);}, cassetteName: 'Desktop'},
      files: {async newProject(options) {trace.projects.push(options);}},
      getState: () => ({running: true}),
    };
    async function ensureAudio() {
      if (!audio) {trace.created++; audio = {context: {state: 'running'}, masterNode: {master: true},
        readState: async () => ({psg: {channels: []}, opll: Array(64).fill(0)}), async dispose() {}};}
      return audio;
    }
    function allKeyboardOff() {trace.released++; keys.clear();}
    async function stopAll() {trace.stopped++; songMode = 'stopped';}
    function setPitch(value) {pitch = trace.pitch = value;}
    function keyAction(key) {return key === 'z' ? {kind: 'note'} : null;}
    function status(value) {trace.status = value;}
    function report(error) {trace.error = String(error);}
    ${source}
  `, {window, document, location: new URL(url), URL, Event, structuredClone, Uint8Array, trace});
  function event(type, {key = '', ctrlKey = false, selector = null} = {}) {
    const value = {type, key, ctrlKey, target: {closest: query => selector && query.split(', ').includes(selector) ? {} : null},
      preventDefault() {this.prevented = true;}, stopImmediatePropagation() {this.blocked = true;}};
    for (const listener of documentEvents.get(type) ?? []) {listener(value); if (value.blocked) break;}
    return value;
  }
  return {window, trace, event};
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('appended SMSGEAR bridge is local and audio-lazy, returning the existing final Master', async () => {
  const ui = boot(); assert.equal(ui.trace.created, 0); assert.equal(ui.trace.ready, 1);
  const first = await ui.window.tetoricaSynthAudio.ensureReady(), second = await ui.window.tetoricaSynthAudio.ensureReady();
  assert.equal(first.context, second.context); assert.equal(first.output, second.output); assert.equal(first.output.master, true);
  assert.equal(ui.trace.created, 1); assert.equal((await ui.window.tetoricaSynthAudio.readState()).opll.length, 64);
  for (const options of [{url: 'https://example.com/'}, {url: 'http://localhost:8080/'}, {subframe: true}, {native: false}])
    assert.equal(boot(options).window.tetoricaSynthAudio, undefined);
});
test('output switch stops sources, cancels pending Code and clears keyboard and pitch', async () => {
  const ui = boot(), bridge = ui.window.tetoricaSynthAudio;
  bridge.setSwitching(true); assert.equal(ui.trace.released, 1); assert.equal(ui.trace.cancelled, 1);
  assert.equal(ui.event('keydown', {key: 'z'}).blocked, true);
  assert.equal(ui.event('keydown', {key: 'Enter', ctrlKey: true}).blocked, true);
  assert.equal(ui.event('click', {selector: '#songPlay'}).blocked, true);
  assert.equal(ui.event('pointerdown', {selector: '#keyboard'}).blocked, true);
  assert.equal(ui.event('click', {selector: '#synthCodeRunButton'}).blocked, true);
  assert.equal(ui.event('click', {selector: '#stopAudio'}).blocked, undefined);
  await bridge.stopPlayback(); assert.equal(ui.trace.stopped, 1); assert.equal(ui.trace.pitch, 0);
  assert.equal(bridge.getState().activeKeys.length, 0); assert.equal(bridge.getState().song.mode, 'stopped');
  bridge.setSwitching(false); assert.equal(ui.event('keydown', {key: 'z'}).blocked, undefined);
});
test('native backup cancellation preserves the existing Cassette and successful save precedes replacement', async () => {
  for (const save of [false, true]) {
    const ui = boot({save}); assert.equal(ui.event('click', {selector: '#smsgearNewCassetteExport'}).blocked, true);
    await flush(); assert.equal(ui.trace.saved.length, 1); assert.equal(ui.trace.saved[0].filename, 'Desktop.cassette.zip');
    assert.equal(ui.trace.projects.length, save ? 1 : 0);
    if (save) assert.equal(ui.trace.projects[0].exportCurrent, false);
    else assert.equal(ui.trace.status, 'Save cancelled.');
    assert.equal(ui.trace.created, 0);
  }
});
