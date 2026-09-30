// WebSocket link to the relay server (runs on the TV app or on a computer).
// Reconnects automatically; the server relays every message to all other
// connected pages and tells everyone who is online ("peers").

export class Link {
  constructor(role, { onMessage, onStatus, onPeers } = {}) {
    this.role = role;
    this.onMessage = onMessage || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onPeers = onPeers || (() => {});
    this.connected = false;
    this.peers = { displays: 0, controllers: 0 };
    this.retry = 0;
    this.ws = null;
    this._connect();
    this._ping = setInterval(() => this._raw('{"t":"ping"}'), 15000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !this.connected) this._reconnectNow();
    });
  }

  _url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws?role=${encodeURIComponent(this.role)}`;
  }

  _connect() {
    clearTimeout(this._timer);
    let ws;
    try { ws = new WebSocket(this._url()); } catch (e) { this._schedule(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.connected = true;
      this.onStatus(true);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === 'peers') {
        this.peers = { displays: msg.displays | 0, controllers: msg.controllers | 0 };
        this.onPeers(this.peers);
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      const was = this.connected;
      this.connected = false;
      this.ws = null;
      if (was) this.onStatus(false);
      this._schedule();
    };
    ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
  }

  _schedule() {
    const delay = Math.min(5000, 300 * Math.pow(1.6, this.retry++));
    this._timer = setTimeout(() => this._connect(), delay);
  }

  _reconnectNow() {
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
    this.ws = null;
    this.retry = 0;
    this._connect();
  }

  _raw(str) {
    if (this.ws && this.ws.readyState === 1) { this.ws.send(str); return true; }
    return false;
  }

  send(msg) { return this._raw(JSON.stringify(msg)); }
}
