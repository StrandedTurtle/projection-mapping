// Sound-reactive mode on the phone: microphone on/off, level meters, and the
// hop to the secure (https) page that browsers require for microphone access.

import { app } from './app.js';
import { MicAnalyser } from './audio.js';

const $ = (id) => document.getElementById(id);

export function initSound({ toast, stage }) {
  let lastBeat = 0;
  const mic = new MicAnalyser((f) => {
    if (app.link) app.link.send({ t: 'audio', ...f });
    // Let the phone's own preview dance too.
    const a = stage && stage.renderer && stage.renderer.audio;
    if (a) {
      a.active = true; a.level = f.l; a.bass = f.b; a.mid = f.m; a.high = f.h;
      if (f.beat !== lastBeat) { lastBeat = f.beat; a.beats++; a.beatAge = 0; }
    }
  });
  try { mic.sensitivity = +(localStorage.getItem('pm-mic-sens') || 1); } catch (e) { /* ignore */ }
  $('micSens').value = mic.sensitivity;
  $('micSensOut').textContent = mic.sensitivity.toFixed(1);

  function render() {
    $('micBtn').classList.toggle('on', mic.running);
    $('micStart').textContent = mic.running ? '⏹ Stop listening' : '🎤 Listen to music';
  }

  async function goSecure() {
    let port = 0;
    try { port = (await (await fetch('/api/info', { cache: 'no-store' })).json()).httpsPort; } catch (e) { /* offline */ }
    if (!port) { toast('This projector app does not support sound mode yet — update it'); return; }
    const ok = confirm('Phones only allow the microphone on a secure page, so this opens the secure version of the controller.\n\n'
      + 'You may see “Your connection is not private”: tap Advanced → Proceed. It\'s your own projector, so that\'s safe (you only need to do this once).');
    if (ok) location.href = `https://${location.hostname}:${port}/?mic=1`;
  }

  async function toggle() {
    if (mic.running) {
      mic.stop(); render();
      app.link.send({ t: 'audio', l: 0, b: 0, m: 0, h: 0, beat: mic.beats });
      if (stage && stage.renderer) stage.renderer.audio.active = false;
      return;
    }
    if (!MicAnalyser.supported()) {
      if (!window.isSecureContext) return goSecure();
      toast('This browser cannot use the microphone');
      return;
    }
    try {
      await mic.start();
      $('micBtn').classList.remove('attention');
      toast('🎤 Listening — shapes set to react will move with the music');
      if (!app.state.shapes.some((s) => s.content && s.content.react > 0)) {
        setTimeout(() => toast('Tip: Projector tab → “Make every shape react”'), 2600);
      }
    } catch (err) {
      toast(err && err.name === 'NotAllowedError' ? 'Microphone permission was blocked' : 'Could not start the microphone');
    }
    render();
  }

  $('micBtn').addEventListener('click', toggle);
  $('micStart').addEventListener('click', toggle);
  $('micSens').addEventListener('input', (e) => {
    mic.sensitivity = +e.target.value;
    $('micSensOut').textContent = mic.sensitivity.toFixed(1);
    try { localStorage.setItem('pm-mic-sens', String(mic.sensitivity)); } catch (err) { /* ignore */ }
  });
  $('reactAll').addEventListener('click', () => {
    if (!app.state.shapes.length) { toast('Add some shapes first'); return; }
    app.commit({ type: 'updateShapes', ids: app.state.shapes.map((s) => s.id), patch: { content: { react: 0.8, reactMode: 'pulse' } } });
    toast('Every shape now pulses to the music');
  });

  // Arrived from the "go secure" hop: one tap to start (browsers need a tap).
  if (new URLSearchParams(location.search).get('mic') === '1') {
    $('micBtn').classList.add('attention');
    setTimeout(() => toast('Tap 🎤 at the top to start listening'), 800);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && mic.running) {
      // Most phones cut the microphone off in the background.
      mic.stop();
      render();
    }
  });

  render();
  return {
    frame(now) {
      const a = stage && stage.renderer && stage.renderer.audio;
      if (a && mic.running) { a.beatAge += this._last ? (now - this._last) / 1000 : 0; }
      this._last = now;
      const m = mic.meter;
      $('micLevel').style.height = `${Math.round((mic.running ? m.l : 0) * 100)}%`;
      if (!$('panel-setup').hidden) {
        $('mB').style.height = `${m.b * 100}%`; $('mM').style.height = `${m.m * 100}%`;
        $('mH').style.height = `${m.h * 100}%`; $('mL').style.height = `${m.l * 100}%`;
      }
    },
    get running() { return mic.running; },
  };
}
