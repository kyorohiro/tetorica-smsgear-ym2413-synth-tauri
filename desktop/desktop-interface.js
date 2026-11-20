(() => {
  'use strict';
  const local = (location.protocol === 'tauri:' && location.hostname === 'localhost') ||
    (['http:', 'https:'].includes(location.protocol) && location.hostname === 'tauri.localhost');
  if (window.top !== window || !local || typeof window.__TAURI_INTERNALS__?.invoke !== 'function') return;
  const invoke = (command, args = {}) => window.__TAURI_INTERNALS__.invoke(command, args);
  const status = text => {const element = document.getElementById('audioStatus'); if (element) element.textContent = text;};
  const MAX_EXPORT_BYTES = 128 * 1024 * 1024, MAX_EXPORT_HEADER_BYTES = 4 * 1024;
  async function saveExport(blob, filename) {
    if (blob.size > MAX_EXPORT_BYTES) throw new Error('Export exceeds 128 MiB');
    const header = new TextEncoder().encode(JSON.stringify({filename}));
    if (!header.byteLength || header.byteLength > MAX_EXPORT_HEADER_BYTES) throw new Error('Export header exceeds 4096 bytes');
    const bytes = await blob.arrayBuffer();
    if (bytes.byteLength > MAX_EXPORT_BYTES) throw new Error('Export exceeds 128 MiB');
    const packet = new Uint8Array(4 + header.byteLength + bytes.byteLength);
    new DataView(packet.buffer).setUint32(0, header.byteLength, true);
    packet.set(header, 4);
    packet.set(new Uint8Array(bytes), 4 + header.byteLength);
    return invoke('save_export_binary', packet.buffer);
  }
  // Workspace replacement awaits this sink, so a cancelled native save keeps
  // the previous project and performance intact. Ordinary exports use the
  // anchor hook below. Both paths send the same original bytes.
  Object.defineProperty(window, 'tetoricaSynthSave', {
    value: async (bytes, filename, type = 'application/octet-stream') => {
      const blob = bytes instanceof Blob ? bytes : new Blob([bytes], {type});
      return (await saveExport(blob, filename)) !== null;
    },
  });
  const blobs = new Map();
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => {const url = create(blob); blobs.set(url, blob); return url;};
  URL.revokeObjectURL = url => {blobs.delete(url); return revoke(url);};
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const blob = blobs.get(this.href);
    if (!this.download || !blob) return click.call(this);
    // Hold the Blob before the Synth immediately revokes its temporary URL.
    const filename = this.download;
    void saveExport(blob, filename)
      .then(path => status(path ? `Saved ${path}` : 'Save cancelled.'))
      .catch(error => status(`Could not save: ${String(error)}`));
  };
  function confirmReload() {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.style.cssText = 'padding:24px;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--ink);font:16px system-ui';
      const message = document.createElement('p');
      message.textContent = 'Reload Synth? Playback and unsaved instrument changes will be cleared. Save a preset before reloading to keep the instrument.';
      const cancel = document.createElement('button'), confirm = document.createElement('button');
      cancel.textContent = 'Cancel'; confirm.textContent = 'Reload';
      cancel.addEventListener('click', () => dialog.close('cancel'));
      confirm.addEventListener('click', () => dialog.close('reload'));
      dialog.addEventListener('close', () => {const accepted = dialog.returnValue === 'reload'; dialog.remove(); resolve(accepted);}, {once:true});
      dialog.append(message, cancel, confirm); document.body.append(dialog); dialog.showModal(); cancel.focus();
    });
  }
  // The source menu keeps all of its own entries and listeners. Desktop
  // controls only extend that panel; Pin belongs beside the existing title.
  function ensureToolbarHost() {
    if (document.getElementById('synthDesktopTools')) return;
    const title = document.querySelector('.title-row');
    const panel = document.querySelector('#synthMenu .synth-menu-panel');
    if (!title || !panel) return;
    document.title = 'Tetorica SMSGEAR Synth';
    const host = document.createElement('div'); host.id = 'synthDesktopTools';
    const pin = document.createElement('button');
    pin.id = 'synthPinButton'; pin.type = 'button'; pin.hidden = true;
    pin.className = 'synth-icon-button';
    pin.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path class="pin-head" d="M9 3h6v5l3 5v2H6v-2l3-5z"/><path d="M12 15v7"/></svg>';
    const audio = document.createElement('section'); audio.id = 'synthMenuAudio';
    const reloadSection = document.createElement('section');
    const reload = document.createElement('button');
    reload.type = 'button'; reload.dataset.resetOfflineCache = ''; reload.textContent = 'Reload';
    reload.className = 'toolbar-button';
    reloadSection.append(reload); panel.append(audio, reloadSection);
    host.append(pin); title.append(host);
    const style = document.createElement('style');
    style.textContent = `
      #synthDesktopTools { display:flex; align-items:center; flex-shrink:0; margin-left:auto; }
      #synthPinButton { display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; min-height:36px; padding:0; border:1px solid var(--line); border-radius:50%; background:var(--panel); color:var(--accent-dark); cursor:pointer; box-shadow:none; }
      #synthPinButton[hidden] { display:none; }
      #synthPinButton svg { width:19px; height:19px; }
      #synthPinButton:hover, #synthPinButton.is-selected { background:#dbeaf4; border-color:var(--accent); color:var(--accent); }
      #synthPinButton.is-selected .pin-head { fill:var(--accent); }
      #synthPinButton:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
      #desktop-audio-output button { font:inherit; }
    `;
    document.head.append(style);
  }
  const mountedReloadButtons = new WeakSet(), mountedPinButtons = new WeakSet();
  function mountPin() {
    const button = document.getElementById('synthPinButton');
    if (!button || mountedPinButtons.has(button)) return;
    mountedPinButtons.add(button);
    let pinned = false, busy = true;
    const render = () => {
      button.disabled = busy;
      button.setAttribute('aria-pressed', String(pinned));
      button.classList.toggle('is-selected', pinned);
      button.title = pinned ? 'Unpin window' : 'Pin window on top';
      button.setAttribute('aria-label', button.title);
    };
    const readState = value => {
      if (typeof value !== 'boolean') throw new TypeError('Invalid native pin state');
      pinned = value;
    };
    // Keep the keyboard's performance target when clicking the toolbar.
    button.addEventListener('pointerdown', event => event.preventDefault());
    button.addEventListener('click', async () => {
      if (busy) return;
      busy = true; render();
      try {readState(await invoke('set_window_pin', {pinned: !pinned}));}
      catch (error) {status(`Could not pin window: ${String(error)}`);}
      finally {busy = false; render();}
    });
    render();
    void invoke('window_pin_state')
      .then(value => {readState(value); button.hidden = false;})
      .catch(error => status(`Could not read window pin state: ${String(error)}`))
      .finally(() => {busy = false; render();});
  }
  function mount() {
    ensureToolbarHost();
    mountPin();
    const button = document.querySelector('[data-reset-offline-cache]');
    if (!button || mountedReloadButtons.has(button)) return;
    mountedReloadButtons.add(button);
    button.addEventListener('click', async event => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (button.disabled) return;
      button.disabled = true;
      try {if (await confirmReload()) await invoke('reload_window');}
      catch (error) {status(`Could not reload: ${String(error)}`);}
      finally {button.disabled = false;}
    }, {capture: true});
  }
  window.addEventListener('tetorica-synth-ready', mount);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once: true});
  else mount();
})();
