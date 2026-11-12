// Node-graph editor: renders the Patch as draggable cards + SVG wires.
// It mirrors Patch events (node-add, edge-add, ...) and calls Patch methods on user input.

import { h, clamp } from './util.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const GRID = 10;

export class Editor {
  constructor(viewport, patch) {
    this.vp = viewport;
    this.patch = patch;
    this.view = { x: 0, y: 0, k: 1 };
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.classList.add('wires');
    this.g = document.createElementNS(SVGNS, 'g');
    this.svg.append(this.g);
    this.world = h('div', { class: 'world' });
    this.vp.append(this.svg, this.world);

    this.nodeEls = new Map(); // id -> { el, led, ports: { in: {id: {row, dot}}, out: {...} }, sync, cleanup }
    this.wireEls = new Map(); // edge id -> path
    this.z = 1;
    this.drag = null;
    this._raf = 0;
    this.resizeObs = new ResizeObserver(() => this.redrawWires());

    patch.on((type, d) => this.onPatch(type, d));
    this.bindInput();
    this.applyView();
  }

  onPatch(type, d) {
    if (type === 'node-add') this.addNodeEl(d);
    else if (type === 'node-remove') this.removeNodeEl(d);
    else if (type === 'edge-add') this.addWire(d);
    else if (type === 'edge-remove') this.removeWire(d);
    else if (type === 'param') this.nodeEls.get(d.node.id)?.sync[d.key]?.(d.value);
    else if (type === 'activity') this.flash(d.nodeId, d.delay);
  }

