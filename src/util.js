// Small shared helpers: DOM building, music math, Web Audio utilities.

export const mtof = (n) => 440 * 2 ** ((n - 69) / 12);

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const noteName = (n) => NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Tiny hyperscript: h('div', { class: 'x', onclick: fn }, child, [children]) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c);
  return el;
}

/** True when a key event is aimed at a text field (so the keyboard node shouldn't play). */
export const isTyping = (t) =>
  t && ((t.tagName === 'INPUT' && /^(text|number|search)$/.test(t.type)) || t.tagName === 'TEXTAREA' || t.isContentEditable);

/**
 * A modulation input: a GainNode feeding an AudioParam. Whatever is connected to it is
 * multiplied by `scale` and added to the param. Mod sources output roughly -1..1 (LFO) or
 * 0..1 (envelope), so `scale` is "how far full modulation moves the param".
 */
export function modInput(ctx, param, scale) {
  const g = ctx.createGain();
  g.gain.value = scale;
  g.connect(param);
  return g;
}

/** Glide an AudioParam to a new value without zipper noise. */
export function smooth(ctx, param, value, tc = 0.015) {
  param.setTargetAtTime(value, ctx.currentTime, tc);
}

/** Freeze an envelope at time t so a new segment can start from wherever it is. */
export function holdAt(param, t) {
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t);
  else param.cancelScheduledValues(t); // Firefox fallback: may click slightly
}

/** Equal-power crossfade gains for a 0..1 wet mix. */
export const equalPower = (mix) => [Math.cos((mix * Math.PI) / 2), Math.sin((mix * Math.PI) / 2)];

/** Note divisions relative to a quarter-note beat. */
export const RATE_DIVS = { '1/4': 1, '1/8': 2, '1/8T': 3, '1/16': 4, '1/32': 8 };

/**
 * Lookahead clock (the "two clocks" pattern): a JS timer wakes every 25ms and schedules any
 * steps falling in the next ~120ms on the precise AudioContext timeline.
 * onStep(time, index) is called with the exact audio time of each step.
 */
export function createClock(ctx, stepDur, onStep) {
  let timer = null;
  let next = 0;
  let i = 0;
  const tick = () => {
    // If the tab was throttled we'd fall far behind; skip ahead instead of bursting notes.
    if (next < ctx.currentTime - 0.25) next = ctx.currentTime + 0.02;
    while (next < ctx.currentTime + 0.12) {
      onStep(next, i++);
      next += stepDur();
    }
  };
  return {
    start() {
      if (timer) return;
      next = ctx.currentTime + 0.02;
      i = 0;
      timer = setInterval(tick, 25);
      tick();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    get running() {
      return timer !== null;
    },
  };
}

/** Run fn at (roughly) the audio time t — for UI feedback like LEDs and playheads. */
export function atAudioTime(ctx, t, fn) {
  const ms = Math.max(0, (t - ctx.currentTime) * 1000);
  return setTimeout(fn, ms);
}
