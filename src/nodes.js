// Node type registry. Each entry is a self-contained module definition:
//
//   title, category, description
//   inputs / outputs: [{ id, kind: 'audio'|'note'|'mod', label }]
//   params:  [{ id, label, kind: 'range'|'select'|'toggle'|'custom', default, ... }]
//   create(ctx, params, api) -> instance
//       instance.inputs[portId]  : AudioNode (audio/mod) or fn(event) (note)
//       instance.outputs[portId] : AudioNode (audio/mod); note outputs use api.emit(portId, ev)
//       instance.setParam(key, value)   optional, react to param changes
//       instance.allOff()               optional, release held notes
//       instance.onBpm(bpm)             optional, tempo changed
//       instance.dispose()              optional, tear down
//   renderBody(el, { node, patch, instance }) -> cleanup?   optional custom UI
//
// `params` is the live, persisted object for the node: read from it at play time.
// To add a module, add an entry here — the palette and editor pick it up automatically.

import {
  mtof, noteName, clamp, h, isTyping, modInput, smooth, holdAt, equalPower,
  RATE_DIVS, createClock, atAudioTime,
} from './util.js';

export const CATEGORIES = [
  { id: 'source', label: 'Sources' },
  { id: 'notes', label: 'Note FX' },
  { id: 'sound', label: 'Sound' },
  { id: 'mod', label: 'Modulators' },
  { id: 'effect', label: 'Effects' },
  { id: 'output', label: 'Output' },
];

// ---- param builders ---------------------------------------------------------
const range = (id, label, min, max, def, o = {}) => ({ id, label, kind: 'range', min, max, default: def, ...o });
const select = (id, label, options, def) => ({ id, label, kind: 'select', options, default: def });
const toggle = (id, label, def, labels) => ({ id, label, kind: 'toggle', default: def, labels });

const WAVES = ['sine', 'triangle', 'sawtooth', 'square'];
const ADSR = (a, d, s, r) => [
  range('attack', 'Attack', 0.001, 4, a, { log: true, unit: 's' }),
  range('decay', 'Decay', 0.01, 4, d, { log: true, unit: 's' }),
  range('sustain', 'Sustain', 0, 1, s),
  range('release', 'Release', 0.01, 6, r, { log: true, unit: 's' }),
];

const note = (id = 'notes', label = 'notes') => ({ id, kind: 'note', label });
const audio = (id = 'in', label = 'in') => ({ id, kind: 'audio', label });
const mod = (id, label) => ({ id, kind: 'mod', label });

// Shared wet/dry wrapper for effects: input -> dry -> out, input -> [fx] -> wet -> out
function wetDry(ctx, mix) {
  const input = ctx.createGain();
  const out = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry).connect(out);
  wet.connect(out);
  const setMix = (m) => {
    const [d, w] = equalPower(m);
    smooth(ctx, dry.gain, d);
    smooth(ctx, wet.gain, w);
  };
  const [d, w] = equalPower(mix);
  dry.gain.value = d;
  wet.gain.value = w;
  return { input, out, wet, setMix, dispose: () => [input, out, dry, wet].forEach((n) => n.disconnect()) };
}

