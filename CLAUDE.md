# Audiotool: agent notes

A prototype node-based instrument builder that runs in the browser. Users patch modules
(sources, note FX, sound generators, modulators, effects) together with typed cables and
play the result. Read `README.md` for the user-facing overview and the "add a node" example.

## Status (as of 2026-11-11)

This is a working prototype. All 14 node types and 4 presets work. Verified in Chromium:
- every preset produces sound at the Output node
- mouse drag-to-connect and node removal work
- `toJSON()` → `load()` round-trips exactly

Not verified: real MIDI hardware, Safari, Firefox. There are no automated tests yet.

## Run

```bash
python3 -m http.server 8765   # open http://localhost:8765
```

`.claude/launch.json` defines this server as `audiotool` for preview tools. There's no build
step, no package.json and no dependencies: just native ES modules and the Web Audio API.
Keep it that way unless a change clearly needs a bundler.

## Architecture (the one rule to keep)

```
editor.js  ──calls──▶  patch.js  ──owns──▶  node instances (nodes.js) ──▶ Web Audio
    ▲                      │
    └──── events ──────────┘   node-add | node-remove | edge-add | edge-remove | param | activity | change | load
```

- **The editor never touches Web Audio.** It calls `patch.addNode / removeNode / connect /
  disconnect / setParam / moveNode` and re-renders from Patch events. This makes undo/redo,
  alternative front ends or multiplayer easy to add later, so don't break it.
- **`src/nodes.js` is the registry.** Each node type is one self-contained object (ports,
  params, `create()`, optional `renderBody()`). The palette and the generic param UI are
  generated from it. The header comment in that file documents the full instance contract.
- **`node.params` is the live, persisted object** that `create()` receives as `p`. Read from
  it at play time. Use `setParam` only for side effects (for example, retuning a running oscillator).

### Signal kinds
- `audio`: `src.outputs[port].connect(dst.inputs[port])`.
- `mod`: the destination input is a `GainNode` made by `modInput(ctx, param, scale)` that
  feeds an `AudioParam`. Sources output about -1..1 (LFO) or 0..1 (envelope). `scale` sets
  how far full modulation moves the param (filter cutoff: 2400 cents = ±2 octaves).
- `note`: `api.emit(port, {type:'on'|'off', note, velocity, time})`. The Patch calls each
  connected input function. `time` is on the AudioContext clock and **may be in the future**
  (the sequencer and arp schedule about 120 ms ahead using `createClock` in `util.js`).
  Receivers must schedule at `Math.max(ev.time, ctx.currentTime)`.
- An `audio` output may feed a `mod` input (audio-rate FM). See `compatible()` in patch.js.

### Conventions
- Envelope retriggers use `holdAt(param, t)` (`cancelAndHoldAtTime` with a Firefox fallback)
  before scheduling new segments.
- Param changes go through `smooth()` (setTargetAtTime) to avoid zipper noise.
- Implement `allOff()` on anything that holds notes. Panic and note-cable disconnects call it.
- Implement `dispose()` to stop sources and disconnect nodes. `onBpm(bpm)` is optional.
- Node IDs look like `n<number>` (presets use readable IDs like `kb` and `v`). Edge ID is
  `from.node.port>to.node.port`.
- Style: 2-space indent, single quotes, no framework. The small `h()` helper in util.js builds DOM.

## Verifying changes

`window.audiotool = { ctx, patch, editor }` is exposed for debugging. Pattern used so far:

```js
const { patch, ctx } = window.audiotool;
await ctx.resume();
patch.nodes.get('kb').instance.play(60, true);          // or patch.setParam('seq','running',true)
await new Promise(r => setTimeout(r, 600));
const an = [...patch.nodes.values()].find(n => n.type === 'output').instance.analyser;
const d = new Float32Array(2048); an.getFloatTimeDomainData(d);
Math.max(...d.map(Math.abs));                             // > 0 means sound reached the output
```

Gotchas:
- The AudioContext starts suspended until a user gesture. `main.js` resumes it on the first pointer or key event.
- The patch autosaves to `localStorage['audiotool:v1']` and reloads it on start. Clear it
  (or load a preset) when you need a known starting state.
- Background tabs throttle `setInterval`, so sequencers stutter when the tab is hidden. That's expected for now.
- Every Keyboard node listens to global key events, so two Keyboard nodes both play.

## Known limitations / suggested next tasks (rough priority)

1. **Per-voice modulation.** Mod inputs on Synth Voice (and filters after it) affect all
   voices at once. Idea: a "voice" sub-graph instantiated per note.
2. **Undo/redo**, multi-select, copy/paste. Build these on the Patch event stream.
3. **Global transport.** Shared play/stop, swing, bar position. The sequencer and arp currently free-run.
4. **More modules:** sampler/drums, noise, scale quantizer, chord generator, Euclidean
   rhythm, sample & hold, AudioWorklet bitcrusher, chorus, EQ, compressor.
5. **Macros/subpatches.** Collapse a node group into one instrument with exposed knobs.
6. **Tests.** Patch logic (connect rules, serialization) is testable headlessly with a
   mocked AudioContext. Nothing exists yet.
7. **Share via URL** (patch JSON in the hash).

## File map

```
index.html        toolbar, palette, viewport, footer legend
style.css         dark theme; category colors --cat-*, signal colors --audio/--note/--mod
src/main.js       bootstrap, palette, toolbar, presets menu, import/export, autosave
src/patch.js      model + engine
src/editor.js     node cards, SVG wires, drag/connect/pan/zoom, generic param controls
src/nodes.js      node registry (all modules)
src/presets.js    starter patches (same JSON as Export)
src/util.js       mtof, noteName, h(), modInput, smooth, holdAt, createClock, RATE_DIVS
```
