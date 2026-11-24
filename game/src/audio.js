// CAYO VERDE — synthesized sound. No audio files: every effect is built
// from WebAudio oscillators / filtered noise. The AudioContext is created
// lazily by unlock(), which main.js calls from the Start button handler
// (a user gesture); every other method no-ops until the context is running.

let ctx = null;
let master = null;
let muted = false;

// Siren: one oscillator whose frequency an interval flips between two tones.
let sirenOsc = null;
let sirenGain = null;
let sirenTimer = null;
let sirenHigh = false;

// Engine: one persistent sawtooth + lowpass whose pitch/gain track level.
let engineOsc = null;
let engineFilter = null;
let engineGain = null;

let prevMutedKey = false;

function live() {
  return ctx !== null && ctx.state === 'running' && master !== null;
}

/** Create (or resume) the AudioContext. Call from a user gesture. */
export function unlock() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.9;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    // No audio on this browser: every effect below stays a silent no-op.
  }
}

/** Short noise burst through a bandpass — a gunshot. */
export function shot() {
  if (!live()) return;
  try {
    const dur = 0.18;
    const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * dur)), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 900;
    band.Q.value = 0.8;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    src.connect(band);
    band.connect(gain);
    gain.connect(master);
    src.start(now);
    src.stop(now + dur);
  } catch {
    // Ignore: a failed effect must never break the frame.
  }
}

/** Two-tone police siren, on or off. */
export function siren(on) {
  if (on) {
    if (sirenOsc) return;
    if (!live()) return;
    try {
      sirenOsc = ctx.createOscillator();
      sirenOsc.type = 'triangle';
      sirenOsc.frequency.value = 700;
      sirenGain = ctx.createGain();
      sirenGain.gain.value = 0.08;
      sirenOsc.connect(sirenGain);
      sirenGain.connect(master);
      sirenOsc.start();
      sirenHigh = false;
      sirenTimer = setInterval(() => {
        if (!sirenOsc) return;
        sirenHigh = !sirenHigh;
        sirenOsc.frequency.setValueAtTime(sirenHigh ? 950 : 700, ctx.currentTime);
      }, 380);
    } catch {
      sirenOsc = null;
      sirenGain = null;
    }
    return;
  }
  if (sirenTimer !== null) {
    clearInterval(sirenTimer);
    sirenTimer = null;
  }
  if (sirenOsc) {
    try { sirenOsc.stop(); } catch { /* already stopped */ }
    try { sirenOsc.disconnect(); } catch { /* already gone */ }
    sirenOsc = null;
  }
  if (sirenGain) {
    try { sirenGain.disconnect(); } catch { /* already gone */ }
    sirenGain = null;
  }
}

/**
 * Engine hum. Called every frame by the vehicle code with level 0..1
 * (0 = off / parked). Pitch and loudness follow the level.
 */
export function engine(level) {
  const lvl = Math.max(0, Math.min(1, typeof level === 'number' ? level : 0));
  if (!engineOsc) {
    if (lvl <= 0.01 || !live()) return;
    try {
      engineOsc = ctx.createOscillator();
      engineOsc.type = 'sawtooth';
      engineOsc.frequency.value = 60;
      engineFilter = ctx.createBiquadFilter();
      engineFilter.type = 'lowpass';
      engineFilter.frequency.value = 300;
      engineGain = ctx.createGain();
      engineGain.gain.value = 0;
      engineOsc.connect(engineFilter);
      engineFilter.connect(engineGain);
      engineGain.connect(master);
      engineOsc.start();
    } catch {
      engineOsc = null;
      return;
    }
  }
  if (!live()) return;
  try {
    const now = ctx.currentTime;
    engineOsc.frequency.setTargetAtTime(60 + lvl * 120, now, 0.08);
    engineFilter.frequency.setTargetAtTime(300 + lvl * 900, now, 0.08);
    engineGain.gain.setTargetAtTime(lvl <= 0.01 ? 0 : 0.04 + lvl * 0.07, now, 0.08);
  } catch {
    // Ignore.
  }
}

/** Two-note chime: objective reached, mission complete, pickup. */
export function pickup() {
  if (!live()) return;
  try {
    const now = ctx.currentTime;
    [880, 1174.66].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      const start = now + i * 0.1;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
      osc.connect(gain);
      gain.connect(master);
      osc.start(start);
      osc.stop(start + 0.25);
    });
  } catch {
    // Ignore.
  }
}

/** Short UI click. */
export function ui() {
  if (!live()) return;
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 1400;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    osc.connect(gain);
    gain.connect(master);
    osc.start(now);
    osc.stop(now + 0.06);
  } catch {
    // Ignore.
  }
}

/** Master mute. The context keeps running; only the master gain drops. */
export function setMuted(b) {
  muted = !!b;
  if (ctx && master) {
    try {
      master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.02);
    } catch {
      // Ignore.
    }
  }
}

export function init(G) {
  if (!G) return;
  G.audio = { unlock, shot, siren, engine, pickup, ui, setMuted };
}

export function update(G, dt) {
  if (!G || !G.input || !G.input.keys) return;
  // M toggles mute, on the keydown edge only.
  const pressed = G.input.keys.has('KeyM');
  if (pressed && !prevMutedKey) {
    setMuted(!muted);
    if (G.hud && typeof G.hud.message === 'function') {
      G.hud.message(muted ? 'Sound off' : 'Sound on');
    }
  }
  prevMutedKey = pressed;
}
