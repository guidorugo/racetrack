/**
 * Canvas rendering of the race: graph paper, track, finish line, car trails,
 * velocity vectors, cars and the nine move options.
 *
 * The static background (grid, track, walls, finish line) is drawn once per
 * resize into an offscreen canvas; each frame then only draws the dynamic parts.
 * Walls are drawn exactly as the collision engine sees them (straight polygon
 * edges), so what you see is what you crash into.
 *
 * @typedef {import('../../shared/game.js').GameState} GameState
 * @typedef {import('../../shared/game.js').MoveOption} MoveOption
 * @typedef {import('../../shared/track.js').Track} Track
 * @typedef {import('./viewport.js').Viewport} Viewport
 *
 * @typedef {Object} MoveAnimation
 * @property {string} playerId
 * @property {{x: number, y: number}} from
 * @property {{x: number, y: number}} to
 * @property {{x: number, y: number}} target
 * @property {boolean} crash
 * @property {number} t   progress 0..1
 *
 * @typedef {Object} Scene
 * @property {GameState | null} state
 * @property {MoveOption[]} options      shown only when the local user can move
 * @property {number} hoverIndex
 * @property {number} pendingIndex       crash option awaiting confirmation
 * @property {MoveAnimation | null} anim
 * @property {string | null} localPlayerId
 * @property {number} time               ms timestamp, for pulsing effects
 */

import { NUMPAD_KEYS } from '../../shared/constants.js';
import { computeViewport, toScreen } from './viewport.js';

