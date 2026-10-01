// Effect packs: holiday, building illusions, trippy and sound-driven looks.
// Same conventions as effects.js: each defines `vec3 fx(vec2 uv)`.
// P(uv) is centred, aspect-correct, y pointing DOWN, roughly -1..1.

export const PACK_EFFECTS = [
  // ------------------------------------------------------------ holiday
  {
    id: 'stainedglass', heavy: true, minRes: 0.6, name: 'Stained Glass', tags: ['christmas', 'halloween', 'architecture', 'calm'],
    params: ['c1', 'c2', 'c3', 'speed', 'scale', 'amount'],
    defaults: { c1: '#c1121f', c2: '#1d4ed8', c3: '#f2b705', speed: 0.6, scale: 1, amount: 0.3 },
    labels: { amount: 'Lead width', scale: 'Pane size' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv) * 3.0 / u_scale;
      vec2 g = floor(p), f = fract(p);
      float d1 = 8.0, d2 = 8.0; vec2 id = vec2(0.0);
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec2 o = vec2(float(i), float(j));
        vec2 r = o + hash2(g + o) * 0.8 + 0.1 - f;
        float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; id = g + o; } else if (d < d2) { d2 = d; }
      }
      float e = sqrt(d2) - sqrt(d1);
      float h = hash(id + u_seed);
      vec3 base = h < 0.34 ? u_c1 : (h < 0.67 ? u_c2 : u_c3);
      base *= 0.7 + 0.45 * hash(id * 1.7 + 3.0);
      float sun = 0.75 + 0.35 * sin(u_t * 0.7 + dot(p, vec2(0.6, 0.3)) + h * 2.0);
      float lw = 0.025 + u_amount * 0.12;
      float lead = smoothstep(lw, lw + 0.03, e);
      return base * sun * lead + vec3(0.015);
    }`,
  },
  {
    id: 'fireworks', heavy: true, minRes: 0.45, name: 'Fireworks', tags: ['party', 'christmas'],
    params: ['c1', 'c2', 'c3', 'speed', 'amount'],
    defaults: { c1: '#ffd166', c2: '#02020a', c3: '#ef476f', speed: 1, amount: 0.8 },
    labels: { amount: 'Rainbow', c2: 'Sky' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv);
      vec3 col = u_c2;
      for (int k = 0; k < 5; k++) {
        float fk = float(k);
        float period = 2.2 + hash(vec2(fk, 3.0)) * 1.4;
        float tt = u_t + hash(vec2(fk, 7.0)) * period;
        float cyc = floor(tt / period);
        float lt = tt - cyc * period;
        vec2 rnd = hash2(vec2(fk * 3.1, cyc) + u_seed);
        vec2 burst = vec2((rnd.x - 0.5) * 1.5 * max(u_aspect, 1.0), -0.15 - rnd.y * 0.65);
        vec3 c = mix(mix(u_c1, u_c3, hash(vec2(cyc, fk))), hsv2rgb(vec3(hash(vec2(fk, cyc + 9.0)), 0.75, 1.0)), u_amount);
        float rise = 0.6;
        if (lt < rise) {
          vec2 rp = vec2(burst.x, mix(1.15, burst.y, lt / rise));
          col += c * 1.2 * exp(-length(p - rp) * 40.0) + c * 0.3 * exp(-abs(p.x - rp.x) * 80.0) * step(rp.y, p.y) * exp(-(p.y - rp.y) * 6.0);
        } else {
          float tb = lt - rise;
          vec2 d = p - burst;
          d.y -= tb * tb * 0.12;
          float r = length(d);
          float a = atan(d.y, d.x);
          float n = 26.0;
          float slot = floor(a / 6.2832 * n + 0.5);
          float pa = slot / n * 6.2832;
          float spd = 0.6 * (0.7 + 0.5 * hash(vec2(slot, cyc + fk)));
          float pr = spd * (1.0 - exp(-tb * 2.6));
          vec2 dir = vec2(cos(pa), sin(pa));
          float fade = exp(-tb * 1.3);
          float sd = length(d - dir * pr);
          float spark = exp(-sd * 45.0) + 0.6 * exp(-sd * 14.0) * 0.4;
          float streak = exp(-abs(dot(d, vec2(-dir.y, dir.x))) * 120.0) * smoothstep(pr * 0.3, pr, r) * step(r, pr);
          float twinkle = 0.65 + 0.35 * hash(vec2(slot, floor(u_t * 14.0)));
          col += c * (spark * 2.2 + streak * 0.9) * fade * twinkle;
          col += c * 0.35 * exp(-r * 5.0) * exp(-tb * 3.0);
        }
      }
      return col;
    }`,
  },
  {
    id: 'ghosts', heavy: true, minRes: 0.5, name: 'Ghosts', tags: ['halloween'],
    params: ['c1', 'c2', 'speed', 'scale', 'amount'],
    defaults: { c1: '#e8f4ff', c2: '#000000', speed: 1, scale: 1, amount: 0.5 },
    labels: { amount: 'How many', c2: 'Background' },
    glsl: `
    float ghostD(vec2 q, float t){
      float head = length(q) - 0.5;
      float hem = 0.78 + 0.09 * sin(q.x * 15.0 + t * 6.0);
      float body = max(abs(q.x) - 0.5 + q.y * 0.08, max(-q.y, q.y - hem));
      return q.y < 0.0 ? head : min(head, body);
    }
    vec3 fx(vec2 uv){
      vec2 p = P(uv);
      vec3 col = u_c2;
      for (int k = 0; k < 5; k++) {
        float fk = float(k);
        if (fk > 1.0 + u_amount * 4.0) break;
        float s = (0.3 + 0.12 * hash(vec2(fk, 1.0))) * u_scale;
        vec2 pos = vec2(sin(u_t * (0.2 + 0.1 * fk) + fk * 2.1) * 0.85 * max(u_aspect, 1.0),
                        cos(u_t * 0.17 + fk * 1.3) * 0.45);
        pos.y += sin(u_t * 1.5 + fk) * 0.05;
        vec2 q = (p - pos) / s;
        q.x += sin(q.y * 3.0 + u_t * 3.0) * 0.06 * max(q.y, 0.0);
        float d = ghostD(q, u_t + fk);
        float a = (0.7 + 0.3 * sin(u_t * 0.6 + fk * 1.7)) * smoothstep(0.04, -0.04, d);
        float eyes = min(length((q - vec2(-0.17, -0.08)) * vec2(1.0, 0.65)), length((q - vec2(0.17, -0.08)) * vec2(1.0, 0.65))) - 0.085;
        float mouth = length((q - vec2(0.0, 0.18)) * vec2(1.4, 1.0)) - 0.06 - 0.03 * sin(u_t * 2.0 + fk);
        float holes = smoothstep(0.02, -0.02, min(eyes, mouth));
        vec3 g = u_c1 * (0.8 + 0.2 * smoothstep(0.5, -0.5, q.y));
        col = mix(col, mix(g, vec3(0.0), holes), a * 0.92);
        col += u_c1 * 0.18 * exp(-max(d, 0.0) * 6.0) * a;
      }
      return col;
    }`,
  },
  {
    id: 'bats', heavy: true, minRes: 0.5, name: 'Bats & Moon', tags: ['halloween'],
    params: ['c1', 'c2', 'c3', 'speed', 'scale', 'amount'],
    defaults: { c1: '#ff8c1a', c2: '#000000', c3: '#2a0845', speed: 1, scale: 1, amount: 0.6 },
    labels: { c1: 'Sky glow', c2: 'Bats', c3: 'Sky', amount: 'How many' },
    glsl: `
    float batD(vec2 q, float flap){
      q.x = abs(q.x);
      float body = length(q * vec2(1.9, 1.0)) - 0.17;
      float top = mix(-0.05, -0.05 - 0.4 * flap, clamp(q.x, 0.0, 1.0));
      float bottom = 0.2 - 0.13 * abs(sin(q.x * 9.42)) - 0.35 * flap * q.x;
      float wing = max(max(top - q.y, q.y - bottom), max(0.08 - q.x, q.x - 1.0));
      float ear = max(abs(q.x - 0.08) - 0.045, max(-0.3 - q.y, q.y + 0.08));
      return min(min(body, wing * 0.6), ear);
    }
    vec3 fx(vec2 uv){
      vec2 p = P(uv);
      vec3 col = mix(u_c3, u_c1, smoothstep(-1.0, 1.2, p.y) * 0.85);
      vec2 mp = vec2(0.45 * max(u_aspect, 1.0), -0.35);
      float m = length(p - mp);
      col = mix(col, vec3(1.0, 0.97, 0.85), smoothstep(0.23, 0.21, m));
      col += vec3(1.0, 0.8, 0.5) * 0.35 * exp(-m * 5.0);
      for (int k = 0; k < 7; k++) {
        float fk = float(k);
        if (fk > 1.0 + u_amount * 6.0) break;
        float sp = 0.25 + 0.2 * hash(vec2(fk, 2.0));
        float lane = (hash(vec2(fk, 5.0)) - 0.5) * 1.4;
        float w = 2.6 * max(u_aspect, 1.0);
        float x = mod(u_t * sp + hash(vec2(fk, 9.0)) * w, w) - w * 0.5;
        vec2 pos = vec2(x, lane + sin(u_t * 2.0 + fk * 3.0) * 0.08);
        float s = (0.16 + 0.1 * hash(vec2(fk, 4.0))) * u_scale;
        float flap = 0.5 + 0.5 * sin(u_t * 14.0 + fk * 4.0);
        float d = batD((p - pos) / s, flap);
        col = mix(col, u_c2, smoothstep(0.03, -0.03, d));
      }
      return col;
    }`,
  },
  {
    id: 'pumpkin', heavy: true, minRes: 0.7, name: 'Jack-o’-Lantern', tags: ['halloween', 'sound'],
    params: ['c1', 'c2', 'speed', 'amount'],
    defaults: { c1: '#ffb020', c2: '#d9480f', speed: 1, amount: 0.6 },
    labels: { c1: 'Candle glow', c2: 'Pumpkin skin', amount: 'Chatter' },
    glsl: `
    float edgeN(vec2 p, vec2 a, vec2 b){ vec2 e = b - a; return dot(p - a, normalize(vec2(-e.y, e.x))); }
    float triD(vec2 p, vec2 a, vec2 b, vec2 c){
      float s = sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
      return min(min(edgeN(p, a, b) * s, edgeN(p, b, c) * s), edgeN(p, c, a) * s);
    }
    vec3 fx(vec2 uv){
      vec2 p = P(uv);
      p.x /= max(u_aspect, 1.0) * 0.55 + 0.45;
      float chatter = u_amount * (0.5 + 0.5 * sin(u_t * 7.0 + sin(u_t * 2.3) * 2.0));
      float open = clamp(max(u_level * 1.5, chatter), 0.0, 1.0);
      float inside = -1.0;
      inside = max(inside, triD(p, vec2(-0.55, -0.12), vec2(-0.2, -0.12), vec2(-0.38, -0.5)));
      inside = max(inside, triD(p, vec2(0.2, -0.12), vec2(0.55, -0.12), vec2(0.38, -0.5)));
      inside = max(inside, triD(p, vec2(-0.08, 0.08), vec2(0.08, 0.08), vec2(0.0, -0.06)));
      float s = p.x / 0.7;
      float top = 0.18 + 0.22 * (1.0 - s * s) - 0.12;
      float bot = top + (0.06 + 0.3 * open) * (1.0 - s * s) + 0.02;
      // Grin (positive inside), minus two teeth hanging down and one standing up.
      float mouth = min(min(p.y - top, bot - p.y), (1.0 - abs(s)) * 0.7);
      float toothUp = min(0.06 - abs(abs(p.x) - 0.24), top + 0.08 - p.y);
      float toothDown = min(0.06 - abs(p.x), p.y - (bot - 0.07));
      mouth = min(mouth, -max(toothUp, toothDown));
      inside = max(inside, mouth);
      float flick = 0.8 + 0.2 * noise(vec2(u_t * 9.0, 1.0)) + 0.25 * u_beat;
      vec3 glow = mix(u_c1, vec3(1.0, 0.95, 0.7), 0.35) * flick;
      float ribs = 0.75 + 0.25 * cos(p.x * 9.0);
      vec3 skin = u_c2 * ribs * (0.55 + 0.25 * flick * exp(-length(p) * 1.2));
      vec3 col = mix(skin, glow, smoothstep(-0.012, 0.012, inside));
      col += u_c1 * 0.25 * exp(-abs(min(inside, 0.0)) * 30.0) * flick;
      return col;
    }`,
  },
  {
    id: 'leaves', heavy: true, minRes: 0.5, name: 'Falling Leaves', tags: ['calm', 'halloween'],
    params: ['c1', 'c2', 'c3', 'speed', 'scale', 'amount'],
    defaults: { c1: '#d9480f', c2: '#f59f00', c3: '#7a1f12', speed: 1, scale: 1, amount: 0.5 },
    labels: { amount: 'Density' },
    glsl: `vec3 fx(vec2 uv){
      vec3 col = vec3(0.0);
      for (int l = 0; l < 2; l++) {
        float fl = float(l);
        vec2 p = P(uv) * (3.0 + fl * 2.0) * u_scale;
        p.y -= u_t * (0.35 + fl * 0.2);
        p.x += sin(u_t * 0.6 + p.y * 0.7 + fl) * 0.35;
        vec2 cell = floor(p); vec2 f = fract(p) - 0.5;
        float r = hash(cell + fl * 11.0);
        if (r > u_amount) continue;
        vec2 off = (hash2(cell + fl * 3.0) - 0.5) * 0.4;
        float ang = u_t * (1.0 + r * 2.0) + r * 6.28;
        vec2 q = rot(ang) * (f - off);
        q.x *= 0.55 + 0.45 * abs(cos(u_t * 1.7 + r * 9.0));
        float leaf = length(q * vec2(1.0, 1.9)) - 0.26 + 0.12 * abs(q.y);
        float vein = smoothstep(0.012, 0.0, abs(q.x)) * step(abs(q.y), 0.25);
        vec3 c = r < u_amount * 0.33 ? u_c1 : (r < u_amount * 0.66 ? u_c2 : u_c3);
        float m = smoothstep(0.02, -0.02, leaf);
        col = mix(col, c * (0.75 + 0.35 * q.y) * (1.0 - vein * 0.4), m);
      }
      return col;
    }`,
  },
  {
    id: 'confetti', heavy: true, minRes: 0.5, name: 'Confetti', tags: ['party'],
    params: ['c1', 'c2', 'c3', 'speed', 'scale', 'amount'],
    defaults: { c1: '#ff006e', c2: '#3a86ff', c3: '#ffbe0b', speed: 1, scale: 1, amount: 0.7 },
    labels: { amount: 'Density' },
    glsl: `vec3 fx(vec2 uv){
      vec3 col = vec3(0.0);
      for (int l = 0; l < 3; l++) {
        float fl = float(l);
        vec2 p = P(uv) * (5.0 + fl * 3.0) * u_scale;
        p.y -= u_t * (0.9 + fl * 0.4);
        p.x += sin(u_t + p.y * 0.9 + fl * 2.0) * 0.3;
        vec2 cell = floor(p); vec2 f = fract(p) - 0.5;
        float r = hash(cell + fl * 7.0);
        if (r > u_amount) continue;
        vec2 off = (hash2(cell + fl) - 0.5) * 0.5;
        vec2 q = rot(r * 6.28 + u_t * (2.0 + r * 3.0)) * (f - off);
        float flip = abs(cos(u_t * (3.0 + r * 4.0) + r * 20.0));
        vec2 sz = vec2(0.13, 0.07 * flip + 0.01);
        vec2 d = abs(q) - sz;
        float m = smoothstep(0.015, -0.015, max(d.x, d.y));
        float k = hash(cell * 1.3 + fl);
        vec3 c = k < 0.33 ? u_c1 : (k < 0.66 ? u_c2 : u_c3);
        c = mix(c, hsv2rgb(vec3(k * 3.0, 0.8, 1.0)), step(0.8, hash(cell + 2.0)));
        col = mix(col, c * (0.6 + 0.4 * flip), m);
      }
      return col;
    }`,
  },

  // ------------------------------------------------------------ building illusions
  {
    id: 'neongrid', name: 'Neon Grid', tags: ['architecture', 'party'],
    params: ['c1', 'c2', 'c3', 'speed', 'scale', 'amount'],
    defaults: { c1: '#00e5ff', c2: '#000000', c3: '#ff00c8', speed: 1, scale: 1, amount: 0.3 },
    labels: { c3: 'Pulse colour', amount: 'Line width' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv) * 4.0 * u_scale;
      vec2 g = abs(fract(p) - 0.5);
      float w = 0.01 + u_amount * 0.05;
      float lx = exp(-g.x / w * 0.9), ly = exp(-g.y / w * 0.9);
      float line = max(lx, ly);
      float px = fract(p.y * 0.25 - u_t * 0.4 + hash(vec2(floor(p.x + 0.5), 1.0)));
      float py = fract(p.x * 0.25 - u_t * 0.5 + hash(vec2(floor(p.y + 0.5), 2.0)));
      float pulse = lx * smoothstep(0.85, 1.0, px) + ly * smoothstep(0.85, 1.0, py);
      float node = exp(-length(g - 0.5) / (w * 2.0));
      vec3 col = u_c2 + u_c1 * line * 0.8 + u_c3 * pulse * 1.5 + u_c1 * node * 0.6;
      return col;
    }`,
  },
  {
    id: 'network', heavy: true, minRes: 0.3, name: 'Wireframe Web', tags: ['architecture', 'calm'],
    params: ['c1', 'c2', 'speed', 'scale', 'amount'],
    defaults: { c1: '#c0d8ff', c2: '#000000', speed: 0.6, scale: 1, amount: 0.4 },
    labels: { amount: 'Glow' },
    glsl: `
    vec2 nodeAt(vec2 g){ return g + 0.5 + 0.4 * sin(hash2(g) * 6.28 + u_t * (0.5 + hash(g))); }
    float segD(vec2 pa, vec2 e, out float h){ h = clamp(dot(pa, e) / dot(e, e), 0.0, 1.0); return length(pa - e * h); }
    vec3 fx(vec2 uv){
      vec2 p = P(uv) * 3.0 * u_scale;
      vec2 g = floor(p);
      // Each of the nearby nodes is computed once, then joined right / down.
      vec2 n[16];
      for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) n[j * 4 + i] = nodeAt(g + vec2(float(i - 1), float(j - 1)));
      float d = 9.0, dn = 9.0, flow = 0.0, h;
      for (int j = 0; j < 3; j++) for (int i = 0; i < 3; i++) {
        vec2 a = n[j * 4 + i];
        vec2 pa = p - a;
        dn = min(dn, length(pa));
        float s1 = segD(pa, n[j * 4 + i + 1] - a, h);
        float k = hash(g + vec2(float(i), float(j)));
        flow += exp(-s1 * 60.0) * smoothstep(0.9, 1.0, fract(h - u_t * 0.5 + k));
        float s2 = segD(pa, n[j * 4 + i + 4] - a, h);
        flow += exp(-s2 * 60.0) * smoothstep(0.9, 1.0, fract(h - u_t * 0.4 + k * 2.0));
        d = min(d, min(s1, s2));
      }
      float glow = 0.004 + u_amount * 0.02;
      float line = exp(-d / glow * 0.5);
      return u_c2 + u_c1 * (line * 0.7 + exp(-dn * 25.0) * 0.9 + flow * 1.2);
    }`,
  },
  {
    id: 'bricks', heavy: true, minRes: 0.6, name: 'Crumbling Bricks', tags: ['architecture', 'halloween'],
    params: ['c1', 'c2', 'c3', 'speed', 'scale', 'amount'],
    defaults: { c1: '#a23b2a', c2: '#d8cfc4', c3: '#050505', speed: 1, scale: 1, amount: 0.6 },
    labels: { c1: 'Brick', c2: 'Mortar', c3: 'Behind the wall', amount: 'How much falls' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv) * vec2(3.0, 6.0) * u_scale;
      float cyc = u_t * 0.08;
      float phase = fract(cyc);
      float frac = u_amount * smoothstep(0.1, 0.45, phase) * (1.0 - smoothstep(0.6, 0.95, phase));
      vec3 col = u_c3 + 0.03 * vec3(hash(floor(p * 4.0)));
      // A pixel may be covered by its own brick or by a brick falling from above.
      for (int k = 0; k < 4; k++) {
        float row = floor(p.y) - float(k);
        float shift = mod(row, 2.0) * 0.5;
        float bx = floor(p.x - shift);
        vec2 id = vec2(bx, row);
        float h = hash(id + u_seed + floor(cyc));
        float fall = 0.0;
        if (h < frac) {
          float start = h / max(frac, 0.001);
          float tf = max(0.0, (phase - 0.1) * 3.0 - start * 0.8);
          fall = tf * tf * 2.5;
        }
        if (k > 0 && fall < float(k) - 1.0) continue;
        vec2 q = vec2(p.x - shift - bx, p.y - row - fall);
        if (q.y < 0.0 || q.y > 1.0) continue;
        vec2 e = min(q, 1.0 - q) * vec2(3.0, 1.0);
        float mortar = smoothstep(0.035, 0.07, min(e.x, e.y));
        float bevel = smoothstep(0.0, 0.25, min(e.x, e.y));
        vec3 brick = u_c1 * (0.75 + 0.4 * hash(id * 2.3)) * (0.85 + 0.15 * noise(q * 8.0 + id));
        brick *= 0.7 + 0.3 * bevel + 0.15 * (1.0 - q.y);
        vec3 c = mix(u_c2 * 0.8, brick, mortar);
        if (fall > 0.0) c *= max(0.25, 1.0 - fall * 0.15);
        col = c;
        break;
      }
      return col;
    }`,
  },
  {
    id: 'searchlights', heavy: true, name: 'Searchlights', tags: ['architecture', 'party'],
    params: ['c1', 'c2', 'speed', 'amount'],
    defaults: { c1: '#fff3c4', c2: '#05060f', speed: 1, amount: 0.35 },
    labels: { amount: 'Beam width' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = vec2((uv.x - 0.5) * u_aspect, uv.y);
      vec3 col = u_c2 * (0.8 + 0.4 * noise(p * 3.0 + u_t * 0.1));
      for (int k = 0; k < 3; k++) {
        float fk = float(k);
        vec2 o = vec2((fk - 1.0) * 0.6 * u_aspect * 0.6, 1.15);
        float ang = -1.5708 + sin(u_t * (0.5 + 0.13 * fk) + fk * 2.0) * 0.7;
        vec2 d = p - o;
        float a = atan(d.y, d.x);
        float diff = abs(mod(a - ang + 3.1416, 6.2832) - 3.1416);
        float w = 0.03 + u_amount * 0.15;
        float beam = exp(-diff * diff / (w * w)) * exp(-length(d) * 0.35);
        col += u_c1 * beam * 0.8;
      }
      return col;
    }`,
  },
  {
    id: 'waterfall', heavy: true, name: 'Waterfall', tags: ['architecture', 'calm'],
    params: ['c1', 'c2', 'speed', 'scale'],
    defaults: { c1: '#0b3d91', c2: '#dff6ff', speed: 1, scale: 1 },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv) * u_scale;
      float n = fbm(vec2(p.x * 7.0, p.y * 1.2 - u_t * 2.2));
      float n2 = noise(vec2(p.x * 22.0, p.y * 3.0 - u_t * 4.0));
      float streak = smoothstep(0.45, 0.85, n * 0.8 + n2 * 0.35);
      float foam = smoothstep(0.75, 1.0, uv.y) * (0.6 + 0.4 * noise(vec2(p.x * 10.0, u_t * 3.0)));
      return mix(u_c1, u_c2, clamp(streak * 0.8 + foam, 0.0, 1.0));
    }`,
  },
  {
    id: 'bevel', name: '3D Carved Panel', tags: ['architecture'],
    params: ['c1', 'c2', 'c3', 'speed', 'amount'],
    defaults: { c1: '#8c8c99', c2: '#ffffff', c3: '#14141c', speed: 0.4, amount: 0.35 },
    labels: { c1: 'Face', c2: 'Light', c3: 'Shadow', amount: 'Bevel depth' },
    glsl: `vec3 fx(vec2 uv){
      // Distance to each side in shape-height units: left, right, top, bottom.
      vec4 e = vec4(uv.x * u_aspect, (1.0 - uv.x) * u_aspect, uv.y, 1.0 - uv.y);
      float m = min(min(e.x, e.y), min(e.z, e.w));
      float w = 0.04 + u_amount * 0.3;
      vec2 n = e.x == m ? vec2(-1.0, 0.0) : (e.y == m ? vec2(1.0, 0.0) : (e.z == m ? vec2(0.0, -1.0) : vec2(0.0, 1.0)));
      float a = u_t * 0.8 + 2.4;
      vec2 L = vec2(cos(a), sin(a));
      float lit = dot(n, -L) * 0.5 + 0.5;
      vec3 face = u_c1 * (0.75 + 0.1 * noise(uv * 30.0));
      vec3 slope = mix(u_c3, u_c2, lit);
      float inner = smoothstep(w, w + 0.01, m);
      vec3 col = mix(slope, face, inner);
      col *= 0.85 + 0.15 * smoothstep(0.0, 0.02, m);
      return col;
    }`,
  },
  {
    id: 'cozywindow', heavy: true, minRes: 0.4, name: 'Cozy Window', tags: ['architecture', 'calm', 'christmas'],
    params: ['c1', 'c2', 'speed', 'amount'],
    defaults: { c1: '#ffb347', c2: '#4a90ff', speed: 1, amount: 0.3 },
    labels: { c1: 'Lamp light', c2: 'TV glow', amount: 'TV on' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv);
      float lamp = 0.85 + 0.15 * noise(vec2(u_t * 0.7, u_seed * 10.0));
      vec3 col = u_c1 * lamp * (0.55 + 0.45 * exp(-length(p - vec2(-0.3, 0.2)) * 1.3));
      float tv = step(1.0 - u_amount, noise(vec2(u_t * 0.05, u_seed * 7.0)));
      float flick = 0.5 + 0.5 * hash(vec2(floor(u_t * 6.0), u_seed));
      col = mix(col, u_c2 * (0.4 + 0.6 * flick), tv * 0.55 * exp(-length(p - vec2(0.4, 0.1)) * 0.8));
      col *= 0.8 + 0.2 * smoothstep(1.2, 0.2, length(p));
      return col;
    }`,
  },

  // ------------------------------------------------------------ trippy
  {
    id: 'kaleidoscope', heavy: true, name: 'Kaleidoscope', tags: ['trippy', 'party'],
    params: ['c1', 'c2', 'c3', 'speed', 'scale', 'amount'],
    defaults: { c1: '#ff006e', c2: '#8338ec', c3: '#ffbe0b', speed: 0.7, scale: 1, amount: 0.4 },
    labels: { amount: 'Mirrors' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv);
      float r = length(p);
      float a = atan(p.y, p.x) + u_t * 0.15;
      float n = 3.0 + floor(u_amount * 9.0);
      float seg = 6.2832 / n;
      a = mod(a, seg);
      a = abs(a - seg * 0.5);
      vec2 q = vec2(cos(a), sin(a)) * r * 2.5 * u_scale;
      q += vec2(sin(u_t * 0.3), cos(u_t * 0.2)) * 0.6;
      float v = sin(q.x * 3.0 + u_t) + sin(q.y * 4.0 - u_t * 0.8) + sin((q.x + q.y) * 2.5 + u_t * 0.6) + sin(length(q) * 5.0 - u_t * 1.3);
      vec3 col = ramp3loop(fract(v * 0.18 + r * 0.3 - u_t * 0.05));
      return col * (0.6 + 0.4 * smoothstep(1.6, 0.0, r));
    }`,
  },
  {
    id: 'tunnel', heavy: true, name: 'Tunnel', tags: ['trippy', 'party'],
    params: ['c1', 'c2', 'speed', 'scale', 'amount'],
    defaults: { c1: '#00e5ff', c2: '#7c3aed', speed: 1, scale: 1, amount: 0.5 },
    labels: { amount: 'Twist' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv);
      float r = max(length(p), 0.02);
      float a = atan(p.y, p.x);
      float z = 0.35 / r + u_t * 0.8;
      float ang = a / 3.1416 * 4.0 * u_scale + z * u_amount * 0.6;
      float check = mod(floor(z * 2.0 * u_scale) + floor(ang), 2.0);
      float ring = smoothstep(0.92, 1.0, fract(z * 2.0 * u_scale)) + smoothstep(0.08, 0.0, fract(z * 2.0 * u_scale));
      vec3 col = mix(u_c2, u_c1, check) * (0.4 + 0.6 * check) + u_c1 * ring * 0.5;
      return col * smoothstep(0.0, 0.6, r);
    }`,
  },
  {
    id: 'morph', heavy: true, name: 'Colour Morph', tags: ['trippy', 'calm'],
    params: ['speed', 'scale', 'amount'],
    defaults: { speed: 0.6, scale: 1, amount: 0.9 },
    labels: { amount: 'Saturation' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv) * 1.5 * u_scale;
      vec2 w = vec2(fbm(p + u_t * 0.1), fbm(p + vec2(5.2, 1.3) - u_t * 0.08));
      float h = fbm(p + w * 2.0 + u_t * 0.05);
      return hsv2rgb(vec3(fract(h * 1.5 + u_t * 0.03), u_amount, 0.9 + 0.1 * w.x));
    }`,
  },
  {
    id: 'liquid', heavy: true, name: 'Liquid Marble', tags: ['trippy', 'calm'],
    params: ['c1', 'c2', 'c3', 'speed', 'scale', 'amount'],
    defaults: { c1: '#0f172a', c2: '#e2e8f0', c3: '#d4af37', speed: 0.5, scale: 1, amount: 0.6 },
    labels: { amount: 'Distortion' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv) * 2.0 * u_scale;
      vec2 q = vec2(fbm(p + vec2(0.0, u_t * 0.1)), fbm(p + vec2(3.1, -u_t * 0.12)));
      float v = sin((p.x + p.y) * 3.0 + q.x * 8.0 * u_amount + u_t * 0.3);
      float vein = smoothstep(0.9, 1.0, abs(v));
      vec3 col = mix(u_c1, u_c2, 0.5 + 0.5 * v);
      return mix(col, u_c3, vein * 0.8);
    }`,
  },
  {
    id: 'aurora', heavy: true, name: 'Northern Lights', tags: ['trippy', 'calm', 'christmas'],
    params: ['c1', 'c2', 'c3', 'speed', 'scale'],
    defaults: { c1: '#39ff88', c2: '#8a2be2', c3: '#020617', speed: 0.6, scale: 1 },
    labels: { c3: 'Night sky' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv) * u_scale;
      vec3 col = u_c3;
      float stars = step(0.996, hash(floor(uv * vec2(400.0, 300.0)))) * (0.5 + 0.5 * sin(u_t * 3.0 + hash(floor(uv * 400.0)) * 20.0));
      col += vec3(stars);
      for (int k = 0; k < 3; k++) {
        float fk = float(k);
        float x = p.x * (1.0 + fk * 0.3) + fk * 2.0;
        float curtain = fbm(vec2(x * 1.2 + u_t * 0.15, u_t * 0.1 + fk));
        float y0 = -0.3 + fk * 0.15 + (curtain - 0.5) * 0.6;
        float d = p.y - y0;
        float band = exp(-max(d, 0.0) * 3.5) * smoothstep(-0.05, 0.05, d) * (0.6 + 0.6 * noise(vec2(x * 8.0, u_t * 0.5)));
        col += mix(u_c1, u_c2, clamp(fk * 0.5 + d * 0.8, 0.0, 1.0)) * band * 0.5;
      }
      return col;
    }`,
  },
  {
    id: 'starfield', heavy: true, minRes: 0.6, name: 'Warp Speed', tags: ['trippy', 'party'],
    params: ['c1', 'c2', 'speed', 'scale'],
    defaults: { c1: '#ffffff', c2: '#000008', speed: 1, scale: 1 },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv);
      vec3 col = u_c2;
      for (int l = 0; l < 4; l++) {
        float fl = float(l);
        float depth = fract(u_t * 0.25 + fl * 0.25);
        float zoom = mix(12.0, 0.6, depth) * u_scale;
        vec2 q = p * zoom + fl * 13.0;
        vec2 cell = floor(q); vec2 f = fract(q) - 0.5;
        vec2 off = (hash2(cell + fl) - 0.5) * 0.7;
        float d = length(f - off);
        float fade = smoothstep(0.0, 0.3, depth) * smoothstep(1.0, 0.85, depth);
        col += u_c1 * exp(-d * (40.0 - depth * 25.0)) * fade * step(0.4, hash(cell + 3.0 + fl));
      }
      return col;
    }`,
  },
  {
    id: 'fireflies', heavy: true, minRes: 0.5, name: 'Fireflies', tags: ['calm', 'nature'],
    params: ['c1', 'c2', 'speed', 'scale', 'amount'],
    defaults: { c1: '#d4ff4f', c2: '#020a04', speed: 0.8, scale: 1, amount: 0.6 },
    labels: { amount: 'How many' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv) * 4.0 * u_scale;
      vec3 col = u_c2;
      vec2 g = floor(p);
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec2 c = g + vec2(float(i), float(j));
        float r = hash(c + u_seed);
        if (r > u_amount) continue;
        vec2 pos = c + 0.5 + 0.45 * vec2(sin(u_t * (0.3 + r) + r * 20.0), cos(u_t * (0.25 + r * 0.7) + r * 13.0));
        float blink = pow(max(0.0, sin(u_t * (0.8 + r) + r * 40.0)), 4.0);
        float d = length(p - pos);
        col += u_c1 * (exp(-d * 18.0) * 1.2 + exp(-d * 4.0) * 0.25) * blink;
      }
      return col;
    }`,
  },
  {
    id: 'pixelwave', name: 'Pixel Mosaic', tags: ['trippy', 'architecture', 'party'],
    params: ['c1', 'c2', 'c3', 'speed', 'scale'],
    defaults: { c1: '#ff006e', c2: '#3a86ff', c3: '#06d6a0', speed: 1, scale: 1 },
    labels: { scale: 'Pixel size' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv) * 8.0 / u_scale;
      vec2 cell = floor(p); vec2 f = fract(p) - 0.5;
      float wave = sin(cell.x * 0.45 + cell.y * 0.3 - u_t * 2.0) * 0.5 + 0.5;
      float s = 0.12 + 0.36 * wave;
      vec2 d = abs(f) - s;
      float m = smoothstep(0.03, -0.03, max(d.x, d.y));
      vec3 c = ramp3loop(fract(noise(cell * 0.15 + u_t * 0.1) * 1.5 + wave * 0.2));
      return c * m;
    }`,
  },
  {
    id: 'rainwindow', heavy: true, minRes: 0.6, name: 'Rain on Glass', tags: ['calm', 'nature'],
    params: ['c1', 'c2', 'c3', 'speed', 'scale', 'amount'],
    defaults: { c1: '#ffb347', c2: '#1b2a49', c3: '#ff5e7e', speed: 1, scale: 1, amount: 0.6 },
    labels: { c1: 'City lights', c2: 'Night', c3: 'Neon', amount: 'Rain' },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv);
      // Blurry city lights behind the glass.
      vec3 col = u_c2 * (0.6 + 0.4 * uv.y);
      vec2 bq = p * 3.0;
      vec2 bc = floor(bq);
      for (int j = 0; j <= 1; j++) for (int i = 0; i <= 1; i++) {
        vec2 c = bc + vec2(float(i), float(j));
        vec2 bp = c + hash2(c);
        float k = hash(c * 1.7);
        col += mix(u_c1, u_c3, step(0.6, k)) * 0.35 * exp(-length(bq - bp) * 3.5) * (0.6 + 0.4 * sin(u_t + k * 10.0));
      }
      // Drops sliding down with trails.
      vec2 q = p * vec2(6.0, 3.0) * u_scale;
      float col_id = floor(q.x);
      float r = hash(vec2(col_id, 1.0));
      if (r < u_amount) {
        float y = fract(q.y * 0.3 - u_t * (0.15 + r * 0.25) + r * 9.0);
        float x = fract(q.x) - 0.5 + sin(q.y * 2.0 + r * 9.0) * 0.08;
        float dd = length(vec2(x * 1.4, (y - 0.8) * 2.6));
        float drop = smoothstep(0.17, 0.12, dd);
        float rim = smoothstep(0.17, 0.13, dd) - smoothstep(0.13, 0.08, dd);
        float trail = exp(-abs(x) * 35.0) * smoothstep(0.8, 0.05, y) * step(y, 0.8);
        col = mix(col, col * 0.4 + vec3(0.55, 0.65, 0.8) * (0.6 - (y - 0.8) * 2.0), drop * 0.85);
        col += vec3(0.9, 0.95, 1.0) * (rim * 0.7 + trail * 0.18);
      }
      float specks = step(0.985, hash(floor(p * 70.0))) * 0.35;
      return col + specks;
    }`,
  },

  // ------------------------------------------------------------ sound
  {
    id: 'equalizer', name: 'Equalizer', tags: ['sound', 'party'],
    params: ['c1', 'c2', 'c3', 'scale', 'amount'],
    defaults: { c1: '#00f5d4', c2: '#000000', c3: '#f15bb5', scale: 1, amount: 0.5 },
    labels: { scale: 'Bars', amount: 'Gap' },
    glsl: `vec3 fx(vec2 uv){
      float n = floor(8.0 + 16.0 * u_scale);
      float i = floor(uv.x * n);
      float fx01 = i / (n - 1.0);
      float idle = 0.25 + 0.2 * sin(u_t * 3.0 + i * 0.6) * sin(u_t * 1.3 + i);
      float band = fx01 < 0.33 ? u_bass : (fx01 < 0.66 ? u_mid : u_high);
      float jitter = 0.75 + 0.25 * noise(vec2(i * 1.7, u_t * 6.0));
      float hgt = clamp(max(band * jitter * 1.1, u_level > 0.0 ? 0.03 : idle), 0.0, 1.0);
      float gap = 0.06 + u_amount * 0.4;
      float inBar = step(gap * 0.5, fract(uv.x * n)) * step(fract(uv.x * n), 1.0 - gap * 0.5);
      float y = 1.0 - uv.y;
      float lit = step(y, hgt) * inBar;
      float seg = step(0.2, fract(y * 18.0));
      vec3 c = mix(u_c1, u_c3, y);
      return mix(u_c2, c * (1.0 + u_beat * 0.6), lit * seg);
    }`,
  },
  {
    id: 'bassrings', name: 'Bass Rings', tags: ['sound', 'party'],
    params: ['c1', 'c2', 'c3', 'speed', 'scale'],
    defaults: { c1: '#ff006e', c2: '#000000', c3: '#3a86ff', speed: 1, scale: 1 },
    glsl: `vec3 fx(vec2 uv){
      vec2 p = P(uv);
      float r = length(p);
      float energy = max(u_bass, 0.15 + 0.1 * sin(u_t * 2.0));
      float rings = sin(r * 18.0 * u_scale - u_t * 5.0 - u_bass * 4.0);
      float ring = smoothstep(0.7, 1.0, rings) * smoothstep(1.4, 0.2, r);
      float core = exp(-r * (6.0 - 4.0 * energy)) * (0.5 + energy);
      float flash = u_beat * exp(-abs(r - 0.4 - (1.0 - u_beat) * 0.8) * 10.0);
      return u_c2 + mix(u_c3, u_c1, smoothstep(0.0, 1.0, r)) * ring * (0.4 + energy) + u_c1 * core + u_c3 * flash;
    }`,
  },
];
