// Starter patches. Same JSON shape as Export / localStorage, so you can paste exports here.

const e = (from, to) => {
  const [fn, fp] = from.split('.');
  const [tn, tp] = to.split('.');
  return { from: { node: fn, port: fp }, to: { node: tn, port: tp } };
};

export const PRESETS = [
  {
    name: 'Arp pad',
    patch: {
      bpm: 112,
      nodes: [
        { id: 'kb', type: 'keyboard', x: 40, y: 40, params: {} },
        { id: 'arp', type: 'arp', x: 40, y: 330, params: { pattern: 'up-down', octaves: 2, rate: '1/16' } },
        { id: 'v', type: 'voice', x: 310, y: 40, params: { wave: 'sawtooth', attack: 0.005, decay: 0.25, sustain: 0.3, release: 0.35 } },
        { id: 'lfo', type: 'lfo', x: 310, y: 470, params: { rate: 0.15, depth: 0.7 } },
        { id: 'f', type: 'filter', x: 580, y: 40, params: { cutoff: 900, q: 8 } },
        { id: 'd', type: 'delay', x: 850, y: 40, params: { sync: '1/8D', feedback: 0.45, mix: 0.3 } },
        { id: 'r', type: 'reverb', x: 850, y: 330, params: { decay: 3, mix: 0.35 } },
        { id: 'out', type: 'output', x: 1120, y: 40, params: {} },
      ],
      edges: [
        e('kb.notes', 'arp.notes'),
        e('arp.notes', 'v.notes'),
        e('v.out', 'f.in'),
        e('lfo.out', 'f.cutoff'),
        e('f.out', 'd.in'),
        e('d.out', 'r.in'),
        e('r.out', 'out.in'),
      ],
    },
  },
  {
    name: 'Sequenced acid bass',
    patch: {
      bpm: 124,
      nodes: [
        { id: 'seq', type: 'sequencer', x: 40, y: 40, params: { rate: '1/16', gate: 0.45, root: 36 } },
        { id: 'v', type: 'voice', x: 330, y: 40, params: { wave: 'sawtooth', attack: 0.003, decay: 0.2, sustain: 0.5, release: 0.08, level: 0.7 } },
        { id: 'env', type: 'envelope', x: 40, y: 420, params: { attack: 0.003, decay: 0.18, sustain: 0, release: 0.1, amount: 0.9 } },
        { id: 'f', type: 'filter', x: 600, y: 40, params: { cutoff: 260, q: 14 } },
        { id: 'dist', type: 'distortion', x: 870, y: 40, params: { drive: 0.35, tone: 4000 } },
        { id: 'd', type: 'delay', x: 870, y: 290, params: { sync: '1/8D', feedback: 0.3, mix: 0.2 } },
        { id: 'out', type: 'output', x: 1140, y: 40, params: {} },
      ],
      edges: [
        e('seq.notes', 'v.notes'),
        e('seq.notes', 'env.notes'),
        e('v.out', 'f.in'),
        e('env.out', 'f.cutoff'),
        e('f.out', 'dist.in'),
        e('dist.out', 'd.in'),
        e('d.out', 'out.in'),
      ],
    },
  },
  {
    name: 'FM bell + tremolo',
    patch: {
      bpm: 90,
      nodes: [
        { id: 'kb', type: 'keyboard', x: 40, y: 40, params: { octave: 5 } },
        { id: 'mod', type: 'osc', x: 40, y: 330, params: { wave: 'sine', freq: 660, level: 0.6 } },
        { id: 'v', type: 'voice', x: 310, y: 40, params: { wave: 'sine', attack: 0.002, decay: 1.2, sustain: 0, release: 1.5, level: 0.8 } },
        { id: 'lfo', type: 'lfo', x: 310, y: 480, params: { rate: 5, depth: 0.4, wave: 'triangle' } },
        { id: 'vca', type: 'vca', x: 580, y: 40, params: { gain: 0.8 } },
        { id: 'r', type: 'reverb', x: 580, y: 220, params: { decay: 4, mix: 0.4 } },
        { id: 'out', type: 'output', x: 850, y: 40, params: {} },
      ],
      edges: [
        e('kb.notes', 'v.notes'),
        e('mod.out', 'v.pitch'),
        e('v.out', 'vca.in'),
        e('lfo.out', 'vca.gain'),
        e('vca.out', 'r.in'),
        e('r.out', 'out.in'),
      ],
    },
  },
  {
    name: 'Empty',
    patch: { bpm: 110, nodes: [{ id: 'out', type: 'output', x: 600, y: 120, params: {} }], edges: [] },
  },
];