const COLORS = Object.freeze({
  paper: '#fffef9',
  margin: '#f6f4ec',
  offTrack: '#e9e5d8',
  hatch: 'rgba(110, 100, 80, 0.13)',
  grid: 'rgba(110, 160, 210, 0.40)',
  gridMajor: 'rgba(80, 130, 185, 0.55)',
  wall: '#1d2733',
  crash: '#c62828',
  win: '#e0a800',
  winStroke: '#7a5a00',
  label: 'rgba(40, 55, 70, 0.55)',
});

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not supported by this browser.');
    this.ctx = ctx;
    /** @type {Track | null} */
    this.track = null;
    /** @type {Viewport | null} */
    this.viewport = null;
    this.dpr = 1;
    /** @type {HTMLCanvasElement | null} */
    this.staticLayer = null;
  }

  /** @param {Track} track */
  setTrack(track) {
    if (this.track === track) return;
    this.track = track;
    this.viewport = null;
    this.staticLayer = null;
  }

  /**
   * Matches the backing store to the element size and device pixel ratio.
   * @returns {boolean} true if the size changed
   */
  resize() {
    if (!this.track) return false;
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const vp = this.viewport;
    if (vp && vp.width === width && vp.height === height && this.dpr === dpr) return false;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.viewport = computeViewport(width, height, this.track.width, this.track.height, 1.2);
    this.staticLayer = null;
    return true;
  }

  /** @param {Scene} scene */
  render(scene) {
    if (!this.track) return;
    if (!this.viewport) this.resize();
    const vp = this.viewport;
    if (!vp) return;
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!this.staticLayer) this.staticLayer = this.#renderStatic();
    ctx.drawImage(this.staticLayer, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (!scene.state) return;
    this.#drawTrails(scene);
    this.#drawLastCrash(scene);
    this.#drawVelocities(scene);
    this.#drawOptions(scene);
    this.#drawCars(scene);
    this.#drawAnimationEffects(scene);
  }

  // --- Static background --------------------------------------------------------------

  #renderStatic() {
    const track = /** @type {Track} */ (this.track);
    const vp = /** @type {Viewport} */ (this.viewport);
    const layer = document.createElement('canvas');
    layer.width = this.canvas.width;
    layer.height = this.canvas.height;
    const ctx = /** @type {CanvasRenderingContext2D} */ (layer.getContext('2d'));
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const s = vp.scale;
    const P = (/** @type {number} */ x, /** @type {number} */ y) => toScreen(vp, x, y);
    const topLeft = P(0, 0);
    const gridW = track.width * s;
    const gridH = track.height * s;

    ctx.fillStyle = COLORS.margin;
    ctx.fillRect(0, 0, vp.width, vp.height);

    // Off-track area: tinted and hatched.
    ctx.fillStyle = COLORS.offTrack;
    ctx.fillRect(topLeft.x, topLeft.y, gridW, gridH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(topLeft.x, topLeft.y, gridW, gridH);
    ctx.clip();
    ctx.strokeStyle = COLORS.hatch;
    ctx.lineWidth = 1;
    const step = Math.max(6, s * 0.45);
    ctx.beginPath();
    for (let d = -gridH; d < gridW; d += step) {
      ctx.moveTo(topLeft.x + d, topLeft.y + gridH);
      ctx.lineTo(topLeft.x + d + gridH, topLeft.y);
    }
    ctx.stroke();
    ctx.restore();

    // Track surface (even-odd across all boundary polygons, like the engine).
    const surface = new Path2D();
    for (const poly of track.boundaries) {
      poly.forEach((v, i) => {
        const p = P(v.x, v.y);
        if (i === 0) surface.moveTo(p.x, p.y);
        else surface.lineTo(p.x, p.y);
      });
      surface.closePath();
    }
    ctx.fillStyle = COLORS.paper;
    ctx.fill(surface, 'evenodd');

    // Graph-paper grid; every 5th line a little stronger.
    for (const major of [false, true]) {
      ctx.strokeStyle = major ? COLORS.gridMajor : COLORS.grid;
      ctx.lineWidth = major ? 1 : 0.75;
      ctx.beginPath();
      for (let x = 0; x <= track.width; x++) {
        if ((x % 5 === 0) !== major) continue;
        const px = Math.round(topLeft.x + x * s) + 0.5;
        ctx.moveTo(px, topLeft.y);
        ctx.lineTo(px, topLeft.y + gridH);
      }
      for (let y = 0; y <= track.height; y++) {
        if ((y % 5 === 0) !== major) continue;
        const py = Math.round(topLeft.y + y * s) + 0.5;
        ctx.moveTo(topLeft.x, py);
        ctx.lineTo(topLeft.x + gridW, py);
      }
      ctx.stroke();
    }

    // Coordinate labels every 10 units, in the margin.
    if (s >= 9) {
      ctx.fillStyle = COLORS.label;
      ctx.font = `${Math.max(9, Math.min(12, s * 0.5))}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      for (let x = 0; x <= track.width; x += 10) ctx.fillText(String(x), topLeft.x + x * s, topLeft.y - 3);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let y = 0; y <= track.height; y += 10) ctx.fillText(String(y), topLeft.x - 4, topLeft.y + y * s);
    }

    this.#drawFinishLine(ctx);

    // Walls last, so they sit on top of everything static.
    ctx.strokeStyle = COLORS.wall;
    ctx.lineWidth = Math.max(2, s * 0.14);
    ctx.lineJoin = 'round';
    ctx.stroke(surface);
    return layer;
  }

  /** Checkered finish line plus arrows showing the racing direction. @param {CanvasRenderingContext2D} ctx */
  #drawFinishLine(ctx) {
    const track = /** @type {Track} */ (this.track);
    const vp = /** @type {Viewport} */ (this.viewport);
    const { a, b } = track.finishLine;
    const pa = toScreen(vp, a.x, a.y);
    const pb = toScreen(vp, b.x, b.y);
    const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    const ux = (pb.x - pa.x) / len;
    const uy = (pb.y - pa.y) / len;
    // Unit normal pointing in the racing direction.
    const fn = track.finishNormal;
    const fl = Math.hypot(fn.x, fn.y);
    const nx = fn.x / fl;
    const ny = fn.y / fl;
    const sq = Math.max(3, vp.scale * 0.3);
    const count = Math.max(2, Math.round(len / sq));
    const size = len / count;
    for (let i = 0; i < count; i++) {
      for (let row = 0; row < 2; row++) {
        const along = i * size;
        const across = (row - 1) * size;
        ctx.fillStyle = (i + row) % 2 === 0 ? '#1d2733' : '#ffffff';
        ctx.beginPath();
        const x0 = pa.x + ux * along + nx * across;
        const y0 = pa.y + uy * along + ny * across;
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0 + ux * size, y0 + uy * size);
        ctx.lineTo(x0 + ux * size + nx * size, y0 + uy * size + ny * size);
        ctx.lineTo(x0 + nx * size, y0 + ny * size);
        ctx.closePath();
        ctx.fill();
      }
    }
    // Direction arrows just past the line.
    ctx.fillStyle = 'rgba(29, 39, 51, 0.55)';
    const arrow = Math.max(5, vp.scale * 0.45);
    for (const f of [0.2, 0.8]) {
      const cx = pa.x + ux * len * f + nx * vp.scale * 1.1;
      const cy = pa.y + uy * len * f + ny * vp.scale * 1.1;
      ctx.beginPath();
      ctx.moveTo(cx + nx * arrow, cy + ny * arrow);
      ctx.lineTo(cx - nx * arrow * 0.6 + ux * arrow * 0.7, cy - ny * arrow * 0.6 + uy * arrow * 0.7);
      ctx.lineTo(cx - nx * arrow * 0.6 - ux * arrow * 0.7, cy - ny * arrow * 0.6 - uy * arrow * 0.7);
      ctx.closePath();
      ctx.fill();
    }
  }

  // --- Dynamic layers ------------------------------------------------------------------

  /** @param {Scene} scene */
  #drawTrails(scene) {
    const { ctx } = this;
    const vp = /** @type {Viewport} */ (this.viewport);
    const state = /** @type {GameState} */ (scene.state);
    const s = vp.scale;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const player of state.players) {
      const points = trailFor(state, player.id, scene.anim);
      const faded = player.status === 'retired';
      ctx.globalAlpha = faded ? 0.25 : 0.75;
      ctx.strokeStyle = player.color;
      ctx.fillStyle = player.color;
      ctx.lineWidth = Math.max(1.5, s * 0.09);
      ctx.beginPath();
      points.forEach((p, i) => {
        const q = toScreen(vp, p.x, p.y);
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      });
      ctx.stroke();
      const r = Math.max(1.8, s * 0.11);
      for (const p of points.slice(0, -1)) {
        const q = toScreen(vp, p.x, p.y);
        ctx.beginPath();
        ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Small crash marks where cars crashed.
    ctx.strokeStyle = COLORS.crash;
    ctx.lineWidth = Math.max(1.5, s * 0.07);
    const m = Math.max(3, s * 0.2);
    for (const move of state.history) {
      if (move.outcome !== 'crashed') continue;
      const q = toScreen(vp, move.from.x, move.from.y);
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const ang = (Math.PI / 4) * (2 * k + 1);
        ctx.moveTo(q.x + Math.cos(ang) * m * 0.45, q.y + Math.sin(ang) * m * 0.45);
        ctx.lineTo(q.x + Math.cos(ang) * m * 1.35, q.y + Math.sin(ang) * m * 1.35);
      }
      ctx.stroke();
    }
  }

  /** Shows where the most recent crash was trying to go. @param {Scene} scene */
  #drawLastCrash(scene) {
    const state = /** @type {GameState} */ (scene.state);
    const last = state.history.at(-1);
    if (!last || last.outcome !== 'crashed' || scene.anim) return;
    const vp = /** @type {Viewport} */ (this.viewport);
    const { ctx } = this;
    const from = toScreen(vp, last.from.x, last.from.y);
    const to = toScreen(vp, last.target.x, last.target.y);
    ctx.save();
    ctx.strokeStyle = COLORS.crash;
    ctx.lineWidth = Math.max(1.5, vp.scale * 0.08);
    ctx.setLineDash([vp.scale * 0.25, vp.scale * 0.2]);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.setLineDash([]);
    drawCross(ctx, to.x, to.y, Math.max(4, vp.scale * 0.28), COLORS.crash, Math.max(2, vp.scale * 0.1));
    ctx.restore();
  }

  /** Dashed arrow from each car to where its current velocity would take it. @param {Scene} scene */
  #drawVelocities(scene) {
    const state = /** @type {GameState} */ (scene.state);
    const vp = /** @type {Viewport} */ (this.viewport);
    const { ctx } = this;
    for (const player of state.players) {
      if (player.status === 'retired') continue;
      if (scene.anim && scene.anim.playerId === player.id) continue;
      const { position: p, velocity: v } = player;
      if (v.x === 0 && v.y === 0) continue;
      const from = toScreen(vp, p.x, p.y);
      const to = toScreen(vp, p.x + v.x, p.y + v.y);
      ctx.save();
      ctx.strokeStyle = player.color;
      ctx.fillStyle = player.color;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = Math.max(1.5, vp.scale * 0.08);
      ctx.setLineDash([vp.scale * 0.22, vp.scale * 0.16]);
      drawArrow(ctx, from.x, from.y, to.x, to.y, Math.max(6, vp.scale * 0.4));
      ctx.setLineDash([]);
      // The "ghost" point: where the car goes with no acceleration.
      ctx.beginPath();
      ctx.arc(to.x, to.y, Math.max(2.5, vp.scale * 0.13), 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  /** @param {Scene} scene */
  #drawOptions(scene) {
    const state = /** @type {GameState} */ (scene.state);
    if (!scene.options.length || state.status !== 'playing' || scene.anim) return;
    const vp = /** @type {Viewport} */ (this.viewport);
    const { ctx } = this;
    const player = state.players[state.currentPlayerIndex];
    const origin = toScreen(vp, player.position.x, player.position.y);
    const r = Math.max(4, vp.scale * 0.22);
    const showKeys = vp.scale >= 22; // key hints only when there is room for them

    // Preview line for the hovered / pending option first, underneath the markers.
    const focus = scene.pendingIndex >= 0 ? scene.pendingIndex : scene.hoverIndex;
    if (focus >= 0 && scene.options[focus]) {
      const o = scene.options[focus];
      const t = toScreen(vp, o.target.x, o.target.y);
      ctx.save();
      ctx.lineWidth = Math.max(2, vp.scale * 0.1);
      ctx.strokeStyle = o.outcome === 'crash' ? COLORS.crash : o.outcome === 'win' ? COLORS.win : player.color;
      if (o.outcome === 'crash') ctx.setLineDash([vp.scale * 0.2, vp.scale * 0.15]);
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(t.x, t.y);
      ctx.stroke();
      ctx.restore();
    }

    scene.options.forEach((o, i) => {
      const p = toScreen(vp, o.target.x, o.target.y);
      const focused = i === focus;
      const k = focused ? 1.45 : 1;
      ctx.save();
      if (focused) {
        ctx.fillStyle = 'rgba(11, 99, 168, 0.12)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      if (o.outcome === 'crash') {
        drawCross(ctx, p.x, p.y, r * 0.95 * k, COLORS.crash, Math.max(2, vp.scale * 0.09));
      } else if (o.outcome === 'win') {
        drawStar(ctx, p.x, p.y, r * 1.5 * k, COLORS.win, COLORS.winStroke);
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * k, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = Math.max(2, vp.scale * 0.1);
        ctx.strokeStyle = player.color;
        ctx.stroke();
      }
      if (i === scene.pendingIndex) {
        const pulse = 0.5 + 0.5 * Math.sin(scene.time / 150);
        const rgb = o.outcome === 'crash' ? '198, 40, 40' : '11, 99, 168';
        ctx.strokeStyle = `rgba(${rgb}, ${0.35 + 0.5 * pulse})`;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 2.1, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (showKeys) {
        ctx.fillStyle = COLORS.label;
        ctx.font = `600 ${Math.round(Math.min(12, vp.scale * 0.45))}px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(NUMPAD_KEYS[i], p.x + r * 0.9, p.y - r * 0.6);
      }
      ctx.restore();
    });
  }

  /** @param {Scene} scene */
  #drawCars(scene) {
    const state = /** @type {GameState} */ (scene.state);
    const vp = /** @type {Viewport} */ (this.viewport);
    const { ctx } = this;
    const R = Math.max(6, vp.scale * 0.42);
    const current = state.status === 'playing' ? state.players[state.currentPlayerIndex] : null;
    // Draw the current car last so it is on top.
    const order = state.players.map((p, i) => ({ p, i })).sort((a, b) => Number(a.p === current) - Number(b.p === current));
    for (const { p: player, i } of order) {
      let pos = player.position;
      if (scene.anim && scene.anim.playerId === player.id) pos = animatedPosition(scene.anim);
      const c = toScreen(vp, pos.x, pos.y);
      ctx.save();
      if (player.status === 'retired') ctx.globalAlpha = 0.35;
      if (player === current && !scene.anim) {
        const pulse = 0.5 + 0.5 * Math.sin(scene.time / 260);
        ctx.fillStyle = player.color;
        ctx.globalAlpha = 0.16 + 0.14 * pulse;
        ctx.beginPath();
        ctx.arc(c.x, c.y, R * 1.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      if (player.id === scene.localPlayerId) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, R + 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#1d2733';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
      ctx.fillStyle = player.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${Math.round(R * 1.15)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), c.x, c.y + R * 0.05);
      if (player.status === 'finished') drawStar(ctx, c.x + R, c.y - R, R * 0.7, COLORS.win, COLORS.winStroke);
      ctx.restore();
    }
  }

  /** Flash at the target of a crash while it animates. @param {Scene} scene */
  #drawAnimationEffects(scene) {
    const anim = scene.anim;
    if (!anim || !anim.crash) return;
    const vp = /** @type {Viewport} */ (this.viewport);
    const t = toScreen(vp, anim.target.x, anim.target.y);
    const from = toScreen(vp, anim.from.x, anim.from.y);
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 1 - Math.abs(anim.t - 0.5);
    ctx.strokeStyle = COLORS.crash;
    ctx.lineWidth = Math.max(1.5, vp.scale * 0.08);
    ctx.setLineDash([vp.scale * 0.2, vp.scale * 0.15]);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(t.x, t.y);
    ctx.stroke();
    ctx.setLineDash([]);
    drawCross(ctx, t.x, t.y, Math.max(5, vp.scale * 0.35), COLORS.crash, Math.max(2.5, vp.scale * 0.12));
    ctx.restore();
  }
}

