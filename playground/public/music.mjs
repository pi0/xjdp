// Tiny self-contained XM-style tracker player using modern Web Audio APIs.
// No external scripts, no WASM, no CDN.

const SONG = {
  bpm: 125,
  speed: 6,
  loop: true,
  channels: 4,
  order: [0, 1, 0, 2],
  patterns: [
    [
      ["C5", null, "G4", null],
      [null, null, null, null],
      ["E5", null, "A4", null],
      [null, null, null, null],
      ["G5", null, "B4", null],
      [null, null, null, null],
      ["E5", null, "A4", "E3"],
      [null, null, null, null],
      ["C5", null, "G4", null],
      [null, null, null, null],
      ["E5", null, "A4", null],
      [null, null, null, null],
      ["A5", "E6", "C5", "F3"],
      [null, null, null, null],
      ["G5", null, "B4", null],
      [null, null, null, null],
    ],
    [
      ["F5", null, "A4", "D3"],
      [null, null, null, null],
      ["E5", null, "G4", null],
      [null, null, null, null],
      ["D5", null, "F4", null],
      [null, null, null, null],
      ["C5", "G5", "E4", "C3"],
      [null, null, null, null],
      ["A4", null, "F4", "A2"],
      [null, null, null, null],
      ["B4", null, "G4", null],
      [null, null, null, null],
      ["C5", "G5", "E4", "G2"],
      [null, null, null, null],
      ["D5", null, "F4", null],
      [null, null, null, null],
    ],
    [
      ["C5", "G5", "E4", "C3"],
      [null, null, null, null],
      ["E5", "C6", "G4", null],
      [null, null, null, null],
      ["G5", "E6", "B4", null],
      [null, null, null, null],
      ["A5", "F6", "C5", "A2"],
      [null, null, null, null],
      ["G5", "E6", "B4", "G2"],
      [null, null, null, null],
      ["E5", "C6", "A4", null],
      [null, null, null, null],
      ["D5", "B5", "G4", "F2"],
      [null, null, null, null],
      ["C5", "G5", "E4", "C2"],
      [null, null, null, null],
    ],
  ],
};

const CHANNELS = [
  { type: "lead", wave: "square", gain: 0.12, attack: 0.002, release: 0.08, stereo: -0.5 },
  { type: "arp", wave: "triangle", gain: 0.05, attack: 0.002, release: 0.04, stereo: 0.5 },
  { type: "pad", wave: "sawtooth", gain: 0.045, attack: 0.01, release: 0.12, stereo: 0.15 },
  { type: "bass", wave: "triangle", gain: 0.1, attack: 0.002, release: 0.08, stereo: 0 },
];

let ctx;
let master;
let limiter;
let noiseBuffer;
let playing = false;
let timer = null;
let nextNoteTime = 0;
let currentOrder = 0;
let currentRow = 0;
let onStop;

function noteToFreq(note) {
  if (!note) return 0;
  const m = /^([A-G])(#?)(-?\d+)$/.exec(note);
  if (!m) throw new Error(`Invalid note: ${note}`);
  const [, n, sharp, octaveStr] = m;
  const semis = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[n] + (sharp ? 1 : 0);
  const midi = (Number(octaveStr) + 1) * 12 + semis;
  return 440 * 2 ** ((midi - 69) / 12);
}

function tickDuration() {
  return 2.5 / SONG.bpm;
}

function rowDuration() {
  return tickDuration() * SONG.speed;
}

function ensureAudio() {
  if (ctx) return;

  ctx = new AudioContext({ latencyHint: "interactive" });

  master = new GainNode(ctx, { gain: 0.7 });
  const hp = new BiquadFilterNode(ctx, { type: "highpass", frequency: 30, Q: 0.7 });
  const lp = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 9000, Q: 0.2 });
  limiter = new DynamicsCompressorNode(ctx, {
    threshold: -18,
    knee: 6,
    ratio: 8,
    attack: 0.003,
    release: 0.15,
  });

  master.connect(hp).connect(lp).connect(limiter).connect(ctx.destination);

  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = noise;
}

function accentForRow(row) {
  if (row % 8 === 0) return 1;
  if (row % 4 === 0) return 0.88;
  if (row % 2 === 0) return 0.76;
  return 0.68;
}

