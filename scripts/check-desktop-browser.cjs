// SPDX-License-Identifier: BSD-3-Clause
// Actual packaged SMSGEAR PSG / YM2413 WASM and Worklets, mocked Tauri IPC.
// Every physical speaker route passes through zero gain; no CPAL device opens.
const {chromium, webkit} = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {gzipSync} = require('node:zlib');
const {createHash} = require('node:crypto');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const options = {out:path.join(root,'docs/desktop_browser_20261120.json'), screenshots:null};
for(let index=2;index<process.argv.length;index++) {
  const name=process.argv[index].replace(/^--/,'');
  assert(Object.hasOwn(options,name),`Unknown option: ${name}`);
  assert(process.argv[index+1],`Missing value: ${name}`);
  options[name]=path.resolve(process.argv[++index]);
}
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm',
  '.json':'application/json','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml'};
function vgm() {
  const data = [0x4f, 0xff, 0x50, 0x8c, 0x50, 0x21, 0x50, 0x90,
    0x51, 0x30, 0x13, 0x51, 0x10, 0x80, 0x51, 0x20, 0x17];
  for (let index = 0; index < 20; index++) data.push(0x61, 0xff, 0xff);
  data.push(0x66);
  const bytes = Buffer.alloc(256 + data.length);
  bytes.write('Vgm '); bytes.writeUInt32LE(bytes.length - 4, 4); bytes.writeUInt32LE(0x171, 8);
  bytes.writeUInt32LE(3_579_545, 0x0c); bytes.writeUInt32LE(3_579_545, 0x10);
  bytes.writeUInt32LE(20 * 65535, 0x18); bytes.writeUInt32LE(256 - 0x34, 0x34);
  bytes.set(data, 256); return bytes;
}
async function run(name, engine, backend) {
  const browser=await engine.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:1000},acceptDownloads:true});
  page.setDefaultTimeout(15000);
  const errors=[], missing=[], consoleErrors=[], blockedMonaco=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  const desktop=await fs.readFile(path.join(root,'desktop/desktop-interface.js'),'utf8');
  const audio=await fs.readFile(path.join(root,'desktop/audio-interface.js'),'utf8');
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(['blob:','data:'].includes(url.protocol)) return route.continue();
    if(url.hostname!=='tauri.localhost') {if(url.hostname==='cdnjs.cloudflare.com'&&url.pathname.includes('/monaco-editor/'))blockedMonaco.push(url.href);else missing.push(url.href);return route.abort();}
    try {
      const file=url.pathname==='/desktop-audio-worklet.js' ? path.join(root,'desktop/audio-worklet.js')
        :path.resolve(root,'dist','.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
      assert(file.startsWith(path.join(root,'dist')+path.sep)||file===path.join(root,'desktop/audio-worklet.js'));
      let body=await fs.readFile(file);
      if(url.pathname==='/synth-smsgear/synth.js') body=Buffer.concat([body,Buffer.from('\n;\n'+audio)]);
      return route.fulfill({status:200,body,contentType:mime[path.extname(file)]||'application/octet-stream',
        headers:{'access-control-allow-origin':'*'}});
    } catch(error) {missing.push(`${url.pathname}: ${error.message}`);return route.fulfill({status:404,body:'Missing asset'});}
  });
  await page.addInitScript(({backend})=>{
    const audit=window.desktopAudit={calls:[],saves:[],contexts:[],worklets:[],speakerEdges:new Map(),
      pinned:false,nextRead:0,packets:0,returned:0,nativePeak:0,nativeFinite:true,nativeSession:0,failWrites:false,holdStart:false,cancelSave:false};
    const Context=window.AudioContext??window.webkitAudioContext, Node=window.AudioWorkletNode;
    const connect=AudioNode.prototype.connect,disconnect=AudioNode.prototype.disconnect;
    window.AudioContext=class extends Context {constructor(...args){
      super(...args);audit.contexts.push(this);
      // Playwright page routes do not see AudioWorklet module fetches. Serve
      // those exact bytes through a real CORS-enabled loopback test server.
      const add=this.audioWorklet.addModule.bind(this.audioWorklet);
      this.audioWorklet.addModule=(url,...options)=>{
        const value=new URL(url,location.href);
        return add(value.hostname==='tauri.localhost'?new URL(value.pathname+value.search,backend).href:url,...options);
      };
    }};
    if(window.webkitAudioContext) window.webkitAudioContext=window.AudioContext;
    window.AudioWorkletNode=class extends Node {constructor(...args){super(...args);audit.worklets.push({node:this,name:args[1]});}};
    AudioNode.prototype.connect=function(destination,...args){
      if(destination!==this.context.destination) return connect.call(this,destination,...args);
      const analyser=this.context.createAnalyser();analyser.fftSize=4096;
      const mute=this.context.createGain();mute.gain.value=0;
      connect.call(this,analyser);connect.call(analyser,mute);connect.call(mute,destination);
      audit.speakerEdges.set(this,{analyser,mute});return destination;
    };
    AudioNode.prototype.disconnect=function(destination,...args){
      const edge=audit.speakerEdges.get(this);
      if(edge&&(arguments.length===0||destination===this.context.destination)) {
        disconnect.call(this,edge.analyser);disconnect.call(edge.analyser);disconnect.call(edge.mute);audit.speakerEdges.delete(this);
        if(arguments.length) return;
      }
      return arguments.length?disconnect.call(this,destination,...args):disconnect.call(this);
    };
    audit.read=()=>window.tetoricaSynthAudio.readState();
    audit.webPeak=async()=>{
      const {output}=await window.tetoricaSynthAudio.ensureReady(),edge=audit.speakerEdges.get(output);
      if(!edge)return 0;const samples=new Float32Array(edge.analyser.fftSize);edge.analyser.getFloatTimeDomainData(samples);
      return samples.reduce((peak,value)=>Math.max(peak,Math.abs(value)),0);
    };
    window.__TAURI_INTERNALS__={invoke:async(command,args={},options)=>{
      audit.calls.push({command,session:args?.session,bytes:args instanceof ArrayBuffer?args.byteLength:null});
      if(command==='window_pin_state')return audit.pinned;
      if(command==='set_window_pin')return audit.pinned=args.pinned;
      if(command==='save_export_binary') {
        const length=new DataView(args).getUint32(0,true),header=JSON.parse(new TextDecoder().decode(new Uint8Array(args,4,length)));
        const bytes=new Uint8Array(args,4+length),text=new TextDecoder().decode(bytes);
        audit.saves.push({header,text,bytes:[...bytes]});return audit.cancelSave?null:'/tmp/'+header.filename;
      }
      if(command==='audio_devices')return [{id:'offline-test',name:'Offline test device',isDefault:true}];
      if(command==='audio_start') {
        if(audit.holdStart)await new Promise(resolve=>{audit.releaseStart=()=>{audit.holdStart=false;resolve();};});
        return {session:`offline-${++audit.nativeSession}`,frames:512,credits:8,sampleRate:args.sampleRate};
      }
      if(command==='audio_stop')return null;
      if(command==='audio_write') {
        if(audit.failWrites)throw Error('Injected offline device failure');
        const samples=new Float32Array(args);audit.packets+=args.byteLength/(512*8);
        for(const value of samples){audit.nativeFinite&&=Number.isFinite(value);audit.nativePeak=Math.max(audit.nativePeak,Math.abs(value));}
        return {rustMicros:100,serviceMicros:200};
      }
      if(command==='audio_poll') {
        await new Promise(resolve=>setTimeout(resolve,20));const credits=Math.min(8,audit.packets-audit.returned);audit.returned+=credits;
        return {credits,queuedFrames:1024,underruns:0};
      }
      if(command==='reload_window')return null;
      throw Error(`Unexpected native command: ${command}`);
    }};
  },{backend});
  await page.addInitScript({content:desktop});
  const state = () => page.evaluate(() => window.tetoricaSynthAudio.getState());
  const code = async () => (await state()).code;
  const poll = async (read, predicate, label = 'State did not settle') => {
    let value;
    for (let index = 0; index < 200; index++) {
      value = await read(); if (predicate(value)) return value; await page.waitForTimeout(25);
    }
    throw Error(label + ': ' + JSON.stringify(value));
  };
  const wait = predicate => poll(state, predicate);
  const menu = async () => {if (!await page.locator('#synthMenu').evaluate(node => node.open)) await page.click('#synthMenu > summary');};
  const closeMenu = async () => {if (await page.locator('#synthMenu').evaluate(node => node.open)) await page.click('#synthMenu > summary');};
  const blur = () => page.evaluate(() => document.activeElement?.blur());
  const peak = () => poll(() => page.evaluate(() => desktopAudit.webPeak()), value => value > .0001, 'No final Master PCM before physical mute');
  const audition = async chip => {
    await closeMenu(); await page.click(chip === 'ym2413' ? '#opllTab' : '#psgTab');
    await blur(); await page.keyboard.down('z'); await wait(value => value.activeKeys.length === 1);
    await poll(() => page.evaluate(() => desktopAudit.read()), value =>
      (chip === 'ym2413' ? value.fm : value.psg).channels.some(channel => channel.active), 'Keyboard hardware gate did not open');
    await page.waitForTimeout(120);
    const value = await peak(); await page.keyboard.up('z'); await wait(value => !value.activeKeys.length);
    await poll(() => page.evaluate(() => desktopAudit.read()), value =>
      !(chip === 'ym2413' ? value.fm : value.psg).channels.some(channel => channel.active), 'Keyboard hardware gate did not close');
    await page.waitForTimeout(120); return value;
  };
  const files = async () => {
    await closeMenu();
    if (await page.locator('#smsgearFilesPanel').isHidden()) await page.click('#smsgearFilesToggle');
    const examples = page.locator('summary[data-file-path="/examples"]');
    if (!await examples.evaluate(node => node.parentNode.open)) await examples.click();
  };
  const timed = async (chip, native = false) => {
    await files();
    const path = chip === 'segapsg' ? '/examples/psg-timed.js' : '/examples/opll-timed.js';
    await page.click(`[data-file-path="${path}"]`);
    await page.click('#synthInputCodeTab'); await page.click('#synthCodeRunButton');
    await poll(code, value => value.running, 'Timed Code did not run');
    await poll(() => page.evaluate(() => desktopAudit.read()), value =>
      (chip === 'ym2413' ? value.fm : value.psg).channels.some(channel => channel.active), 'Timed Code hardware gate did not open');
    await page.waitForTimeout(120);
    const value = native ? await poll(() => page.evaluate(() => desktopAudit.nativePeak), value => value > .0001) : await peak();
    assert.equal(await page.locator('#synthCodeError').textContent(), '');
    await page.click('#synthInputKeyboardTab'); assert((await code()).running, 'Keyboard view preserves Code');
    await page.click('#synthInputCodeTab'); await page.click('#synthCodeStopButton'); await poll(code, value => !value.running);
    await page.click('#synthInputKeyboardTab'); return {chip, peak: value, native};
  };
  const importMusic = async (filename, bytes) => {
    await menu(); const chooser = page.waitForEvent('filechooser'); await page.click('#loadVgm');
    await (await chooser).setFiles({name: filename, mimeType: 'application/octet-stream', buffer: bytes});
    await page.waitForFunction(name => [...document.querySelector('#songSelect').options].some(option => option.textContent === name), filename);
    await page.locator('#songSelect').selectOption({label: filename});
  };
  try {
    console.log(`CHECK ${name}: existing SMSGEAR menu / Pin / native binary save`);
    await page.goto(backend + '/index.html');
    await page.waitForFunction(() => window.tetoricaSynthAudio &&
      document.querySelector('#synthPinButton')?.hidden === false && document.querySelector('#desktop-audio-native'));
    await page.waitForFunction(() => document.querySelector('#smsgearFileNewButton')?.disabled === false);
    assert.equal(await page.title(), 'Tetorica SMSGEAR Synth');
    assert.equal(await page.locator('.title-row .product-name').textContent(), 'SMSGEAR Synth');
    for (const id of ['synthMenu', 'synthPinButton', 'synthDesktopTools', 'smsgearMenuProjectNew', 'loadVgm',
      'smsgearMenuProjectImport', 'smsgearMenuFilesImport', 'smsgearMenuProjectExport', 'smsgearMenuFileExport'])
      assert.equal(await page.locator('#' + id).count(), 1, `${id} remains unique`);
    assert.equal(await page.locator('.title-row #synthPinButton').count(), 1);
    assert.equal(await page.locator('.audio-toolbar #synthMenu').count(), 1, 'original menu remains in its toolbar');
    assert.equal(await page.locator('#synthMenu .synth-menu-panel #desktop-audio-output').count(), 1);
    assert.equal(await page.evaluate(() => desktopAudit.contexts.length), 0);
    await page.click('#synthPinButton'); await page.waitForFunction(() => document.querySelector('#synthPinButton').getAttribute('aria-pressed') === 'true');
    await page.click('#synthPinButton'); await page.waitForFunction(() => document.querySelector('#synthPinButton').getAttribute('aria-pressed') === 'false');
    await menu(); await page.click('[data-reset-offline-cache]');
    await page.getByRole('dialog').waitFor(); await page.getByRole('button', {name: 'Cancel', exact: true}).click();
    assert.equal(await page.evaluate(() => desktopAudit.calls.filter(call => call.command === 'reload_window').length), 0);
    await menu(); await page.click('#smsgearProjectExportButton');
    await page.waitForFunction(() => desktopAudit.saves.length === 1);
    const exported = await page.evaluate(() => desktopAudit.saves[0]);
    assert.match(exported.header.filename, /\.cassette\.zip$/); assert.deepEqual(exported.bytes.slice(0, 2), [80, 75]);
    assert.equal(await page.evaluate(() => desktopAudit.contexts.length), 0, 'native save is audio-lazy');
    await page.evaluate(() => {desktopAudit.cancelSave = true;}); await menu(); await page.click('#smsgearProjectExportButton');
    await page.waitForFunction(() => document.querySelector('#audioStatus').textContent === 'Save cancelled.');
    await page.evaluate(() => {desktopAudit.cancelSave = false;});

    console.log(`CHECK ${name}: real PSG / YM2413 / timed Code / shared Master`);
    await page.click('#startAudio'); await page.waitForFunction(() => document.querySelector('#startAudio').textContent === 'Audio ready');
    const keyboardPeaks = {segapsg: await audition('segapsg'), ym2413: await audition('ym2413')};
    const timedExamples = [await timed('segapsg'), await timed('ym2413')];
    assert.equal(await page.evaluate(() => desktopAudit.contexts.length), 1);
    for (const chip of ['segapsg', 'ym2413']) assert.equal(await page.evaluate(chip => desktopAudit.worklets.filter(entry => entry.name === 'tetorica-' + chip).length, chip), 1);

    // A native backup cancellation must keep the active Code, Files and sound.
    await files(); await page.click('[data-file-path="/examples/psg.js"]'); await page.click('#synthInputCodeTab');
    await page.click('#synthCodeRunButton'); await poll(code, value => value.running);
    const before = await page.locator('#smsgearFilesTree [data-file-path]').evaluateAll(nodes => nodes.map(node => node.dataset.filePath).sort());
    const beforePreset = (await state()).preset, saves = await page.evaluate(() => desktopAudit.saves.length);
    await page.evaluate(() => {desktopAudit.cancelSave = true;}); await menu(); await page.click('#smsgearProjectNewButton');
    await page.click('#smsgearNewCassetteExport'); await page.waitForFunction(count => desktopAudit.saves.length === count + 1, saves);
    await page.waitForFunction(() => document.querySelector('#audioStatus').textContent === 'Save cancelled.');
    assert((await code()).running); assert.deepEqual((await state()).preset, beforePreset);
    assert.deepEqual(await page.locator('#smsgearFilesTree [data-file-path]').evaluateAll(nodes => nodes.map(node => node.dataset.filePath).sort()), before);
    await page.click('#smsgearNewCassetteCancel'); await page.evaluate(() => {desktopAudit.cancelSave = false;});
    await page.click('#synthCodeStopButton'); await poll(code, value => !value.running); await page.click('#synthInputKeyboardTab');

    console.log(`CHECK ${name}: native attach / latest request / output guards / device fallback`);
    await menu(); await page.locator('#desktop-audio-output > summary').click();
    await page.evaluate(() => {desktopAudit.holdStart = true;});
    await page.click('#desktop-audio-native'); await page.waitForFunction(() => typeof desktopAudit.releaseStart === 'function');
    await page.click('#desktop-audio-web'); await page.evaluate(() => desktopAudit.releaseStart());
    await page.waitForFunction(() => document.querySelector('#desktop-audio-status').textContent === 'Web Audio output' && !document.querySelector('#desktop-audio-mode').disabled);
    assert(await page.evaluate(async () => desktopAudit.speakerEdges.has((await tetoricaSynthAudio.ensureReady()).output)));
    assert(await page.evaluate(() => desktopAudit.calls.some(call => call.command === 'audio_stop' && call.session === 'offline-1')));

    await blur(); await page.keyboard.down('z'); await wait(value => value.activeKeys.length === 1);
    const preserved = (await state()).preset;
    await page.click('#desktop-audio-native');
    await page.waitForFunction(() => document.querySelector('#desktop-audio-status').textContent.startsWith('Native →'));
    await wait(value => !value.activeKeys.length && value.pitch === 0); await page.keyboard.up('z');
    assert.deepEqual((await state()).preset, preserved);
    assert.equal(await page.evaluate(async () => desktopAudit.speakerEdges.has((await tetoricaSynthAudio.ensureReady()).output)), false, 'native capture removes direct speaker edge');
    await page.evaluate(() => {desktopAudit.nativePeak = 0;});
    await blur(); await page.keyboard.down('z'); await page.waitForFunction(() => desktopAudit.nativePeak > .0001); await page.keyboard.up('z');
    for (const chip of ['segapsg', 'ym2413']) {
      await page.evaluate(() => {desktopAudit.nativePeak = 0;}); timedExamples.push(await timed(chip, true));
    }
    // Prove capture occurs after Code FX and Master, using the same real PSG.
    await files(); await page.click('[data-file-path="/examples/psg.js"]'); await page.click('#synthInputCodeTab');
    const fxSource = gain => `const psg = await useSoundChip("segapsg");
fx.setChain([fx.gain({gain:${gain}})]);
psg.noteOn(CH1,"C4");
liveLoop("desktop-fx",async()=>{await beat(1);});`;
    const editCode = source => page.evaluate(source => {
      const editor = document.querySelector('#synthCodeEditor'); editor.value = source;
      editor.dispatchEvent(new Event('input', {bubbles: true}));
    }, source);
    await editCode(fxSource(.5)); await page.click('#synthCodeRunButton'); await poll(code, value => value.running);
    await page.evaluate(() => {desktopAudit.nativePeak = 0;}); await page.waitForFunction(() => desktopAudit.nativePeak > .0001);
    const master = await page.locator('#masterVolume').inputValue();
    await page.locator('#masterVolume').evaluate(node => {node.value = '0'; node.dispatchEvent(new Event('input', {bubbles: true}));});
    await page.waitForTimeout(200); await page.evaluate(() => {desktopAudit.nativePeak = 0;}); await page.waitForTimeout(120);
    assert(await page.evaluate(() => desktopAudit.nativePeak < .00001), 'Native capture includes Master gain');
    await page.locator('#masterVolume').evaluate((node, value) => {node.value = value; node.dispatchEvent(new Event('input', {bubbles: true}));}, master);
    await page.waitForFunction(() => desktopAudit.nativePeak > .0001);
    await editCode(fxSource(0)); await page.click('#synthCodeRunButton'); await poll(code, value => value.running);
    await page.waitForTimeout(200); await page.evaluate(() => {desktopAudit.nativePeak = 0;}); await page.waitForTimeout(120);
    assert(await page.evaluate(() => desktopAudit.nativePeak < .00001), 'Native capture includes Code FX gain');
    assert.equal(await page.locator('#synthCodeError').textContent(), '');
    await page.click('#synthCodeStopButton'); await poll(code, value => !value.running); await page.click('#synthInputKeyboardTab');
    await closeMenu();
    await page.evaluate(async () => {tetoricaSynthAudio.setSwitching(true); await tetoricaSynthAudio.stopPlayback();});
    await blur(); await page.keyboard.down('z'); assert.equal((await state()).activeKeys.length, 0); await page.keyboard.up('z');
    await page.click('#synthInputCodeTab'); await page.click('#synthCodeRunButton'); await page.waitForTimeout(100);
    assert.equal((await code()).running, false, 'switching guards Code Run');
    await page.evaluate(() => tetoricaSynthAudio.setSwitching(false)); await page.click('#synthInputKeyboardTab');

    console.log(`CHECK ${name}: generated PSG + YM2413 VGM through native final Master`);
    await importMusic('generated-smsgear.vgz', gzipSync(vgm()));
    await page.evaluate(() => {desktopAudit.nativePeak = 0;});
    await page.click('#songPlay'); await wait(value => value.song.mode === 'playing' && value.song.state?.timeSamples > 0);
    await page.waitForFunction(() => desktopAudit.nativePeak > .0001);
    const referencePeak = await page.evaluate(() => desktopAudit.nativePeak);
    await page.click('#songPause'); await wait(value => value.song.mode === 'paused');
    await menu(); await page.click('#desktop-audio-web');
    await page.waitForFunction(() => document.querySelector('#desktop-audio-status').textContent === 'Web Audio output');
    await wait(value => value.song.mode === 'stopped' && !value.code.running && !value.activeKeys.length);
    assert.deepEqual((await state()).preset, preserved);
    await audition('segapsg');
    await menu(); await page.click('#desktop-audio-native');
    await page.waitForFunction(() => document.querySelector('#desktop-audio-status').textContent.startsWith('Native →'));
    await page.evaluate(() => {desktopAudit.failWrites = true;});
    await page.waitForFunction(() => document.querySelector('#desktop-audio-status').textContent.includes('Injected offline device failure'));
    await wait(value => !value.activeKeys.length && !value.code.running);
    await audition('ym2413');
    assert.equal(await page.evaluate(() => desktopAudit.contexts.length), 1);
    const measurements = await page.evaluate(() => ({nativePackets: desktopAudit.packets, nativePeak: desktopAudit.nativePeak,
      nativeFinite: desktopAudit.nativeFinite, physicalOutputMuted: [...desktopAudit.speakerEdges.values()].every(value => value.mute.gain.value === 0)}));
    assert(measurements.nativeFinite && measurements.physicalOutputMuted);
    if (options.screenshots) {
      await page.screenshot({path: path.join(options.screenshots, `desktop-${name}.png`), fullPage: true});
      await menu(); await page.screenshot({path: path.join(options.screenshots, `desktop-${name}-menu.png`), fullPage: true}); await closeMenu();
    }
    await page.setViewportSize({width: 390, height: 900}); await page.waitForTimeout(120);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth); assert(overflow <= 1, `Narrow overflow ${overflow}`);
    if (options.screenshots) await page.screenshot({path: path.join(options.screenshots, `desktop-${name}-narrow.png`), fullPage: true});
    await page.evaluate(() => {desktopAudit.failWrites = false;}); await menu(); await page.click('#desktop-audio-native');
    await page.waitForFunction(() => document.querySelector('#desktop-audio-status').textContent.startsWith('Native →'));
    const stopBefore = await page.evaluate(() => desktopAudit.calls.filter(call => call.command === 'audio_stop').length);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await page.waitForFunction(count => desktopAudit.calls.filter(call => call.command === 'audio_stop').length > count, stopBefore);
    await page.waitForTimeout(120);
    assert.deepEqual(errors, []); assert.deepEqual(missing, []);
    return {engine: name, passed: true, toolbarUnique: true, originalMenuPreserved: true, pin: true,
      nativeBinarySave: true, saveCancel: true, newProjectBackupCancelPreservesCodeFilesSound: true,
      keyboardPeaks, timedExamples, referenceVgm: {filename: 'generated-smsgear.vgz', chips: ['segapsg', 'ym2413'], peak: referencePeak},
      latestOutputRequestWins: true, outputSwitchStopsSources: true, outputSwitchBlocksKeysAndCode: true,
      nativeCapturePcm: true, nativeFxAndMaster: true, nativeFailureFallback: true, pagehideTeardown: true, oneAudioContext: true,
      mobileOverflow: overflow, ...measurements, nativeHost: 'mocked Tauri IPC; no CPAL device',
      pageErrors: errors, missingAssets: missing, expectedBlockedMonaco: blockedMonaco};
  } catch (error) {
    console.error(JSON.stringify({engine: name, audioStatus: await page.locator('#audioStatus').textContent().catch(() => null),
      songStatus: await page.locator('#songReadout').textContent().catch(() => null),
      codeError: await page.locator('#synthCodeError').textContent().catch(() => null), errors, missing, consoleErrors}));
    if (options.screenshots) await page.screenshot({path: path.join(options.screenshots, `desktop-${name}-failure.png`), fullPage: true}).catch(() => {});
    throw error;
  } finally {await browser.close();}
}
(async()=>{
  if(options.screenshots)await fs.mkdir(options.screenshots,{recursive:true});
  const server=http.createServer(async(request,response)=>{
    try {
      let name=decodeURIComponent(new URL(request.url,'http://localhost').pathname);if(name.endsWith('/'))name+='index.html';
      const file=name==='/desktop-audio-worklet.js'?path.join(root,'desktop/audio-worklet.js'):path.resolve(root,'dist','.'+name);
      assert(file.startsWith(path.join(root,'dist')+path.sep)||file===path.join(root,'desktop/audio-worklet.js'));
      const bytes=await fs.readFile(file);response.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','access-control-allow-origin':'*'});response.end(bytes);
    } catch(error){response.writeHead(404,{'access-control-allow-origin':'*'});response.end('Missing test asset');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try {
    const backend=`http://tauri.localhost:${server.address().port}`;
    const rows=[];for(const [name,engine] of [['chromium',chromium],['webkit',webkit]])rows.push(await run(name,engine,backend));
    const sourceFiles = ['desktop/audio-interface.js', 'desktop/desktop-interface.js', 'desktop/audio-worklet.js',
      'scripts/check-desktop-browser.cjs', 'dist/synth-smsgear/synth.js', 'dist/synth-smsgear/audio.js',
      'dist/generated/segapsg_wasm.wasm', 'dist/generated/ym2413_wasm.wasm', 'dist/js/native_audio_effect.wasm'];
    const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
      [file, createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')])));
    const report = {schemaVersion: 1, passed: true, createdAt: new Date().toISOString(),
      scope: 'Packaged SMSGEAR assets and real PSG/YM2413/FX WASM + AudioWorklets in physically muted Chromium and WebKit.',
      limitations: ['Tauri IPC is mocked; no CPAL device is opened and this is not a listening test.',
        'Monaco CDN is deliberately blocked; Code uses its built-in textarea fallback.'], sources, rows};
    await fs.mkdir(path.dirname(options.out),{recursive:true});await fs.writeFile(options.out,JSON.stringify(report,null,2)+'\n');
    console.log(`Desktop browser check passed: ${options.out}`);
  } finally {await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