/**
 * Trail points of a player, with the last point following an in-progress animation.
 * @param {GameState} state @param {string} playerId @param {MoveAnimation | null} anim
 */
function trailFor(state, playerId, anim) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return [];
  const points = [player.startPosition];
  for (const m of state.history) if (m.playerId === playerId && m.outcome !== 'crashed') points.push(m.to);
  if (anim && anim.playerId === playerId && !anim.crash) {
    points[points.length - 1] = animatedPosition(anim);
  }
  return points;
}

/** @param {MoveAnimation} anim */
export function animatedPosition(anim) {
  const ease = (/** @type {number} */ t) => 1 - (1 - t) ** 3;
  if (anim.crash) {
    // Lunge part of the way towards the wall, then bounce back.
    const k = Math.sin(Math.PI * Math.min(1, anim.t)) * 0.35;
    return { x: anim.from.x + (anim.target.x - anim.from.x) * k, y: anim.from.y + (anim.target.y - anim.from.y) * k };
  }
  const k = ease(Math.min(1, anim.t));
  return { x: anim.from.x + (anim.to.x - anim.from.x) * k, y: anim.from.y + (anim.to.y - anim.from.y) * k };
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {number} head
 */
function drawArrow(ctx, x0, y0, x1, y1, head) {
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const len = Math.hypot(x1 - x0, y1 - y0);
  const h = Math.min(head, len * 0.45);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1 - Math.cos(angle) * h * 0.8, y1 - Math.sin(angle) * h * 0.8);
  ctx.stroke();
  ctx.save();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - Math.cos(angle - 0.45) * h, y1 - Math.sin(angle - 0.45) * h);
  ctx.lineTo(x1 - Math.cos(angle + 0.45) * h, y1 - Math.sin(angle + 0.45) * h);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x @param {number} y @param {number} size @param {string} color @param {number} width
 */
function drawCross(ctx, x, y, size, color, width) {
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = width + 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - size, y - size);
  ctx.lineTo(x + size, y + size);
  ctx.moveTo(x + size, y - size);
  ctx.lineTo(x - size, y + size);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.restore();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x @param {number} y @param {number} radius @param {string} fill @param {string} stroke
 */
function drawStar(ctx, x, y, radius, fill, stroke) {
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? radius : radius * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  ctx.restore();
}
