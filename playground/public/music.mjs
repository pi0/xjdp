// Retro keygen chiptune synth (Web Audio API)
// Demoscene-style tracker tune with delay, detuned oscillators, and pattern variation

const BPM = 140;
const STEP = 60 / BPM / 4; // 16th note

// C minor scale frequencies
const NOTE = {
  C3: 130.81,
  D3: 146.83,
  Eb3: 155.56,
  F3: 174.61,
  G3: 196.0,
  Ab3: 207.65,
  Bb3: 233.08,
  C4: 261.63,
  D4: 293.66,
  Eb4: 311.13,
  F4: 349.23,
  G4: 392.0,
  Ab4: 415.3,
  Bb4: 466.16,
  C5: 523.25,
  D5: 587.33,
  Eb5: 622.25,
  F5: 698.46,
  G5: 784.0,
  Ab5: 830.61,
  Bb5: 932.33,
  C6: 1046.5,
};

// Pattern A — melodic, ascending feel
const LEAD_A = [
  "C5",
  "Eb5",
  "G5",
  "Eb5",
  "F5",
  "D5",
  "Eb5",
  "C5",
  "Bb4",
  "C5",
  "Eb5",
  "G5",
  "Ab5",
  "G5",
  "F5",
  "Eb5",
];
// Pattern B — call-and-response
const LEAD_B = [
  "G5",
  "F5",
  "Eb5",
  "D5",
  "C5",
  null,
  "Eb5",
  "G5",
  "Ab5",
  "Bb5",
  "G5",
  "F5",
  "Eb5",
  "D5",
  "C5",
  null,
];
// Pattern C — high energy riff
const LEAD_C = [
  "C6",
  "Bb5",
  "Ab5",
  "G5",
  "Ab5",
  "Bb5",
  "G5",
  "F5",
  "Eb5",
  "F5",
  "G5",
  "Eb5",
  "D5",
  "C5",
  "D5",
  "Eb5",
];

// Arpeggio patterns (triads)
const ARP_A = [
  "C4",
  "Eb4",
  "G4",
  "C5",
  "G4",
  "Eb4",
  "C4",
  "Eb4",
  "F4",
  "Ab4",
  "C5",
  "Ab4",
  "F4",
  "Ab4",
  "C5",
  "F5",
];
const ARP_B = [
  "Eb4",
  "G4",
  "Bb4",
  "Eb5",
  "Bb4",
  "G4",
  "Eb4",
  "G4",
  "Ab4",
  "C5",
  "Eb5",
  "C5",
  "Ab4",
  "C5",
  "Eb5",
  "Ab5",
];

// Bass lines
const BASS_A = [
  "C3",
  null,
  "C3",
  null,
  "F3",
  null,
  "F3",
  null,
  "Ab3",
  null,
  "Ab3",
  null,
  "G3",
  null,
  "G3",
  "G3",
];
const BASS_B = [
  "Eb3",
  null,
  "Eb3",
  null,
  "Bb3",
  null,
  "Bb3",
  null,
  "Ab3",
  null,
  "Ab3",
  "G3",
  "F3",
  null,
  "G3",
  null,
];

// Drum patterns
const KICK_A = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0];
const KICK_B = [1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0];
const HAT_A = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0];
const HAT_B = [1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1];
const SNR_A = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
const SNR_B = [0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1];
const OH_A = [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]; // open hat accent

// Song structure (bar arrangements) — cycles every 8 bars
const SONG = [
  { lead: LEAD_A, arp: ARP_A, bass: BASS_A, kick: KICK_A, hat: HAT_A, snr: SNR_A, oh: OH_A },
  { lead: LEAD_A, arp: ARP_A, bass: BASS_A, kick: KICK_A, hat: HAT_A, snr: SNR_A, oh: OH_A },
  { lead: LEAD_B, arp: ARP_B, bass: BASS_B, kick: KICK_B, hat: HAT_B, snr: SNR_B, oh: OH_A },
  { lead: LEAD_B, arp: ARP_B, bass: BASS_B, kick: KICK_B, hat: HAT_B, snr: SNR_B, oh: OH_A },
  { lead: LEAD_C, arp: ARP_A, bass: BASS_A, kick: KICK_B, hat: HAT_B, snr: SNR_B, oh: OH_A },
  { lead: LEAD_C, arp: ARP_B, bass: BASS_B, kick: KICK_B, hat: HAT_B, snr: SNR_B, oh: OH_A },
  { lead: LEAD_A, arp: ARP_B, bass: BASS_A, kick: KICK_A, hat: HAT_A, snr: SNR_A, oh: OH_A },
  { lead: LEAD_B, arp: ARP_A, bass: BASS_B, kick: KICK_A, hat: HAT_B, snr: SNR_A, oh: OH_A },
];

let audioCtx;
let playing = false;
let barIndex = 0;
let masterGain;
let delayNode;
let feedbackGain;
let nextStartTime = 0;

