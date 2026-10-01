// Listens to the phone's microphone and streams music levels to the projector:
// overall level, bass / mid / treble energy and a beat counter. Levels are
// auto-normalised so it works for quiet rooms and loud parties alike.

export class MicAnalyser {
  constructor(onFrame) {
    this.onFrame = onFrame; // ({ l, b, m, h, beat }) about 30x per second
    this.sensitivity = 1;
    this.running = false;
    this.beats = 0;
    this.meter = { l: 0, b: 0, m: 0, h: 0 };
  }

  static supported() {
    return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  async start() {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.55;
    src.connect(this.analyser);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.wave = new Uint8Array(this.analyser.fftSize);
    const hz = this.ctx.sampleRate / this.analyser.fftSize;
    const bin = (f) => Math.max(1, Math.min(this.freq.length - 1, Math.round(f / hz)));
    this.bands = { b: [bin(30), bin(160)], m: [bin(160), bin(2000)], h: [bin(2000), bin(9000)] };
    this.peak = { l: 0.05, b: 0.05, m: 0.05, h: 0.05 };
    this.bassAvg = 0;
    this.lastBeat = 0;
    this.running = true;
    this.timer = setInterval(() => this._tick(), 33);
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) this.ctx.close().catch(() => {});
    this.stream = this.ctx = this.analyser = null;
    this.meter = { l: 0, b: 0, m: 0, h: 0 };
  }

  _band([a, b]) {
    let sum = 0;
    for (let i = a; i <= b; i++) sum += this.freq[i];
    return sum / ((b - a + 1) * 255);
  }

  _tick() {
    if (!this.analyser) return;
    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.wave);
    let rms = 0;
    for (const v of this.wave) { const x = (v - 128) / 128; rms += x * x; }
    rms = Math.sqrt(rms / this.wave.length);
    const raw = { l: rms, b: this._band(this.bands.b), m: this._band(this.bands.m), h: this._band(this.bands.h) };
    // Auto gain: divide by a slowly falling peak so levels use the full 0..1 range.
    const out = {};
    for (const k of Object.keys(raw)) {
      this.peak[k] = Math.max(raw[k], this.peak[k] * 0.996, k === 'l' ? 0.02 : 0.04);
      const gate = raw[k] < this.peak[k] * 0.08 ? 0 : 1; // ignore background hiss
      out[k] = Math.min(1, (raw[k] / this.peak[k]) * this.sensitivity) * gate;
    }
    // Beat: a jump in bass energy well above its recent average.
    const now = performance.now();
    if (raw.b > this.bassAvg * 1.3 + 0.03 && out.b > 0.5 && now - this.lastBeat > 200) {
      this.beats++;
      this.lastBeat = now;
    }
    this.bassAvg = this.bassAvg * 0.93 + raw.b * 0.07;
    this.meter = out;
    const r = (v) => Math.round(v * 100) / 100;
    this.onFrame({ l: r(out.l), b: r(out.b), m: r(out.m), h: r(out.h), beat: this.beats });
  }
}
