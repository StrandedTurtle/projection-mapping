// Controller core: holds the local copy of the project, talks to the
// projector, and provides undo/redo + selection to the UI modules.

import { Link } from '../net.js';
import { applyOp, defaultState, normalizeState, findShape, clone } from '../state.js';

const listeners = new Set();
const undoStack = [];
const redoStack = [];
let lastUndoKey = null;
let lastUndoTime = 0;

export const app = {
  state: defaultState(),
  aspect: 16 / 9,
  selection: { id: null, point: -1 },
  synced: false,
  link: null,
  gesture: false, // true while a finger is dragging on the stage

  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit(reason = 'change', detail = {}) { for (const fn of listeners) fn(reason, detail); },

  selected() { return this.selection.id ? findShape(this.state, this.selection.id) : null; },

  select(id, point = -1) {
    if (id === this.selection.id && point === this.selection.point) return;
    this.selection = { id, point };
    this.link && this.link.send({ t: 'sel', id, point });
    this.emit('selection');
  },

  /** Save an undo point (coalesced when the same control keeps changing). */
  checkpoint(key = null) {
    const now = Date.now();
    if (key && key === lastUndoKey && now - lastUndoTime < 1500) { lastUndoTime = now; return; }
    lastUndoKey = key; lastUndoTime = now;
    undoStack.push(JSON.stringify(this.state));
    if (undoStack.length > 80) undoStack.shift();
    redoStack.length = 0;
    this.emit('history');
  },

  /**
   * Apply an op locally and send it to the projector (and other phones).
   * opts.undo: false to skip the undo point, opts.key to coalesce, opts.quiet
   * to skip re-rendering the panels (e.g. while a slider is being dragged).
   */
  commit(op, opts = {}) {
    if (opts.undo !== false) this.checkpoint(opts.key || null);
    applyOp(this.state, op);
    this.link && this.link.send({ t: 'op', op });
    this.emit(opts.quiet ? 'quiet' : 'change', { op });
  },

  undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(this.state));
    this._restore(undoStack.pop());
  },
  redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(this.state));
    this._restore(redoStack.pop());
  },
  canUndo() { return undoStack.length > 0; },
  canRedo() { return redoStack.length > 0; },
  _restore(json) {
    lastUndoKey = null;
    const state = JSON.parse(json);
    applyOp(this.state, { type: 'replace', state });
    this.link && this.link.send({ t: 'op', op: { type: 'replace', state: clone(this.state) } });
    if (this.selection.id && !findShape(this.state, this.selection.id)) this.select(null);
    this.emit('change');
    this.emit('history');
  },

  connect() {
    this.link = new Link('controller', {
      onStatus: (up) => {
        if (up) this.link.send({ t: 'hello' });
        this.emit('status');
      },
      onPeers: (p) => {
        if (p.displays > 0 && !this.synced) this.link.send({ t: 'hello' });
        if (p.displays === 0) this.synced = false;
        this.emit('status');
      },
      onMessage: (msg) => {
        if (msg.t === 'sync') {
          if (msg.aspect) this.aspect = msg.aspect;
          const first = !this.synced;
          this.synced = true;
          if (this.gesture && !first) return; // don't yank a shape from under a finger
          applyOp(this.state, { type: 'replace', state: normalizeState(msg.state) });
          if (this.selection.id && !findShape(this.state, this.selection.id)) this.selection = { id: null, point: -1 };
          else if (this.selection.id) this.link.send({ t: 'sel', ...this.selection });
          this.emit('change', { remote: true });
          this.emit('status');
        } else if (msg.t === 'op') {
          applyOp(this.state, msg.op);
          if (this.selection.id && !findShape(this.state, this.selection.id)) this.selection = { id: null, point: -1 };
          this.emit('change', { remote: true });
        }
      },
    });
  },
};
