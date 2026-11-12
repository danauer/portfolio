// The Patch is the model + engine: it owns node instances and the connections between them.
// The editor only talks to the Patch; it never touches Web Audio directly.
//
// Three kinds of signal flow through ports:
//   audio — Web Audio connections (AudioNode -> AudioNode)
//   mod   — control signals (AudioNode -> GainNode that feeds an AudioParam)
//   note  — discrete events { type: 'on'|'off', note, velocity, time } routed in JS

export const KINDS = ['audio', 'note', 'mod'];

/** Can a source port of kind `a` feed an input of kind `b`? Audio into mod = audio-rate FM. */
export const compatible = (a, b) => a === b || (a === 'audio' && b === 'mod');

export class Patch {
  constructor(ctx, registry) {
    this.ctx = ctx;
    this.registry = registry;
    this.nodes = new Map();
    this.edges = new Map();
    this.bpm = 110;
    this._nextId = 1;
    this._subs = new Set();
  }

  // ---- events --------------------------------------------------------------
  on(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }
  _notify(type, data) {
    for (const fn of this._subs) fn(type, data);
  }

  // ---- nodes ---------------------------------------------------------------
  addNode(type, { x = 0, y = 0, params = {}, id } = {}) {
    const def = this.registry[type];
    if (!def) throw new Error(`Unknown node type: ${type}`);
    if (def.singleton && [...this.nodes.values()].some((n) => n.type === type)) return null;

    if (id) {
      const num = parseInt(String(id).replace(/\D/g, ''), 10);
      if (num >= this._nextId) this._nextId = num + 1;
    } else id = `n${this._nextId++}`;

    const p = {};
    for (const pd of def.params) p[pd.id] = pd.id in params ? params[pd.id] : structuredClone(pd.default);

    const node = { id, type, def, x, y, params: p, instance: null };
    const patch = this;
    const api = {
      ctx: this.ctx,
      get bpm() {
        return patch.bpm;
      },
      emit: (port, ev) => patch._emit(id, port, ev),
      setParam: (k, v) => patch.setParam(id, k, v),
    };
    node.instance = def.create(this.ctx, p, api);
    this.nodes.set(id, node);
    this._notify('node-add', node);
    this._notify('change');
    return node;
  }

  removeNode(id) {
    const node = this.nodes.get(id);
    if (!node) return;
    for (const e of [...this.edges.values()]) if (e.from.node === id || e.to.node === id) this.disconnect(e.id);
    node.instance.dispose?.();
    this.nodes.delete(id);
    this._notify('node-remove', node);
    this._notify('change');
  }

  moveNode(id, x, y) {
    const n = this.nodes.get(id);
    if (!n) return;
    n.x = x;
    n.y = y;
    this._notify('change');
  }

  setParam(id, key, value) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.params[key] = value;
    node.instance.setParam?.(key, value);
    this._notify('param', { node, key, value });
    this._notify('change');
  }

  setBpm(bpm) {
    this.bpm = bpm;
    for (const n of this.nodes.values()) n.instance.onBpm?.(bpm);
    this._notify('change');
  }

  /** Release every held note everywhere. */
  panic() {
    for (const n of this.nodes.values()) n.instance.allOff?.();
  }

  // ---- connections ---------------------------------------------------------
  _ports(from, to) {
    const src = this.nodes.get(from.node);
    const dst = this.nodes.get(to.node);
    return {
      src,
      dst,
      sp: src?.def.outputs.find((p) => p.id === from.port),
      dp: dst?.def.inputs.find((p) => p.id === to.port),
    };
  }

  canConnect(from, to) {
    const { sp, dp } = this._ports(from, to);
    if (!sp || !dp || from.node === to.node) return false;
    if (!compatible(sp.kind, dp.kind)) return false;
    return !this.edges.has(edgeId(from, to));
  }

  connect(from, to) {
    if (!this.canConnect(from, to)) return null;
    const { src, dst, sp } = this._ports(from, to);
    if (sp.kind !== 'note') src.instance.outputs[from.port].connect(dst.instance.inputs[to.port]);
    const edge = { id: edgeId(from, to), from: { ...from }, to: { ...to }, kind: sp.kind };
    this.edges.set(edge.id, edge);
    this._notify('edge-add', edge);
    this._notify('change');
    return edge;
  }

  disconnect(id) {
    const e = this.edges.get(id);
    if (!e) return;
    const src = this.nodes.get(e.from.node);
    const dst = this.nodes.get(e.to.node);
    if (e.kind === 'note') dst?.instance.allOff?.(); // don't leave notes hanging
    else {
      try {
        src.instance.outputs[e.from.port].disconnect(dst.instance.inputs[e.to.port]);
      } catch {
        /* already disconnected */
      }
    }
    this.edges.delete(id);
    this._notify('edge-remove', e);
    this._notify('change');
  }

  edgesTo(node, port) {
    return [...this.edges.values()].filter((e) => e.to.node === node && e.to.port === port);
  }

  /** Route a note event from a node's output port to every connected note input. */
  _emit(nodeId, port, ev) {
    const delay = Math.max(0, ((ev.time ?? this.ctx.currentTime) - this.ctx.currentTime) * 1000);
    if (ev.type === 'on') this._notify('activity', { nodeId, delay });
    for (const e of this.edges.values()) {
      if (e.from.node !== nodeId || e.from.port !== port) continue;
      const target = this.nodes.get(e.to.node);
      const fn = target?.instance.inputs[e.to.port];
      if (typeof fn === 'function') {
        if (ev.type === 'on') this._notify('activity', { nodeId: target.id, delay });
        fn(ev);
      }
    }
  }

  // ---- serialization -------------------------------------------------------
  clear() {
    for (const id of [...this.nodes.keys()]) this.removeNode(id);
    this._nextId = 1;
  }

  toJSON() {
    return {
      version: 1,
      bpm: this.bpm,
      nodes: [...this.nodes.values()].map((n) => ({ id: n.id, type: n.type, x: n.x, y: n.y, params: n.params })),
      edges: [...this.edges.values()].map((e) => ({ from: e.from, to: e.to })),
    };
  }

  load(json) {
    this.clear();
    this.setBpm(json.bpm ?? 110);
    for (const n of json.nodes ?? []) {
      if (this.registry[n.type]) this.addNode(n.type, { id: n.id, x: n.x, y: n.y, params: n.params });
    }
    for (const e of json.edges ?? []) this.connect(e.from, e.to);
    this._notify('load');
  }
}

const edgeId = (from, to) => `${from.node}.${from.port}>${to.node}.${to.port}`;