function scheduleNoiseBurst(time, volume = 0.018) {
  const src = new AudioBufferSourceNode(ctx, { buffer: noiseBuffer });
  const filter = new BiquadFilterNode(ctx, { type: "bandpass", frequency: 7000, Q: 0.8 });
  const gain = new GainNode(ctx, { gain: 0.0001 });
  src.connect(filter).connect(gain).connect(master);
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(volume, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  src.start(time);
  src.stop(time + 0.06);
}

function scheduleKick(time, rootFreq, volume = 0.12) {
  const osc = new OscillatorNode(ctx, { type: "sine", frequency: rootFreq * 1.5 });
  const gain = new GainNode(ctx, { gain: 0.0001 });
  osc.connect(gain).connect(master);
  osc.frequency.setValueAtTime(rootFreq * 1.8, time);
  osc.frequency.exponentialRampToValueAtTime(Math.max(42, rootFreq * 0.55), time + 0.08);
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(volume, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.11);
  osc.start(time);
  osc.stop(time + 0.12);
}

function scheduleVoice(channelIndex, note, time, duration, velocity = 1) {
  if (!note) return;
  const cfg = CHANNELS[channelIndex];
  const freq = noteToFreq(note);
  const gainValue = cfg.gain * velocity;
  const pan = new StereoPannerNode(ctx, { pan: cfg.stereo });
  const gain = new GainNode(ctx, { gain: 0.0001 });
  let source;

  if (cfg.type === "lead" || cfg.type === "pad" || cfg.type === "bass") {
    source = new OscillatorNode(ctx, { type: cfg.wave, frequency: freq });

    if (cfg.type === "lead") {
      const vibrato = new OscillatorNode(ctx, { type: "sine", frequency: 5.2 });
      const vibratoGain = new GainNode(ctx, { gain: 4.5 });
      vibrato.connect(vibratoGain).connect(source.frequency);
      vibrato.start(time);
      vibrato.stop(time + duration + 0.2);
    }

    if (cfg.type === "pad") {
      const filter = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 2400, Q: 2.5 });
      source.connect(filter).connect(gain).connect(pan).connect(master);
    } else {
      source.connect(gain).connect(pan).connect(master);
    }
  } else {
    const oscA = new OscillatorNode(ctx, { type: "triangle", frequency: freq });
    const oscB = new OscillatorNode(ctx, { type: "triangle", frequency: freq * 1.26 });
    const mix = new GainNode(ctx, { gain: 0.5 });
    oscA.connect(mix);
    oscB.connect(mix);
    mix.connect(gain).connect(pan).connect(master);
    oscA.start(time);
    oscB.start(time);
    oscA.stop(time + duration + 0.05);
    oscB.stop(time + duration + 0.05);
    source = null;
  }

  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(gainValue, time + cfg.attack);
  gain.gain.setTargetAtTime(gainValue * 0.82, time + cfg.attack, Math.max(0.02, duration * 0.2));
  gain.gain.setTargetAtTime(0.0001, time + Math.max(cfg.attack, duration - cfg.release), cfg.release / 3);

  if (source) {
    source.start(time);
    source.stop(time + duration + 0.05);
  }
}

function scheduleRow(time) {
  const patternIndex = SONG.order[currentOrder];
  const pattern = SONG.patterns[patternIndex];
  const row = pattern[currentRow];
  const dur = rowDuration() * 0.98;
  const accent = accentForRow(currentRow);

  row.forEach((note, i) => {
    if (!note) return;
    scheduleVoice(i, note, time, dur, accent);
  });

  if (currentRow % 4 === 0) scheduleNoiseBurst(time, 0.014 * accent);
  if (row[3]) scheduleKick(time, noteToFreq(row[3]), 0.11 * accent);

  currentRow += 1;
  if (currentRow >= pattern.length) {
    currentRow = 0;
    currentOrder += 1;
    if (currentOrder >= SONG.order.length) {
      if (SONG.loop) currentOrder = 0;
      else stopPlayback();
    }
  }
}

function scheduler() {
  const lookAhead = 0.12;
  while (playing && nextNoteTime < ctx.currentTime + lookAhead) {
    scheduleRow(nextNoteTime);
    nextNoteTime += rowDuration();
  }
}

function resetSong() {
  currentOrder = 0;
  currentRow = 0;
  nextNoteTime = ctx.currentTime + 0.02;
}

function stopPlayback(fireCallback = true) {
  playing = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (master) {
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setTargetAtTime(0.0001, now, 0.03);
    setTimeout(() => {
      if (master) master.gain.setValueAtTime(0.7, ctx.currentTime);
    }, 120);
  }
  if (fireCallback) onStop?.();
  onStop = undefined;
}

export function isPlaying() {
  return playing;
}

export async function toggle(cb) {
  ensureAudio();

  if (!playing) {
    if (ctx.state === "suspended") await ctx.resume();
    onStop = cb;
    resetSong();
    playing = true;
    timer = setInterval(scheduler, 25);
    scheduler();
    return true;
  }

  stopPlayback();
  return false;
}