// =============================================================================
export const NODE_TYPES = {
  // ---------------------------------------------------------------- SOURCES --
  keyboard: {
    title: 'Keyboard',
    category: 'source',
    description: 'Computer keys, mouse, or MIDI',
    inputs: [],
    outputs: [note()],
    params: [range('octave', 'Octave', 1, 7, 4, { step: 1 }), range('velocity', 'Velocity', 0.1, 1, 0.8)],
    create(ctx, p, api) {
      // Two rows like a piano: A S D F G H J K = white keys, W E T Y U O P = black keys
      const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16 };
      const down = new Map(); // key -> note number (so octave changes don't strand notes)
      let midi = null;
      const self = { inputs: {}, outputs: {}, onNoteUI: null };
      self.base = () => 12 * (p.octave + 1);
      self.play = (n, on, velocity = p.velocity) => {
        api.emit('notes', { type: on ? 'on' : 'off', note: n, velocity, time: ctx.currentTime });
        self.onNoteUI?.(n, on);
      };
      const kd = (e) => {
        if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
        const k = e.key.toLowerCase();
        if (k === 'z' || k === 'x') return api.setParam('octave', clamp(p.octave + (k === 'x' ? 1 : -1), 1, 7));
        if (!(k in KEYMAP) || down.has(k)) return;
        const n = self.base() + KEYMAP[k];
        down.set(k, n);
        self.play(n, true);
      };
      const ku = (e) => {
        const k = e.key.toLowerCase();
        if (!down.has(k)) return;
        self.play(down.get(k), false);
        down.delete(k);
      };
      const releaseAll = () => {
        for (const n of down.values()) self.play(n, false);
        down.clear();
      };
      window.addEventListener('keydown', kd);
      window.addEventListener('keyup', ku);
      window.addEventListener('blur', releaseAll);

      const onMidi = (m) => {
        const [st, n, v] = m.data;
        const cmd = st & 0xf0;
        if (cmd === 0x90 && v > 0) self.play(n, true, v / 127);
        else if (cmd === 0x80 || (cmd === 0x90 && v === 0)) self.play(n, false, 0);
      };
      self.enableMIDI = async () => {
        if (!navigator.requestMIDIAccess) throw new Error('Web MIDI not supported in this browser');
        midi = await navigator.requestMIDIAccess();
        const bind = () => {
          for (const input of midi.inputs.values()) input.onmidimessage = onMidi;
        };
        bind();
        midi.onstatechange = bind;
        return midi.inputs.size;
      };
      self.allOff = releaseAll;
      self.dispose = () => {
        releaseAll();
        window.removeEventListener('keydown', kd);
        window.removeEventListener('keyup', ku);
        window.removeEventListener('blur', releaseAll);
        if (midi) for (const input of midi.inputs.values()) input.onmidimessage = null;
      };
      return self;
    },
    renderBody(el, { instance }) {
      // One and a bit octaves of clickable piano
      const whites = [0, 2, 4, 5, 7, 9, 11, 12];
      const blacks = [[1, 1], [3, 2], [6, 4], [8, 5], [10, 6]]; // [semitone, after white index]
      const keys = new Map();
      let held = null;
      const press = (semi) => {
        held = instance.base() + semi;
        instance.play(held, true);
        window.addEventListener('pointerup', () => { instance.play(held, false); held = null; }, { once: true });
      };
      const piano = h('div', { class: 'piano' });
      whites.forEach((s) => {
        const k = h('div', { class: 'key white', onpointerdown: (e) => { e.preventDefault(); press(s); } });
        keys.set(s, k);
        piano.append(k);
      });
      blacks.forEach(([s, after]) => {
        const k = h('div', {
          class: 'key black',
          style: { left: `calc(${(after * 100) / whites.length}% - 7px)` },
          onpointerdown: (e) => { e.preventDefault(); press(s); },
        });
        keys.set(s, k);
        piano.append(k);
      });
      instance.onNoteUI = (n, on) => keys.get(n - instance.base())?.classList.toggle('down', on);

      const midiBtn = h('button', { class: 'small' }, 'Enable MIDI');
      midiBtn.onclick = async () => {
        try {
          const count = await instance.enableMIDI();
          midiBtn.textContent = `MIDI on · ${count} input${count === 1 ? '' : 's'}`;
        } catch (err) {
          midiBtn.textContent = err.message;
        }
      };
      el.append(piano, h('div', { class: 'hint' }, 'Keys A–K play · Z/X octave'), midiBtn);
      return () => { instance.onNoteUI = null; };
    },
  },

  sequencer: {
    title: 'Step Sequencer',
    category: 'source',
    description: '8-step pattern, synced to BPM',
    inputs: [],
    outputs: [note()],
    params: [
      toggle('running', 'Transport', false, ['▶ Play', '■ Stop']),
      select('rate', 'Rate', Object.keys(RATE_DIVS), '1/8'),
      range('gate', 'Gate', 0.05, 1, 0.5),
      range('root', 'Root', 24, 72, 48, { step: 1, fmt: noteName }),
      {
        id: 'steps',
        kind: 'custom',
        default: [0, null, 12, 0, null, 10, 7, 3].map((s) => ({ on: s !== null, semi: s ?? 0 })),
      },
    ],
    create(ctx, p, api) {
      const self = { inputs: {}, outputs: {}, onStepUI: null };
      const stepDur = () => 60 / api.bpm / RATE_DIVS[p.rate];
      const clock = createClock(ctx, stepDur, (t, i) => {
        const idx = i % p.steps.length;
        const s = p.steps[idx];
        atAudioTime(ctx, t, () => self.onStepUI?.(idx));
        if (!s.on) return;
        const n = p.root + s.semi;
        api.emit('notes', { type: 'on', note: n, velocity: 0.9, time: t });
        api.emit('notes', { type: 'off', note: n, velocity: 0, time: t + stepDur() * p.gate });
      });
      self.setParam = (k, v) => {
        if (k !== 'running') return;
        if (v) clock.start();
        else {
          clock.stop();
          self.onStepUI?.(-1);
        }
      };
      if (p.running) clock.start();
      self.dispose = () => clock.stop();
      return self;
    },
    renderBody(el, { node, patch, instance }) {
      const update = (fn) => {
        const steps = structuredClone(node.params.steps);
        fn(steps);
        patch.setParam(node.id, 'steps', steps);
      };
      const cols = node.params.steps.map((s, i) => {
        const label = h('div', { class: 'seq-label' }, `+${s.semi}`);
        const slider = h('input', { type: 'range', class: 'seq-slider', min: 0, max: 24, step: 1, value: s.semi, title: 'Semitones above root' });
        slider.oninput = () => {
          label.textContent = `+${slider.value}`;
          update((st) => (st[i].semi = +slider.value));
        };
        const btn = h('button', { class: `seq-step${s.on ? ' on' : ''}`, title: 'Toggle step' });
        btn.onclick = () => {
          btn.classList.toggle('on');
          update((st) => (st[i].on = !st[i].on));
        };
        return h('div', { class: 'seq-col' }, label, slider, btn);
      });
      el.append(h('div', { class: 'seq' }, cols));
      instance.onStepUI = (idx) => cols.forEach((c, j) => c.classList.toggle('playing', j === idx));
      return () => { instance.onStepUI = null; };
    },
  },

  // ---------------------------------------------------------------- NOTE FX --
  arp: {
    title: 'Arpeggiator',
    category: 'notes',
    description: 'Turns held chords into patterns',
    inputs: [note()],
    outputs: [note()],
    params: [
      select('pattern', 'Pattern', ['up', 'down', 'up-down', 'random', 'as played'], 'up'),
      select('rate', 'Rate', Object.keys(RATE_DIVS), '1/16'),
      range('octaves', 'Octaves', 1, 4, 2, { step: 1 }),
      range('gate', 'Gate', 0.05, 1, 0.5),
      toggle('latch', 'Latch', false, ['Latch off', 'Latch on']),
    ],
    create(ctx, p, api) {
      let order = []; // arpeggiated notes, in the order they were pressed
      const physical = new Set(); // keys actually held right now
      let velocity = 0.8;
      let step = 0;
      const stepDur = () => 60 / api.bpm / RATE_DIVS[p.rate];

      const sequence = () => {
        const base = p.pattern === 'as played' ? order : [...order].sort((a, b) => a - b);
        const list = [];
        for (let o = 0; o < p.octaves; o++) for (const n of base) list.push(n + 12 * o);
        if (p.pattern === 'down') list.reverse();
        if (p.pattern === 'up-down' && list.length > 2) list.push(...list.slice(1, -1).reverse());
        return list;
      };
      const clock = createClock(ctx, stepDur, (t) => {
        const list = sequence();
        if (!list.length) return;
        const n = p.pattern === 'random' ? list[Math.floor(Math.random() * list.length)] : list[step++ % list.length];
        api.emit('notes', { type: 'on', note: n, velocity, time: t });
        api.emit('notes', { type: 'off', note: n, velocity: 0, time: t + stepDur() * p.gate });
      });
      const sync = () => {
        if (order.length && !clock.running) {
          step = 0;
          clock.start();
        } else if (!order.length && clock.running) clock.stop();
      };
      return {
        inputs: {
          notes(ev) {
            if (ev.type === 'on') {
              if (p.latch && physical.size === 0) order = []; // new chord replaces latched one
              physical.add(ev.note);
              if (!order.includes(ev.note)) order.push(ev.note);
              velocity = ev.velocity;
            } else {
              physical.delete(ev.note);
              if (!p.latch) order = order.filter((n) => n !== ev.note);
            }
            sync();
          },
        },
        outputs: {},
        setParam(k, v) {
          if (k === 'latch' && !v) {
            order = order.filter((n) => physical.has(n));
            sync();
          }
        },
        allOff() {
          order = [];
          physical.clear();
          sync();
        },
        dispose: () => clock.stop(),
      };
    },
  },

  // ------------------------------------------------------------------ SOUND --
  voice: {
    title: 'Synth Voice',
    category: 'sound',
    description: 'Polyphonic oscillator + envelope',
    inputs: [note(), mod('pitch', 'pitch ~')],
    outputs: [audio('out', 'out')],
    params: [
      select('wave', 'Wave', WAVES, 'sawtooth'),
      range('octave', 'Octave', -3, 3, 0, { step: 1 }),
      range('detune', 'Detune', -50, 50, 0, { step: 1, unit: 'ct' }),
      ...ADSR(0.01, 0.3, 0.6, 0.4),
      range('level', 'Level', 0, 1, 0.6),
    ],
    create(ctx, p) {
      const out = ctx.createGain();
      out.gain.value = p.level;
      const pitch = ctx.createGain(); // mod bus, fanned out to every voice's detune
      pitch.gain.value = 1200; // full mod = ±1 octave
      const voices = new Map(); // note -> { osc, env }
      const MAX_VOICES = 16;

      const release = (n, t, r = p.release) => {
        const v = voices.get(n);
        if (!v) return;
        voices.delete(n);
        holdAt(v.env.gain, t);
        v.env.gain.setTargetAtTime(0, t, r / 3 + 0.001);
        v.osc.stop(t + r * 2.5 + 0.05);
      };
      const noteOn = ({ note: n, velocity = 0.8, time }) => {
        const t = Math.max(time ?? 0, ctx.currentTime);
        if (voices.has(n)) release(n, t, 0.01);
        if (voices.size >= MAX_VOICES) release(voices.keys().next().value, t, 0.01); // steal oldest
        const osc = ctx.createOscillator();
        osc.type = p.wave;
        osc.frequency.value = mtof(n + 12 * p.octave);
        osc.detune.value = p.detune;
        pitch.connect(osc.detune);
        const env = ctx.createGain();
        const g = env.gain;
        const peak = 0.3 * velocity; // headroom for chords
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(peak, t + p.attack);
        g.setTargetAtTime(peak * p.sustain, t + p.attack, p.decay / 3);
        osc.connect(env).connect(out);
        osc.start(t);
        osc.onended = () => {
          osc.disconnect();
          env.disconnect();
          try { pitch.disconnect(osc.detune); } catch { /* ok */ }
        };
        voices.set(n, { osc, env });
      };
      const allOff = () => [...voices.keys()].forEach((n) => release(n, ctx.currentTime, 0.05));
      return {
        inputs: {
          notes: (ev) => (ev.type === 'on' ? noteOn(ev) : release(ev.note, Math.max(ev.time ?? 0, ctx.currentTime))),
          pitch,
        },
        outputs: { out },
        setParam(k, v) {
          if (k === 'level') smooth(ctx, out.gain, v);
          for (const { osc } of voices.values()) {
            if (k === 'wave') osc.type = v;
            if (k === 'detune') smooth(ctx, osc.detune, v);
          }
        },
        allOff,
        dispose() {
          allOff();
          setTimeout(() => out.disconnect(), 200);
        },
      };
    },
  },

  osc: {
    title: 'Oscillator',
    category: 'sound',
    description: 'Free-running tone — drone or FM source',
    inputs: [mod('freq', 'freq ~')],
    outputs: [audio('out', 'out')],
    params: [
      select('wave', 'Wave', WAVES, 'sine'),
      range('freq', 'Freq', 0.5, 4000, 110, { log: true, unit: 'Hz' }),
      range('level', 'Level', 0, 1, 0.3),
    ],
    create(ctx, p) {
      const osc = ctx.createOscillator();
      osc.type = p.wave;
      osc.frequency.value = p.freq;
      const out = ctx.createGain();
      out.gain.value = p.level;
      osc.connect(out);
      osc.start();
      return {
        inputs: { freq: modInput(ctx, osc.detune, 1200) },
        outputs: { out },
        setParam(k, v) {
          if (k === 'wave') osc.type = v;
          if (k === 'freq') smooth(ctx, osc.frequency, v);
          if (k === 'level') smooth(ctx, out.gain, v);
        },
        dispose() {
          osc.stop();
          out.disconnect();
        },
      };
    },
  },

  // ------------------------------------------------------------- MODULATORS --
  lfo: {
    title: 'LFO',
    category: 'mod',
    description: 'Slow cyclic modulation',
    inputs: [mod('rate', 'rate ~')],
    outputs: [mod('out', 'out')],
    params: [
      select('wave', 'Wave', WAVES, 'sine'),
      range('rate', 'Rate', 0.02, 20, 0.5, { log: true, unit: 'Hz' }),
      range('depth', 'Depth', 0, 1, 0.5),
    ],
    create(ctx, p) {
      const osc = ctx.createOscillator();
      osc.type = p.wave;
      osc.frequency.value = p.rate;
      const depth = ctx.createGain();
      depth.gain.value = p.depth;
      osc.connect(depth);
      osc.start();
      return {
        inputs: { rate: modInput(ctx, osc.detune, 1200) },
        outputs: { out: depth },
        setParam(k, v) {
          if (k === 'wave') osc.type = v;
          if (k === 'rate') smooth(ctx, osc.frequency, v);
          if (k === 'depth') smooth(ctx, depth.gain, v);
        },
        dispose() {
          osc.stop();
          depth.disconnect();
        },
      };
    },
  },

  envelope: {
    title: 'Envelope',
    category: 'mod',
    description: 'ADSR shape triggered by notes',
    inputs: [note()],
    outputs: [mod('out', 'out')],
    params: [...ADSR(0.005, 0.25, 0.2, 0.3), range('amount', 'Amount', -1, 1, 0.8)],
    create(ctx, p) {
      const src = ctx.createConstantSource();
      src.offset.value = 0;
      const amt = ctx.createGain();
      amt.gain.value = p.amount;
      src.connect(amt);
      src.start();
      const o = src.offset;
      let held = 0;
      const off = (t) => {
        holdAt(o, t);
        o.setTargetAtTime(0, t, p.release / 3 + 0.001);
      };
      return {
        inputs: {
          notes(ev) {
            const t = Math.max(ev.time ?? 0, ctx.currentTime);
            if (ev.type === 'on') {
              held++;
              holdAt(o, t);
              o.linearRampToValueAtTime(1, t + p.attack);
              o.setTargetAtTime(p.sustain, t + p.attack, p.decay / 3);
            } else {
              held = Math.max(0, held - 1);
              if (held === 0) off(t);
            }
          },
        },
        outputs: { out: amt },
        setParam(k, v) {
          if (k === 'amount') smooth(ctx, amt.gain, v);
        },
        allOff() {
          held = 0;
          off(ctx.currentTime);
        },
        dispose() {
          src.stop();
          amt.disconnect();
        },
      };
    },
  },

  // ---------------------------------------------------------------- EFFECTS --
  filter: {
    title: 'Filter',
    category: 'effect',
    description: 'Low/high/band-pass with resonance',
    inputs: [audio(), mod('cutoff', 'cutoff ~')],
    outputs: [audio('out', 'out')],
    params: [
      select('type', 'Type', ['lowpass', 'highpass', 'bandpass', 'notch'], 'lowpass'),
      range('cutoff', 'Cutoff', 30, 16000, 1200, { log: true, unit: 'Hz' }),
      range('q', 'Resonance', 0.1, 24, 4, { log: true }),
    ],
    create(ctx, p) {
      const f = ctx.createBiquadFilter();
      f.type = p.type;
      f.frequency.value = p.cutoff;
      f.Q.value = p.q;
      return {
        inputs: { in: f, cutoff: modInput(ctx, f.detune, 2400) }, // full mod = ±2 octaves
        outputs: { out: f },
        setParam(k, v) {
          if (k === 'type') f.type = v;
          if (k === 'cutoff') smooth(ctx, f.frequency, v);
          if (k === 'q') smooth(ctx, f.Q, v);
        },
        dispose: () => f.disconnect(),
      };
    },
  },

  delay: {
    title: 'Delay',
    category: 'effect',
    description: 'Echo with feedback, tempo sync',
    inputs: [audio(), mod('time', 'time ~')],
    outputs: [audio('out', 'out')],
    params: [
      select('sync', 'Sync', ['free', '1/4', '1/8', '1/8D', '1/16'], '1/8D'),
      range('time', 'Time', 0.01, 1.5, 0.3, { log: true, unit: 's' }),
      range('feedback', 'Feedback', 0, 0.95, 0.4),
      range('mix', 'Mix', 0, 1, 0.3),
    ],
    create(ctx, p, api) {
      const SYNC = { '1/4': 1, '1/8': 0.5, '1/8D': 0.75, '1/16': 0.25 };
      const wd = wetDry(ctx, p.mix);
      const d = ctx.createDelay(2);
      const fb = ctx.createGain();
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 5000;
      wd.input.connect(d).connect(tone).connect(fb).connect(d);
      tone.connect(wd.wet);
      fb.gain.value = p.feedback;
      const time = () => (p.sync === 'free' ? p.time : (60 / api.bpm) * SYNC[p.sync]);
      d.delayTime.value = time();
      const retime = () => smooth(ctx, d.delayTime, time(), 0.05);
      return {
        inputs: { in: wd.input, time: modInput(ctx, d.delayTime, 0.01) },
        outputs: { out: wd.out },
        setParam(k, v) {
          if (k === 'time' || k === 'sync') retime();
          if (k === 'feedback') smooth(ctx, fb.gain, v);
          if (k === 'mix') wd.setMix(v);
        },
        onBpm: retime,
        dispose() {
          wd.dispose();
          [d, fb, tone].forEach((n) => n.disconnect());
        },
      };
    },
  },

  reverb: {
    title: 'Reverb',
    category: 'effect',
    description: 'Algorithmic room/hall',
    inputs: [audio()],
    outputs: [audio('out', 'out')],
    params: [range('decay', 'Decay', 0.2, 8, 2.5, { log: true, unit: 's' }), range('mix', 'Mix', 0, 1, 0.3)],
    create(ctx, p) {
      const wd = wetDry(ctx, p.mix);
      const conv = ctx.createConvolver();
      wd.input.connect(conv).connect(wd.wet);
      // Impulse response = exponentially decaying stereo noise
      const makeIR = (secs) => {
        const len = Math.floor(ctx.sampleRate * secs);
        const buf = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let c = 0; c < 2; c++) {
          const data = buf.getChannelData(c);
          for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
        }
        conv.buffer = buf;
      };
      makeIR(p.decay);
      let timer;
      return {
        inputs: { in: wd.input },
        outputs: { out: wd.out },
        setParam(k, v) {
          if (k === 'mix') wd.setMix(v);
          if (k === 'decay') {
            clearTimeout(timer);
            timer = setTimeout(() => makeIR(v), 120);
          }
        },
        dispose() {
          wd.dispose();
          conv.disconnect();
        },
      };
    },
  },

  distortion: {
    title: 'Distortion',
    category: 'effect',
    description: 'Waveshaper drive + tone',
    inputs: [audio()],
    outputs: [audio('out', 'out')],
    params: [
      range('drive', 'Drive', 0, 1, 0.4),
      range('tone', 'Tone', 200, 12000, 3500, { log: true, unit: 'Hz' }),
      range('mix', 'Mix', 0, 1, 1),
    ],
    create(ctx, p) {
      const wd = wetDry(ctx, p.mix);
      const shaper = ctx.createWaveShaper();
      shaper.oversample = '4x';
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = p.tone;
      wd.input.connect(shaper).connect(tone).connect(wd.wet);
      const setDrive = (drive) => {
        const k = drive * 80;
        const curve = new Float32Array(2048);
        for (let i = 0; i < curve.length; i++) {
          const x = (i / (curve.length - 1)) * 2 - 1;
          curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
        }
        shaper.curve = curve;
      };
      setDrive(p.drive);
      return {
        inputs: { in: wd.input },
        outputs: { out: wd.out },
        setParam(k, v) {
          if (k === 'drive') setDrive(v);
          if (k === 'tone') smooth(ctx, tone.frequency, v);
          if (k === 'mix') wd.setMix(v);
        },
        dispose() {
          wd.dispose();
          shaper.disconnect();
          tone.disconnect();
        },
      };
    },
  },

  vca: {
    title: 'VCA',
    category: 'effect',
    description: 'Gain stage — modulate for tremolo',
    inputs: [audio(), mod('gain', 'gain ~')],
    outputs: [audio('out', 'out')],
    params: [range('gain', 'Gain', 0, 2, 1)],
    create(ctx, p) {
      const g = ctx.createGain();
      g.gain.value = p.gain;
      return {
        inputs: { in: g, gain: modInput(ctx, g.gain, 1) },
        outputs: { out: g },
        setParam: (k, v) => smooth(ctx, g.gain, v),
        dispose: () => g.disconnect(),
      };
    },
  },

  panner: {
    title: 'Panner',
    category: 'effect',
    description: 'Stereo position — modulate for auto-pan',
    inputs: [audio(), mod('pan', 'pan ~')],
    outputs: [audio('out', 'out')],
    params: [range('pan', 'Pan', -1, 1, 0)],
    create(ctx, p) {
      const pn = ctx.createStereoPanner();
      pn.pan.value = p.pan;
      return {
        inputs: { in: pn, pan: modInput(ctx, pn.pan, 1) },
        outputs: { out: pn },
        setParam: (k, v) => smooth(ctx, pn.pan, v),
        dispose: () => pn.disconnect(),
      };
    },
  },

  // ----------------------------------------------------------------- OUTPUT --
  output: {
    title: 'Output',
    category: 'output',
    description: 'Speakers (one per patch)',
    singleton: true,
    inputs: [audio()],
    outputs: [],
    params: [range('volume', 'Volume', 0, 1, 0.7)],
    create(ctx, p) {
      const input = ctx.createGain();
      const vol = ctx.createGain();
      vol.gain.value = p.volume;
      const limiter = ctx.createDynamicsCompressor(); // protects ears from runaway feedback
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.1;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      input.connect(vol).connect(limiter).connect(analyser).connect(ctx.destination);
      return {
        inputs: { in: input },
        outputs: {},
        analyser,
        setParam: (k, v) => smooth(ctx, vol.gain, v),
        dispose() {
          input.disconnect();
          analyser.disconnect();
        },
      };
    },
    renderBody(el, { instance }) {
      const dpr = window.devicePixelRatio || 1;
      const canvas = h('canvas', { class: 'scope', width: 196 * dpr, height: 64 * dpr });
      el.append(canvas);
      const g = canvas.getContext('2d');
      const data = new Float32Array(instance.analyser.fftSize);
      const color = getComputedStyle(document.documentElement).getPropertyValue('--audio').trim();
      let raf;
      const draw = () => {
        instance.analyser.getFloatTimeDomainData(data);
        // Find a rising zero-crossing so the waveform holds still
        let start = 0;
        for (let i = 1; i < data.length / 2; i++) if (data[i - 1] < 0 && data[i] >= 0) { start = i; break; }
        const W = canvas.width, H = canvas.height, N = data.length / 2;
        g.clearRect(0, 0, W, H);
        g.strokeStyle = color;
        g.lineWidth = 1.5 * dpr;
        g.beginPath();
        for (let i = 0; i < N; i++) {
          const x = (i / N) * W;
          const y = H / 2 - data[start + i] * (H / 2) * 0.9;
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
        raf = requestAnimationFrame(draw);
      };
      draw();
      return () => cancelAnimationFrame(raf);
    },
  },
};