function initEffects(ctx) {
  masterGain = ctx.createGain();
  masterGain.gain.value = 0.85;

  // Stereo delay for spaciousness
  delayNode = ctx.createDelay(1);
  delayNode.delayTime.value = STEP * 3; // dotted 8th delay
  feedbackGain = ctx.createGain();
  feedbackGain.gain.value = 0.3;

  const delayFilter = ctx.createBiquadFilter();
  delayFilter.type = "lowpass";
  delayFilter.frequency.value = 3000;

  // delay → filter → feedback → delay
  delayNode.connect(delayFilter);
  delayFilter.connect(feedbackGain);
  feedbackGain.connect(delayNode);

  // delay output → master
  delayFilter.connect(masterGain);
  masterGain.connect(ctx.destination);
}

function chip(
  ctx,
  freq,
  start,
  dur,
  { type = "square", vol = 0.08, detune = 0, vibrato = 0, delay = false } = {},
) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, start);
  gain.gain.setValueAtTime(vol * 0.8, start + dur * 0.6);
  gain.gain.exponentialRampToValueAtTime(0.001, start + dur);

  const dest = delay && delayNode ? delayNode : masterGain;
  if (!dest) return;

  // Main oscillator
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (detune) osc.detune.setValueAtTime(detune, start);

  // Vibrato LFO
  if (vibrato > 0) {
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 5.5;
    lfoGain.gain.value = vibrato;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    lfo.start(start);
    lfo.stop(start + dur);
  }

  osc.connect(gain);

  // Detuned second oscillator for thickness
  if (detune) {
    const osc2 = ctx.createOscillator();
    osc2.type = type;
    osc2.frequency.setValueAtTime(freq, start);
    osc2.detune.setValueAtTime(-detune, start);
    osc2.connect(gain);
    osc2.start(start);
    osc2.stop(start + dur);
  }

  gain.connect(dest);
  osc.start(start);
  osc.stop(start + dur);
}

function noise(ctx, start, dur, vol = 0.06, hpFreq = 8000) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  src.buffer = buf;
  filter.type = "highpass";
  filter.frequency.value = hpFreq;
  gain.gain.setValueAtTime(vol, start);
  gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
  src.connect(filter).connect(gain).connect(masterGain);
  src.start(start);
  src.stop(start + dur);
}

function kick(ctx, start) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.setValueAtTime(160, start);
  osc.frequency.exponentialRampToValueAtTime(28, start + 0.12);
  gain.gain.setValueAtTime(0.3, start);
  gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
  osc.connect(gain).connect(masterGain);
  osc.start(start);
  osc.stop(start + 0.18);

  // Click transient
  const click = ctx.createOscillator();
  const clickGain = ctx.createGain();
  click.frequency.value = 1000;
  clickGain.gain.setValueAtTime(0.15, start);
  clickGain.gain.exponentialRampToValueAtTime(0.001, start + 0.015);
  click.connect(clickGain).connect(masterGain);
  click.start(start);
  click.stop(start + 0.02);
}

function scheduleLoop() {
  if (!masterGain) initEffects(audioCtx);

  const now = audioCtx.currentTime;
  const start = nextStartTime > now ? nextStartTime : now + 0.05;
  const bars = 4;
  const steps = bars * 16;
  const duration = steps * STEP;

  for (let i = 0; i < steps; i++) {
    const t = start + i * STEP;
    const bar = Math.floor(i / 16);
    const s = i % 16;
    const pattern = SONG[(barIndex + bar) % SONG.length];

    // Lead — detuned square with vibrato, fed into delay
    const leadNote = pattern.lead[s];
    if (leadNote) {
      chip(audioCtx, NOTE[leadNote], t, STEP * 1.6, {
        type: "square",
        vol: 0.055,
        detune: 8,
        vibrato: 3,
        delay: true,
      });
    }

    // Arp — fast sawtooth, also delayed
    const arpNote = pattern.arp[s];
    if (arpNote) {
      chip(audioCtx, NOTE[arpNote], t, STEP * 0.5, {
        type: "sawtooth",
        vol: 0.03,
        delay: true,
      });
    }

    // Bass — thick detuned sawtooth
    const bassNote = pattern.bass[s];
    if (bassNote) {
      chip(audioCtx, NOTE[bassNote], t, STEP * 1.8, {
        type: "sawtooth",
        vol: 0.1,
        detune: 12,
      });
    }

    // Drums
    if (pattern.kick[s]) kick(audioCtx, t);
    if (pattern.hat[s]) noise(audioCtx, t, 0.035, 0.035, 9000);
    if (pattern.snr[s]) noise(audioCtx, t, 0.1, 0.09, 3000);
    if (pattern.oh[s]) noise(audioCtx, t, 0.15, 0.05, 6000); // open hat
  }

  barIndex = (barIndex + bars) % SONG.length;
  nextStartTime = start + duration;

  // Re-schedule ~200ms before current batch ends to avoid gaps
  const msUntilEnd = (nextStartTime - audioCtx.currentTime) * 1000;
  setTimeout(
    () => {
      if (playing) {
        scheduleLoop();
      } else {
        onEnd?.();
      }
    },
    Math.max(0, msUntilEnd - 200),
  );
}

let onEnd;

export function isPlaying() {
  return playing;
}

export async function toggle(cb) {
  if (!playing) {
    playing = true;
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === "suspended") await audioCtx.resume();
    onEnd = cb;
    scheduleLoop();
    return true;
  }
  playing = false;
  masterGain = null;
  delayNode = null;
  feedbackGain = null;
  barIndex = 0;
  nextStartTime = 0;
  audioCtx.close();
  audioCtx = null;
  return false;
}
