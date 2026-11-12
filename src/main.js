// App bootstrap: audio context, patch, editor, palette, toolbar, persistence.

import { Patch } from './patch.js';
import { Editor } from './editor.js';
import { NODE_TYPES, CATEGORIES } from './nodes.js';
import { PRESETS } from './presets.js';
import { h } from './util.js';

const STORAGE_KEY = 'patchbay:v1';
const $ = (s) => document.querySelector(s);

// Browsers start AudioContexts suspended until a user gesture; we resume on the first one.
const ctx = new AudioContext({ latencyHint: 'interactive' });
const patch = new Patch(ctx, NODE_TYPES);
const editor = new Editor($('#viewport'), patch);
window.patchbay = { ctx, patch, editor }; // handy for poking at things in devtools

// ---- audio on/off status ----------------------------------------------------
const status = $('#audio-status');
const updateStatus = () => {
  const on = ctx.state === 'running';
  status.textContent = on ? '● Audio on' : '○ Audio off · click anywhere';
  status.classList.toggle('on', on);
};
ctx.onstatechange = updateStatus;
updateStatus();
const wake = () => ctx.state !== 'running' && ctx.resume();
window.addEventListener('pointerdown', wake, true);
window.addEventListener('keydown', wake, true);

// ---- palette ----------------------------------------------------------------
const palette = $('#palette');
for (const cat of CATEGORIES) {
  const types = Object.entries(NODE_TYPES).filter(([, d]) => d.category === cat.id);
  palette.append(
    h('h3', {}, cat.label),
    ...types.map(([type, def]) =>
      h(
        'button',
        {
          class: `cat-${def.category}`,
          onclick: () => {
            const c = editor.viewCenter();
            const jitter = () => Math.round((Math.random() - 0.5) * 120);
            const n = patch.addNode(type, { x: Math.round(c.x - 110 + jitter()), y: Math.round(c.y - 100 + jitter()) });
            if (!n) flashMessage(`Only one ${def.title} per patch`);
          },
        },
        def.title,
        h('small', {}, def.description),
      ),
    ),
  );
}

// ---- toolbar ----------------------------------------------------------------
const bpm = $('#bpm');
bpm.onchange = () => {
  const v = Math.min(300, Math.max(20, +bpm.value || 110));
  bpm.value = v;
  patch.setBpm(v);
};
patch.on((t) => t === 'load' && (bpm.value = patch.bpm));

const presetSel = $('#preset');
PRESETS.forEach((p, i) => presetSel.append(h('option', { value: i }, p.name)));
presetSel.onchange = () => {
  if (presetSel.value === '') return;
  loadPatch(PRESETS[+presetSel.value].patch);
  presetSel.value = '';
  presetSel.blur();
};

$('#panic').onclick = () => patch.panic();
$('#fit').onclick = () => editor.fitView();

$('#export').onclick = () => {
  const blob = new Blob([JSON.stringify(patch.toJSON(), null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: 'patch.json' });
  a.click();
  URL.revokeObjectURL(a.href);
};
const file = $('#import-file');
$('#import').onclick = () => file.click();
file.onchange = async () => {
  const f = file.files[0];
  if (!f) return;
  try {
    loadPatch(JSON.parse(await f.text()));
  } catch (err) {
    flashMessage(`Couldn't load that file: ${err.message}`);
  }
  file.value = '';
};

function loadPatch(json) {
  patch.load(json);
  requestAnimationFrame(() => editor.fitView());
}

function flashMessage(msg) {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(flashMessage.t);
  flashMessage.t = setTimeout(() => toast.classList.remove('show'), 2200);
}

// ---- persistence (autosave to this browser) -----------------------------------
let saveTimer;
patch.on((t) => {
  if (t !== 'change') return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(patch.toJSON()));
    } catch {
      /* storage unavailable — fine */
    }
  }, 400);
});

let saved = null;
try {
  saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
} catch {
  /* ignore */
}
try {
  loadPatch(saved?.nodes?.length ? saved : PRESETS[0].patch);
} catch (err) {
  console.error('Saved patch failed to load, using default', err);
  loadPatch(PRESETS[0].patch);
}