  // ---- coordinates ---------------------------------------------------------
  clientToWorld(cx, cy) {
    const r = this.vp.getBoundingClientRect();
    return { x: (cx - r.left - this.view.x) / this.view.k, y: (cy - r.top - this.view.y) / this.view.k };
  }
  portPos(nodeId, dir, portId) {
    const dot = this.nodeEls.get(nodeId)?.ports[dir][portId]?.dot;
    if (!dot) return { x: 0, y: 0 };
    const r = dot.getBoundingClientRect();
    return this.clientToWorld(r.left + r.width / 2, r.top + r.height / 2);
  }
  applyView() {
    const { x, y, k } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    this.g.setAttribute('transform', `translate(${x} ${y}) scale(${k})`);
    this.vp.style.backgroundPosition = `${x}px ${y}px`;
    this.vp.style.backgroundSize = `${20 * k}px ${20 * k}px`;
  }
  /** Center of the visible area, in world coords — where new nodes get dropped. */
  viewCenter() {
    const r = this.vp.getBoundingClientRect();
    return this.clientToWorld(r.left + r.width / 2, r.top + r.height / 2);
  }
  fitView() {
    const nodes = [...this.patch.nodes.values()];
    const r = this.vp.getBoundingClientRect();
    if (!nodes.length) {
      this.view = { x: 40, y: 40, k: 1 };
      return this.applyView();
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      const el = this.nodeEls.get(n.id).el;
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + el.offsetWidth);
      y1 = Math.max(y1, n.y + el.offsetHeight);
    }
    const pad = 40;
    const k = clamp(Math.min((r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0)), 0.35, 1);
    this.view = { k, x: (r.width - (x1 - x0) * k) / 2 - x0 * k, y: (r.height - (y1 - y0) * k) / 2 - y0 * k };
    this.applyView();
    this.redrawWires();
  }

  // ---- nodes ---------------------------------------------------------------
  addNodeEl(node) {
    const { def } = node;
    const ports = { in: {}, out: {} };
    const portRow = (port, dir) => {
      const dot = h('span', { class: 'dot' });
      const label = h('span', { class: 'plabel' }, port.label ?? port.id);
      const row = h(
        'div',
        { class: `port ${dir} kind-${port.kind}`, 'data-node': node.id, 'data-port': port.id, title: `${port.kind} ${dir === 'in' ? 'input' : 'output'}` },
        dir === 'in' ? [dot, label] : [label, dot],
      );
      row.addEventListener('pointerdown', (e) => this.portDown(e, node, port, dir));
      ports[dir][port.id] = { row, dot };
      return row;
    };

    const led = h('span', { class: 'led' });
    const close = h('button', { class: 'close', title: 'Remove node' }, '×');
    close.addEventListener('pointerdown', (e) => e.stopPropagation());
    close.addEventListener('click', () => this.patch.removeNode(node.id));
    const header = h('div', { class: 'header' }, led, h('span', { class: 'title' }, def.title), close);
    header.addEventListener('pointerdown', (e) => this.nodeDown(e, node));

    const portsEl =
      def.inputs.length || def.outputs.length
        ? h('div', { class: 'ports' },
            h('div', { class: 'col' }, def.inputs.map((p) => portRow(p, 'in'))),
            h('div', { class: 'col right' }, def.outputs.map((p) => portRow(p, 'out'))))
        : null;

    const sync = {};
    const body = h('div', { class: 'body' }, def.params.filter((p) => p.kind !== 'custom').map((p) => this.control(node, p, sync)));
    let cleanup = null;
    if (def.renderBody) {
      const custom = h('div', { class: 'custom' });
      body.append(custom);
      cleanup = def.renderBody(custom, { node, patch: this.patch, instance: node.instance });
    }

    const el = h('div', { class: `node cat-${def.category}`, 'data-id': node.id }, header, portsEl, body);
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    el.style.zIndex = ++this.z;
    el.addEventListener('pointerdown', () => (el.style.zIndex = ++this.z), true);
    this.world.append(el);
    this.nodeEls.set(node.id, { el, led, ports, sync, cleanup });
    this.resizeObs.observe(el);
  }

  removeNodeEl(node) {
    const n = this.nodeEls.get(node.id);
    if (!n) return;
    n.cleanup?.();
    this.resizeObs.unobserve(n.el);
    n.el.remove();
    this.nodeEls.delete(node.id);
  }

  /** Build a generic control row for a param definition. */
  control(node, p, sync) {
    const set = (v) => this.patch.setParam(node.id, p.id, v);
    const name = h('span', { class: 'pname' }, p.label);

    if (p.kind === 'select') {
      const sel = h('select', {}, p.options.map((o) => h('option', { value: o }, o)));
      sel.value = node.params[p.id];
      sel.onchange = () => {
        set(sel.value);
        sel.blur(); // so letter keys go back to the keyboard node
      };
      sync[p.id] = (v) => (sel.value = v);
      return h('div', { class: 'param' }, name, sel);
    }

    if (p.kind === 'toggle') {
      const btn = h('button', { class: 'toggle' });
      const show = (v) => {
        btn.textContent = p.labels ? p.labels[v ? 1 : 0] : v ? 'On' : 'Off';
        btn.classList.toggle('on', !!v);
      };
      btn.onclick = () => set(!node.params[p.id]);
      show(node.params[p.id]);
      sync[p.id] = show;
      return h('div', { class: 'param' }, name, btn);
    }

    // range: slider runs 0..1000 internally, mapped linearly or logarithmically
    const toS = (v) => 1000 * (p.log ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min));
    const fromS = (s) => {
      let v = p.log ? p.min * (p.max / p.min) ** (s / 1000) : p.min + ((p.max - p.min) * s) / 1000;
      if (p.step) v = Math.round(v / p.step) * p.step;
      return v;
    };
    const input = h('input', { type: 'range', min: 0, max: 1000, step: 1, title: 'Double-click to reset' });
    const val = h('span', { class: 'val' });
    const show = (v) => {
      input.value = toS(v);
      val.textContent = fmt(p, v);
    };
    input.oninput = () => set(fromS(+input.value));
    input.ondblclick = () => set(p.default);
    show(node.params[p.id]);
    sync[p.id] = show;
    return h('div', { class: 'param' }, name, input, val);
  }

  flash(nodeId, delay = 0) {
    const n = this.nodeEls.get(nodeId);
    if (!n) return;
    setTimeout(() => {
      n.led.classList.add('on');
      clearTimeout(n.ledTimer);
      n.ledTimer = setTimeout(() => n.led.classList.remove('on'), 90);
    }, delay);
  }

  // ---- wires ---------------------------------------------------------------
  addWire(edge) {
    const path = document.createElementNS(SVGNS, 'path');
    path.classList.add('wire', `kind-${edge.kind}`);
    path.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.patch.disconnect(edge.id);
    });
    const title = document.createElementNS(SVGNS, 'title');
    title.textContent = 'Click to disconnect';
    path.append(title);
    this.g.append(path);
    this.wireEls.set(edge.id, path);
    this.updatePortStates();
    this.drawWire(edge, path);
  }
  removeWire(edge) {
    this.wireEls.get(edge.id)?.remove();
    this.wireEls.delete(edge.id);
    this.updatePortStates();
  }
  drawWire(edge, path) {
    const a = this.portPos(edge.from.node, 'out', edge.from.port);
    const b = this.portPos(edge.to.node, 'in', edge.to.port);
    path.setAttribute('d', curve(a, b));
  }
  redrawWires() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      for (const [id, path] of this.wireEls) {
        const e = this.patch.edges.get(id);
        if (e) this.drawWire(e, path);
      }
    });
  }
  updatePortStates() {
    const used = new Set();
    for (const e of this.patch.edges.values()) {
      used.add(`${e.from.node}|out|${e.from.port}`);
      used.add(`${e.to.node}|in|${e.to.port}`);
    }
    for (const [id, n] of this.nodeEls)
      for (const dir of ['in', 'out'])
        for (const [pid, { row }] of Object.entries(n.ports[dir])) row.classList.toggle('connected', used.has(`${id}|${dir}|${pid}`));
  }

  // ---- interaction ---------------------------------------------------------
  portDown(e, node, port, dir) {
    e.stopPropagation();
    e.preventDefault();
    if (dir === 'out') return this.beginWire({ node: node.id, port: port.id }, port.kind, e);
    // Grabbing a connected input picks the cable up so it can be re-patched.
    const edges = this.patch.edgesTo(node.id, port.id);
    if (!edges.length) return;
    const last = edges[edges.length - 1];
    this.patch.disconnect(last.id);
    this.beginWire(last.from, last.kind, e);
  }

  beginWire(from, kind, e) {
    const path = document.createElementNS(SVGNS, 'path');
    path.classList.add('wire', 'temp', `kind-${kind}`);
    this.g.append(path);
    for (const [id, n] of this.nodeEls)
      for (const [pid, { row }] of Object.entries(n.ports.in))
        row.classList.toggle('compatible', this.patch.canConnect(from, { node: id, port: pid }));
    this.vp.classList.add('wiring');
    this.drag = { type: 'wire', from, path, target: null };
    this.moveWire(e);
  }

  moveWire(e) {
    const d = this.drag;
    const row = document.elementFromPoint(e.clientX, e.clientY)?.closest('.port.in.compatible');
    this.vp.querySelector('.port.hover')?.classList.remove('hover');
    d.target = row ? { node: row.dataset.node, port: row.dataset.port } : null;
    row?.classList.add('hover');
    const a = this.portPos(d.from.node, 'out', d.from.port);
    const b = d.target ? this.portPos(d.target.node, 'in', d.target.port) : this.clientToWorld(e.clientX, e.clientY);
    d.path.setAttribute('d', curve(a, b));
  }

  endWire() {
    const d = this.drag;
    d.path.remove();
    this.vp.classList.remove('wiring');
    this.vp.querySelectorAll('.port.compatible, .port.hover').forEach((r) => r.classList.remove('compatible', 'hover'));
    if (d.target) this.patch.connect(d.from, d.target);
  }

  nodeDown(e, node) {
    if (e.button !== 0) return;
    e.preventDefault();
    const { el } = this.nodeEls.get(node.id);
    this.drag = { type: 'node', node, el, sx: e.clientX, sy: e.clientY, ox: node.x, oy: node.y };
    el.classList.add('dragging');
  }

  bindInput() {
    this.vp.addEventListener('pointerdown', (e) => {
      if (e.target !== this.vp && e.target !== this.svg) return;
      this.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: this.view.x, oy: this.view.y };
      this.vp.classList.add('panning');
    });
    window.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      if (d.type === 'wire') this.moveWire(e);
      else if (d.type === 'pan') {
        this.view.x = d.ox + e.clientX - d.sx;
        this.view.y = d.oy + e.clientY - d.sy;
        this.applyView();
      } else if (d.type === 'node') {
        const snap = (v) => Math.round(v / GRID) * GRID;
        d.node.x = snap(d.ox + (e.clientX - d.sx) / this.view.k);
        d.node.y = snap(d.oy + (e.clientY - d.sy) / this.view.k);
        d.el.style.left = `${d.node.x}px`;
        d.el.style.top = `${d.node.y}px`;
        this.redrawWires();
      }
    });
    window.addEventListener('pointerup', () => {
      const d = this.drag;
      if (!d) return;
      if (d.type === 'wire') this.endWire();
      if (d.type === 'node') {
        d.el.classList.remove('dragging');
        this.patch.moveNode(d.node.id, d.node.x, d.node.y);
      }
      this.vp.classList.remove('panning');
      this.drag = null;
    });
    // Trackpad: two-finger scroll pans, pinch (ctrl+wheel) zooms around the cursor.
    this.vp.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          const p = this.clientToWorld(e.clientX, e.clientY);
          const k = clamp(this.view.k * Math.exp(-e.deltaY * 0.01), 0.3, 1.8);
          const r = this.vp.getBoundingClientRect();
          this.view = { k, x: e.clientX - r.left - p.x * k, y: e.clientY - r.top - p.y * k };
        } else {
          this.view.x -= e.deltaX;
          this.view.y -= e.deltaY;
        }
        this.applyView();
        this.redrawWires();
      },
      { passive: false },
    );
    window.addEventListener('resize', () => this.redrawWires());
  }
}

function curve(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function fmt(p, v) {
  if (p.fmt) return p.fmt(v);
  const a = Math.abs(v);
  const s = a >= 1000 ? `${(v / 1000).toFixed(1)}k` : a >= 100 || p.step >= 1 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
  return p.unit ? `${s}${p.unit === 'ct' ? '' : ' '}${p.unit}` : s;
}
