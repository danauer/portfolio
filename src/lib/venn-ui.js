// Interactive copy of the Venn plugin's interface, for the /venn page.
//
// This is the plugin's own UI code (ui/main.js in the plugin project) with the
// audio side removed: the controls drive stand-in parameters and make no sound.
// The theme switch is wired to the site's theme instead of the plugin's
// settings file, so toggling it re-themes the whole page.

// ---------------------------------------------------------------------------
// Parameters. Ranges, defaults and formats mirror the plugin.

const fmt = {
  ms: (v) => `${v.toFixed(1)} ms`,
  pct: (v) => `${Math.round(v)}%`,
  hz: (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`),
  db: (v) => `${v > 0.05 ? '+' : ''}${v.toFixed(1)} dB`,
  dbOff: (v) => (v <= -40 ? 'Off' : fmt.db(v)),
};

// centre: the value at the middle of the control (gives a curved scale).
// fillFrom: where the fill starts: "start" (default), "end", or a value such as 0 dB.
const PARAMS = {
  time:    { start: 1,    end: 100,   centre: 20,   def: 18,   format: fmt.ms },
  wobble:  { start: 0,    end: 100,                 def: 20,   format: fmt.pct },
  width:   { start: 0,    end: 100,                 def: 50,   format: fmt.pct },
  drive:   { start: 0,    end: 100,                 def: 25,   format: fmt.pct },
  lowCut:  { start: 20,   end: 1000,  centre: 150,  def: 120,  format: fmt.hz },
  highCut: { start: 1000, end: 20000, centre: 5000, def: 9000, format: fmt.hz, fillFrom: 'end' },
  double:  { start: -40,  end: 6,                   def: -3,   format: fmt.dbOff },
  gain:    { start: -48,  end: 12,                  def: 0,    format: fmt.db, fillFrom: 0 },
};

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** Same curve as JUCE's NormalisableRange::setSkewForCentre. */
const skewOf = ({ start, end, centre }) =>
  centre === undefined ? 1 : Math.log(0.5) / Math.log((centre - start) / (end - start));

const toNorm = (id, scaled) => {
  const p = PARAMS[id];
  return Math.pow(clamp01((scaled - p.start) / (p.end - p.start)), skewOf(p));
};
const toScaled = (id, norm) => {
  const p = PARAMS[id];
  return p.start + (p.end - p.start) * Math.pow(clamp01(norm), 1 / skewOf(p));
};

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

let uid = 0;

/**
 * Builds the plugin UI inside `root` (the .venn-ui element, already containing
 * the markup from VennPlugin.astro). Returns a function that undoes everything
 * that was attached outside `root`.
 */
export function mountVenn(root) {
  const abort = new AbortController();
  const { signal } = abort;
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => root.querySelectorAll(sel);

  // -------------------------------------------------------------------------
  // State: one value per parameter, shared by every view of it (e.g. the Time
  // slider and the Venn circles).

  const norms = Object.fromEntries(Object.keys(PARAMS).map((id) => [id, toNorm(id, PARAMS[id].def)]));
  const views = new Map(Object.keys(PARAMS).map((id) => [id, new Set()]));

  const getNorm = (id) => norms[id];
  const getScaled = (id) => toScaled(id, norms[id]);
  function setNorm(id, n) {
    norms[id] = clamp01(n);
    views.get(id).forEach((render) => render());
  }
  function watch(id, render) {
    views.get(id).add(render);
    render();
  }

  // -------------------------------------------------------------------------
  // Shared interaction for knobs, sliders and faders: drag, Shift for fine
  // control, double-click to reset, scroll wheel, arrow keys.
  //
  //   axis:           "y" for knobs and faders (drag up/down), "x" for sliders.
  //   pixelsPerRange: drag distance that sweeps the full range.
  //   jumpTo(e):      optional; returns a 0..1 position to jump to when the
  //                   control is pressed (clicking a track), or null.

  function bindControl(el, id, { axis, pixelsPerRange, jumpTo }) {
    const pos = (e) => (axis === 'x' ? e.clientX : -e.clientY);
    let last = 0;
    let dragNorm = 0;

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      el.focus({ preventScroll: true });
      dragNorm = getNorm(id);
      const jump = !e.shiftKey && jumpTo ? jumpTo(e) : null;
      if (jump !== null) {
        dragNorm = clamp01(jump);
        setNorm(id, dragNorm);
      }
      last = pos(e);
    });

    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const sensitivity = e.shiftKey ? 0.1 : 1;
      dragNorm = clamp01(dragNorm + ((pos(e) - last) / pixelsPerRange()) * sensitivity);
      last = pos(e);
      setNorm(id, dragNorm);
    });

    const endDrag = (e) => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);

    el.addEventListener('dblclick', () => setNorm(id, toNorm(id, PARAMS[id].def)));

    // Only take over the wheel while the pointer is over a control that's focused
    // by interaction, so scrolling the page past the demo still works.
    el.addEventListener(
      'wheel',
      (e) => {
        if (document.activeElement !== el) return;
        e.preventDefault();
        const delta = axis === 'x' && Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : -e.deltaY;
        setNorm(id, getNorm(id) + (e.shiftKey ? 0.002 : 0.01) * Math.sign(delta));
      },
      { passive: false },
    );

    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.002 : 0.01;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') setNorm(id, getNorm(id) + step);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') setNorm(id, getNorm(id) - step);
      else return;
      e.preventDefault();
    });
  }

  // -------------------------------------------------------------------------
  // Knobs

  const START_ANGLE = -135; // 7:30
  const END_ANGLE = 135; // 4:30
  const CX = 50, CY = 50, R = 40;

  function polar(angleDeg, radius = R) {
    const a = (angleDeg - 90) * (Math.PI / 180);
    return [CX + radius * Math.cos(a), CY + radius * Math.sin(a)];
  }

  function arc(fromDeg, toDeg) {
    const [x1, y1] = polar(fromDeg);
    const [x2, y2] = polar(toDeg);
    const large = toDeg - fromDeg > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2}`;
  }

  const normToAngle = (n) => START_ANGLE + n * (END_ANGLE - START_ANGLE);

  function createKnob(host) {
    const id = host.dataset.param;
    const config = PARAMS[id];

    const dial = document.createElement('div');
    dial.className = 'dial';
    dial.tabIndex = 0;
    dial.setAttribute('role', 'slider');
    dial.setAttribute('aria-label', host.dataset.label);

    const svg = svgEl('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' });
    const track = svgEl('path', { class: 'track', d: arc(START_ANGLE, END_ANGLE) });
    const tick = svgEl('line', { class: 'origin-tick' });
    const fill = svgEl('path', { class: 'fill' });
    const cap = svgEl('circle', { class: 'cap', cx: CX, cy: CY, r: 29 });
    const pointer = svgEl('line', { class: 'pointer', x1: CX, y1: CY, x2: CX, y2: 25 });
    svg.append(track, fill, cap, pointer);
    if (typeof config.fillFrom === 'number') svg.insertBefore(tick, fill); // only centre-origin knobs get a tick
    dial.append(svg);

    const label = document.createElement('div');
    label.className = 'knob-label';
    label.textContent = host.dataset.label;

    const value = document.createElement('div');
    value.className = 'knob-value';

    host.append(dial, label, value);

    watch(id, () => {
      const angle = normToAngle(getNorm(id));

      // Origin of the coloured arc.
      const from = config.fillFrom;
      const originAngle =
        from === 'end' ? END_ANGLE : typeof from === 'number' ? normToAngle(toNorm(id, from)) : START_ANGLE;
      const [a, b] = angle >= originAngle ? [originAngle, angle] : [angle, originAngle];
      fill.setAttribute('d', b - a < 0.5 ? '' : arc(a, b));
      fill.classList.toggle('cut', typeof from === 'number' && angle < originAngle);

      if (typeof from === 'number') {
        const [x1, y1] = polar(originAngle, R + 6);
        const [x2, y2] = polar(originAngle, R + 10);
        Object.entries({ x1, y1, x2, y2 }).forEach(([k, v]) => tick.setAttribute(k, v));
      }

      pointer.setAttribute('transform', `rotate(${angle} ${CX} ${CY})`);
      const text = config.format(getScaled(id));
      value.textContent = text;
      dial.setAttribute('aria-valuetext', text);
    });

    bindControl(dial, id, { axis: 'y', pixelsPerRange: () => 200 });
  }

  // -------------------------------------------------------------------------
  // Sliders. The track's shape illustrates the parameter:
  //   line  – plain (Time)
  //   wave  – straight on the left, increasingly wavy to the right (Wobble)
  //   wedge – thin on the left, widening to the right (Width)

  const TRACK_W = 220, TRACK_H = 16, TRACK_PAD = 6; // pad = handle radius, so it never overhangs
  const MID = TRACK_H / 2;
  const TRACK_SPAN = TRACK_W - 2 * TRACK_PAD;

  const trackShapes = {
    line: {
      stroked: true,
      strokeWidth: 2.5,
      path: () => `M ${TRACK_PAD} ${MID} L ${TRACK_W - TRACK_PAD} ${MID}`,
      yAt: () => MID,
    },
    wave: {
      stroked: true,
      strokeWidth: 1.6,
      // Amplitude grows from 0 (left) to 4.5 px (right); wavelength 14 px.
      yAt: (x) => {
        const t = Math.max(0, (x - TRACK_PAD) / TRACK_SPAN);
        return MID + 4.5 * Math.pow(t, 1.3) * Math.sin(((x - TRACK_PAD) / 14) * 2 * Math.PI);
      },
      path() {
        let d = `M ${TRACK_PAD} ${MID}`;
        for (let x = TRACK_PAD + 1; x <= TRACK_W - TRACK_PAD; x += 1) d += ` L ${x} ${this.yAt(x).toFixed(2)}`;
        return d;
      },
    },
    wedge: {
      stroked: false,
      // Thickness grows from 1.2 px (left) to 7 px (right), rounded ends.
      path: () => {
        const l = 0.6, r = 3.5, x0 = TRACK_PAD, x1 = TRACK_W - TRACK_PAD;
        return (
          `M ${x0} ${MID - l} L ${x1} ${MID - r} A ${r} ${r} 0 0 1 ${x1} ${MID + r} ` +
          `L ${x0} ${MID + l} A ${l} ${l} 0 0 1 ${x0} ${MID - l} Z`
        );
      },
      yAt: () => MID,
    },
  };

  function createSlider(host) {
    const id = host.dataset.param;
    const config = PARAMS[id];
    const shape = trackShapes[host.dataset.track] ?? trackShapes.line;

    const head = document.createElement('div');
    head.className = 'slider-head';
    const label = document.createElement('span');
    label.className = 'slider-label';
    label.textContent = host.dataset.label;
    const value = document.createElement('span');
    value.className = 'slider-value';
    head.append(label, value);

    const track = document.createElement('div');
    track.className = 'slider-track';
    track.tabIndex = 0;
    track.setAttribute('role', 'slider');
    track.setAttribute('aria-label', host.dataset.label);

    const svg = svgEl('svg', { width: TRACK_W, height: TRACK_H, viewBox: `0 0 ${TRACK_W} ${TRACK_H}`, 'aria-hidden': 'true' });
    const clipId = `venn-slider-clip-${++uid}`;
    const clipRect = svgEl('rect', { x: 0, y: -4, height: TRACK_H + 8, width: 0 });
    const clip = svgEl('clipPath', { id: clipId });
    clip.append(clipRect);
    const defs = svgEl('defs');
    defs.append(clip);

    const d = shape.path();
    const stroke = shape.stroked ? { 'stroke-width': shape.strokeWidth } : {};
    const bg = svgEl('path', { class: `slider-bg${shape.stroked ? ' stroked' : ''}`, d, ...stroke });
    const fill = svgEl('path', { class: `slider-fill${shape.stroked ? ' stroked' : ''}`, d, ...stroke, 'clip-path': `url(#${clipId})` });
    const thumb = svgEl('circle', { class: 'slider-thumb', r: TRACK_PAD });
    svg.append(defs, bg, fill, thumb);
    track.append(svg);
    host.append(head, track);

    const xFor = (norm) => TRACK_PAD + norm * TRACK_SPAN;

    watch(id, () => {
      const x = xFor(getNorm(id));
      clipRect.setAttribute('width', x);
      thumb.setAttribute('cx', x);
      thumb.setAttribute('cy', shape.yAt(x)); // the handle rides the wave
      const text = config.format(getScaled(id));
      value.textContent = text;
      track.setAttribute('aria-valuetext', text);
    });

    bindControl(track, id, {
      axis: 'x',
      pixelsPerRange: () => TRACK_SPAN,
      // Clicking the track jumps there; grabbing the handle keeps it where it is.
      jumpTo: (e) => {
        const x = e.clientX - track.getBoundingClientRect().left;
        if (Math.abs(x - xFor(getNorm(id))) <= TRACK_PAD + 2) return null;
        return (x - TRACK_PAD) / TRACK_SPAN;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Faders (vertical sliders). Fill rises from the bottom, or from a centre
  // value like 0 dB, where a small tick marks the origin and anything below
  // it is drawn in the "cut" colour.

  const FADER_W = 24, FADER_H = 180, FADER_PAD = 6; // pad = handle radius
  const FADER_SPAN = FADER_H - 2 * FADER_PAD;
  const FX = FADER_W / 2;

  function createFader(host) {
    const id = host.dataset.param;
    const config = PARAMS[id];
    const centred = typeof config.fillFrom === 'number';

    const label = document.createElement('div');
    label.className = 'fader-label';
    label.textContent = host.dataset.label;

    const track = document.createElement('div');
    track.className = 'fader-track';
    track.tabIndex = 0;
    track.setAttribute('role', 'slider');
    track.setAttribute('aria-orientation', 'vertical');
    track.setAttribute('aria-label', host.dataset.label);

    const value = document.createElement('div');
    value.className = 'fader-value';

    const svg = svgEl('svg', { width: FADER_W, height: FADER_H, viewBox: `0 0 ${FADER_W} ${FADER_H}`, 'aria-hidden': 'true' });
    const line = { x1: FX, x2: FX, 'stroke-width': 2.5 };
    const bg = svgEl('line', { class: 'slider-bg stroked', ...line, y1: FADER_PAD, y2: FADER_H - FADER_PAD });
    const fill = svgEl('line', { class: 'slider-fill stroked', ...line });
    const ticks = svgEl('path', { class: 'origin-tick' });
    const thumb = svgEl('circle', { class: 'slider-thumb', cx: FX, r: FADER_PAD });
    svg.append(bg, ...(centred ? [ticks] : []), fill, thumb);
    track.append(svg);
    host.append(label, track, value);

    const yFor = (norm) => FADER_H - FADER_PAD - norm * FADER_SPAN;

    watch(id, () => {
      const y = yFor(getNorm(id));
      const originY = centred ? yFor(toNorm(id, config.fillFrom)) : FADER_H - FADER_PAD;
      fill.setAttribute('y1', originY);
      fill.setAttribute('y2', y);
      fill.style.visibility = Math.abs(y - originY) < 0.5 ? 'hidden' : 'visible'; // no stray round cap at zero length
      fill.classList.toggle('cut', centred && y > originY);
      if (centred) ticks.setAttribute('d', `M 1 ${originY} H 4 M ${FADER_W - 4} ${originY} H ${FADER_W - 1}`);
      thumb.setAttribute('cy', y);
      const text = config.format(getScaled(id));
      value.textContent = text;
      track.setAttribute('aria-valuetext', text);
    });

    bindControl(track, id, {
      axis: 'y',
      pixelsPerRange: () => FADER_SPAN,
      jumpTo: (e) => {
        const y = e.clientY - track.getBoundingClientRect().top;
        if (Math.abs(y - yFor(getNorm(id))) <= FADER_PAD + 2) return null;
        return (FADER_H - FADER_PAD - y) / FADER_SPAN;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Venn: the original (left) and the double (right). Overlapping at the
  // shortest Time, separating as Time grows, fully apart at the longest.

  function createVenn(host) {
    const W = 220, H = 104, r = 44;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}` });
    const dry = svgEl('circle', { class: 'venn-dry', r, cy: H / 2 });
    const dbl = svgEl('circle', { class: 'venn-double', r, cy: H / 2 });

    // Overlap = the double's circle, clipped to the original's circle.
    const clipId = `venn-overlap-clip-${++uid}`;
    const clip = svgEl('clipPath', { id: clipId });
    const clipCircle = svgEl('circle', { r, cy: H / 2 });
    clip.append(clipCircle);
    const defs = svgEl('defs');
    defs.append(clip);
    const overlap = svgEl('circle', { class: 'venn-overlap', r, cy: H / 2, 'clip-path': `url(#${clipId})` });

    svg.append(defs, dry, overlap, dbl);
    host.append(svg);

    const minGap = 12, maxGap = 2 * r + 20; // distance between centres
    watch('time', () => {
      const gap = minGap + getNorm('time') * (maxGap - minGap);
      const left = W / 2 - gap / 2, right = W / 2 + gap / 2;
      dry.setAttribute('cx', left);
      clipCircle.setAttribute('cx', left);
      dbl.setAttribute('cx', right);
      overlap.setAttribute('cx', right);
    });
  }

  $$('.knob[data-param]').forEach(createKnob);
  $$('.slider[data-param]').forEach(createSlider);
  $$('.fader[data-param]').forEach(createFader);
  createVenn($('.venn'));

  // -------------------------------------------------------------------------
  // EQ position: Pre/Post toggle, which also reorders the modules on screen.

  const chain = $('[data-tone-chain]');
  const movingModules = [$('.mod-sat'), $('.mod-tone')];
  const segButtons = $$('[data-eq-position] button');
  let eqPre = false;

  function renderEqPosition({ animate }) {
    segButtons.forEach((b) => b.setAttribute('aria-checked', String((b.dataset.pre === 'true') === eqPre)));
    if (chain.classList.contains('eq-pre') === eqPre) return;

    // FLIP: measure, reorder, then animate each module from its old spot.
    const before = movingModules.map((m) => m.getBoundingClientRect().top);
    chain.classList.toggle('eq-pre', eqPre);
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    movingModules.forEach((m, i) => {
      const dy = before[i] - m.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) return;
      m.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
        { duration: 280, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
    });
  }

  segButtons.forEach((b) =>
    b.addEventListener('click', () => {
      eqPre = b.dataset.pre === 'true';
      renderEqPosition({ animate: true });
    }),
  );
  renderEqPosition({ animate: false });

  // -------------------------------------------------------------------------
  // Theme: Auto / Light / Dark. Uses the same storage and attribute as the
  // site's own switch (ThemeToggle.astro), so the whole page follows. The
  // colours need no JavaScript: they're light-dark() values keyed off the
  // page's color-scheme.

  const html = document.documentElement;
  const themeButtons = $$('[data-theme-switch] button');

  const syncTheme = () => {
    const current = html.dataset.theme ?? 'auto';
    themeButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeChoice === current)));
  };

  let switchTimer;
  themeButtons.forEach((b) =>
    b.addEventListener('click', () => {
      const choice = b.dataset.themeChoice;
      if (choice === (html.dataset.theme ?? 'auto')) return;

      // Cross-fade the colours, only while switching.
      html.classList.add('theme-switching');
      clearTimeout(switchTimer);
      switchTimer = setTimeout(() => html.classList.remove('theme-switching'), 300);

      if (choice === 'auto') {
        delete html.dataset.theme;
        localStorage.removeItem('theme');
      } else {
        html.dataset.theme = choice;
        localStorage.setItem('theme', choice);
      }
      syncTheme(); // the site's own switch listens for the attribute change
    }),
  );

  // The sidebar switch changes the same attribute; keep this one in step with it.
  const observer = new MutationObserver(syncTheme);
  observer.observe(html, { attributes: true, attributeFilter: ['data-theme'] });
  syncTheme();

  // -------------------------------------------------------------------------
  // Tips popover: the info icon toggles it; clicking elsewhere or Escape closes it.

  const tipsButton = $('.tips-button');
  const setTipsOpen = (open) => tipsButton.setAttribute('aria-expanded', String(open));

  tipsButton.addEventListener('click', () => setTipsOpen(tipsButton.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.tips')) setTipsOpen(false); }, { signal });
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && tipsButton.getAttribute('aria-expanded') === 'true') {
        setTipsOpen(false);
        tipsButton.focus();
      }
    },
    { signal },
  );

  // -------------------------------------------------------------------------
  // Presets: the page can set the controls, e.g. its "try a starting point" button.

  root.addEventListener('venn:preset', (e) => {
    const { values = {}, eqPre: pre } = e.detail ?? {};
    for (const [id, scaled] of Object.entries(values)) if (id in PARAMS) setNorm(id, toNorm(id, scaled));
    if (typeof pre === 'boolean') {
      eqPre = pre;
      renderEqPosition({ animate: true });
    }
  });

  return () => {
    abort.abort();
    observer.disconnect();
    clearTimeout(switchTimer);
  };
}
