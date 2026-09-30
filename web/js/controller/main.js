// Phone controller entry point.
import { app } from './app.js';
import { initStage } from './stage.js';
import { initPanels } from './panels.js';

const stage = initStage();
const panels = initPanels(stage);
app.connect();

function frame(now) {
  stage.render(now);
  panels.frame(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Keep the phone awake while mapping.
async function keepAwake() {
  try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch (e) { /* unsupported */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });
keepAwake();

window.__pm = app; // handy for debugging and tests
