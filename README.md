# Patchbay

A node-based instrument builder in the browser. Patch sources, note processors, sound
generators, modulators and effects together with cables, and play the result.

No build step and no dependencies. It's plain ES modules plus the Web Audio API.

```bash
python3 -m http.server 8765   # then open http://localhost:8765
```

(It needs a server instead of `file://` because browsers block ES modules loaded from local files.)

## Playing

- **Keys A–K** play notes (W E T Y U are the black keys). **Z / X** shift the octave. MIDI keyboards work after you click *Enable MIDI* on a Keyboard node.
- Drag from an **output dot** (right side of a node) to an **input dot** (left side). Only inputs that can accept the cable stay lit.
- Grab a **connected input** to pick its cable up and move it. **Click a wire** to cut it.
- Drag empty space to pan, pinch or ⌘-scroll to zoom. **Fit** frames everything.
- Double-click a slider to reset it. The patch autosaves to `localStorage`. Use **Export/Import** for JSON files.

## Signal types

| Kind  | Color  | What flows                                   | Implementation                                   |
|-------|--------|----------------------------------------------|--------------------------------------------------|
| audio | teal   | sound                                        | `AudioNode.connect(AudioNode)`                   |
| mod   | purple | control signals (LFO, envelope)              | AudioNode → `GainNode` (scale) → `AudioParam`    |
| note  | orange | `{type:'on'|'off', note, velocity, time}`    | JS callbacks routed by the Patch                 |

Audio can also go into a mod input, which gives you audio-rate FM. See the *FM bell* preset.
Note events carry an exact `AudioContext` time, so the sequencer and arpeggiator use a
lookahead scheduler and stay sample-accurate even though JS timers jitter.

## Code map

```
index.html, style.css
src/main.js     bootstrap: AudioContext, palette, toolbar, autosave
src/patch.js    model + engine: nodes, edges, note routing, (de)serialization
src/editor.js   the canvas: node cards, SVG wires, drag/connect/pan/zoom
src/nodes.js    ← the node registry; every module lives here
src/presets.js  starter patches (same JSON as Export)
src/util.js     helpers: mtof, lookahead clock, mod inputs, hyperscript
```

The editor never touches Web Audio. It only calls `patch.addNode / connect / setParam / ...`
and redraws from Patch events. That keeps the door open for other front ends later, such as
React, a canvas renderer, or multiplayer sync.

## Adding a node

Add an entry to `NODE_TYPES` in `src/nodes.js`. It shows up in the palette automatically:

```js
bitcrusher: {
  title: 'Bitcrusher', category: 'effect', description: 'Lo-fi sample reduction',
  inputs:  [{ id: 'in', kind: 'audio', label: 'in' }],
  outputs: [{ id: 'out', kind: 'audio', label: 'out' }],
  params:  [{ id: 'bits', label: 'Bits', kind: 'range', min: 1, max: 16, step: 1, default: 6 }],
  create(ctx, p, api) {
    // build Web Audio nodes; read live values from `p`
    return {
      inputs:  { in: someNode },          // AudioNode, or fn(ev) for note inputs
      outputs: { out: someOtherNode },    // use api.emit('notes', ev) for note outputs
      setParam(key, value) { /* react */ },
      dispose() { /* disconnect / stop */ },
    };
  },
  // optional: renderBody(el, { node, patch, instance }) => cleanupFn
},
```

Param kinds: `range` (with `log`, `step`, `unit`, `fmt`), `select`, `toggle`, and `custom`
(stored and saved, with no auto UI, for things like the sequencer's steps).

## Ideas for next steps

- **More modules:** sampler / drum voice, noise, chord generator, scale quantizer, probability gate, clock divider, Euclidean rhythm, sample & hold, bitcrusher (AudioWorklet), chorus, compressor, EQ.
- **Per-voice modulation:** mod inputs on Synth Voice currently affect all voices at once. A "voice-graph" sub-patch would give each note its own filter and envelope.
- **Macros / subpatches:** collapse a group of nodes into one reusable instrument with exposed knobs.
- **Global transport:** shared play/stop and swing, with nodes syncing to bar position instead of free-running.
- **Editor:** multi-select, copy/paste, undo/redo (the Patch event stream makes this straightforward), a minimap, cable "probe" scopes.
- **Sharing:** encode the patch JSON in a URL hash, or save to a backend.
