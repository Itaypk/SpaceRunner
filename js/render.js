/**
 * Canvas renderer. Logic happens in discrete ticks; the renderer eases every object
 * towards its grid position so the motion still looks smooth, and plays short
 * effects (sparks, debris, explosions) for the events of each tick.
 */

const VIEW_W = 600;
const VIEW_H = 800;
const LANE_W = VIEW_W / LANES;
const ROW_H = VIEW_H / ROWS;

const laneX = lane => lane * LANE_W + LANE_W / 2;
const rowY = row => row * ROW_H + ROW_H / 2;

const SPRITE_NAMES = [
    'ship_a', 'ship_b', 'stone_a', 'stone_b', 'stone_c', 'stone_cracked', 'stone_debris_a', 'stone_debris_b',
    'metal_a', 'metal_b', 'metal_c', 'ice_a', 'ice_b', 'ice_shards',
    'laser_a', 'laser_b', 'spark_a', 'spark_b', 'explosion', 'smoke',
    'explosive', 'explosive_cracking', 'explosive_burst', 'ship_hit', 'ship_breaking', 'ship_wreck',
];

function loadImage(src) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
    });
}

async function loadSprites() {
    const sprites = {};
    await Promise.all(SPRITE_NAMES.map(async name => {
        sprites[name] = await loadImage(`assets/sprites/${name}.png`);
        if (!sprites[name]) console.warn(`sprite ${name} failed to load`);
    }));
    return sprites;
}

// The destruction frames show the ship banked up-right; rotate them to match the upright ship.
const WRECK_ROTATION = -Math.PI / 4;

class Renderer {
    constructor(canvas, sprites) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.sprites = sprites;
        this.visuals = new Map();   // entity id -> { x, y, flashUntil }
        this.effects = [];          // short-lived animations
        this.ship = { x: laneX(START_LANE), tilt: 0 };
        this.shipVisible = true;
        this.lastFrame = performance.now();
        this.stars = Array.from({ length: 110 }, () => ({
            x: Math.random() * VIEW_W, y: Math.random() * VIEW_H,
            size: Math.random() * 1.6 + 0.4, speed: Math.random() * 40 + 15,
            phase: Math.random() * Math.PI * 2,
        }));
        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    /** Render at device resolution so it stays crisp on a projector / retina screen. */
    resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.canvas.width = VIEW_W * dpr;
        this.canvas.height = VIEW_H * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.ctx.imageSmoothingQuality = 'high';
    }

    reset() {
        this.visuals.clear();
        this.effects = [];
        this.ship = { x: laneX(START_LANE), tilt: 0 };
        this.shipVisible = true;
        this.hideShipAt = 0;
    }

    /** Called after every tick with the world's events. */
    onTick(world) {
        const now = performance.now();
        for (const e of world.events) {
            const v = this.visuals.get(e.id);
            const x = e.lane !== undefined ? laneX(e.lane) : this.ship.x;
            const y = rowY(e.row !== undefined ? e.row : PLAYER_ROW);
            if (e.laserId) this.visuals.delete(e.laserId);
            switch (e.kind) {
                case 'shot':
                    this.addEffect('spark_b', laneX(e.lane), rowY(PLAYER_ROW) - 42, 36, 140);
                    break;
                case 'hit':
                    if (v) v.flashUntil = now + 160;
                    this.addEffect('spark_a', x, y + 30, 70, 260);
                    break;
                case 'deflect':
                    this.addEffect('spark_b', x, y + 35, 60, 220);
                    break;
                case 'destroy':
                    this.addEffect(e.type === 'ice' ? 'ice_shards' : 'stone_debris_b', x, y, 105, 450, { grow: 0.5 });
                    this.addEffect('spark_b', x, y + 20, 70, 220);
                    break;
                case 'detonate': {
                    // The rock cracks open, bursts, then the blast.
                    const at = v ? v.y : y;
                    this.addEffect('explosive_cracking', x, at, 92, 130, { fade: false });
                    this.addEffect('explosive_burst', x, at, 96, 170, { delay: 130, fade: false });
                    this.addEffect('explosion', x, at, 200, 700, { delay: 280, grow: 0.4 });
                    this.addEffect('smoke', x, at, 210, 1500, { delay: 650, grow: 0.3 });
                    break;
                }
                case 'crash': {
                    // Ship destruction: hit -> breaking apart -> drifting wreck, with an explosion on top.
                    const sx = this.ship.x, sy = rowY(PLAYER_ROW);
                    const delay = e.cause === 'detonated' ? 260 : 0; // wait for the shockwave
                    const spin = { rotation: WRECK_ROTATION + this.ship.tilt, fade: false };
                    this.addEffect('ship_hit', sx, sy, 125, 160, { ...spin, delay });
                    this.addEffect('ship_breaking', sx, sy, 125, 260, { ...spin, delay: delay + 160 });
                    this.addEffect('explosion', sx, sy, 150, 650, { delay: delay + 220, grow: 0.3 });
                    this.addEffect('ship_wreck', sx, sy, 125, 1900, { rotation: WRECK_ROTATION, delay: delay + 420, vy: 22 });
                    this.addEffect('smoke', sx, sy, 170, 1600, { delay: delay + 650, grow: 0.25 });
                    if (delay) this.hideShipAt = performance.now() + delay;
                    else this.shipVisible = false;
                    break;
                }
            }
        }
    }

    /** fade: fade out over the duration (off for animation frames). vy: drift in px/s. */
    addEffect(sprite, x, y, size, duration, { delay = 0, grow = 0, rotation = 0, fade = true, vy = 0 } = {}) {
        this.effects.push({ sprite, x, y, size, duration, grow, rotation, fade, vy, start: performance.now() + delay });
    }

    drawSprite(name, x, y, size, rotation = 0, alpha = 1) {
        const img = this.sprites[name];
        if (!img) return;
        const scale = size / Math.max(img.width, img.height);
        const w = img.width * scale, h = img.height * scale;
        const ctx = this.ctx;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(x, y);
        if (rotation) ctx.rotate(rotation);
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        ctx.restore();
    }

    asteroidSprite(a) {
        const pick = list => list[Math.floor(a.variant * list.length) % list.length];
        if (a.type === 'ice') return { name: pick(['ice_a', 'ice_b']), size: 88, spin: 0.4 };
        if (a.type === 'metal') return { name: pick(['metal_a', 'metal_b', 'metal_c']), size: 100, spin: 0.15 };
        if (a.type === 'explosive') return { name: 'explosive', size: 90, spin: 0.6, pulse: true };
        return { name: a.hp >= 2 ? pick(['stone_a', 'stone_b', 'stone_c']) : 'stone_cracked', size: 96, spin: 0.3 };
    }

    /**
     * ui: { tickMs, paused, thinkingSince, lastAction, lastActionAt, showOverlay, controllerLabel, status }
     */
    render(world, ui) {
        const now = performance.now();
        const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
        this.lastFrame = now;
        // Ease towards the logical grid position. Faster ticks -> snappier easing.
        const rate = 1000 / Math.min(Math.max(ui.tickMs, 80), 400) * 3.2;
        const ease = 1 - Math.exp(-dt * rate);
        const ctx = this.ctx;

        // Background
        ctx.fillStyle = '#05070f';
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);
        for (const s of this.stars) {
            s.y += s.speed * dt;
            if (s.y > VIEW_H) { s.y = 0; s.x = Math.random() * VIEW_W; }
            ctx.globalAlpha = 0.55 + 0.45 * Math.sin(now / 600 + s.phase);
            ctx.fillStyle = '#dbe4ff';
            ctx.fillRect(s.x, s.y, s.size, s.size);
        }
        ctx.globalAlpha = 1;

        // Lanes
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.10)';
        ctx.lineWidth = 2;
        ctx.setLineDash([14, 18]);
        for (let i = 1; i < LANES; i++) {
            ctx.beginPath();
            ctx.moveTo(i * LANE_W, 0);
            ctx.lineTo(i * LANE_W, VIEW_H);
            ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(148, 163, 184, 0.35)';
        ctx.font = '600 13px "JetBrains Mono", ui-monospace, monospace';
        ctx.textAlign = 'center';
        for (let i = 0; i < LANES; i++) ctx.fillText(`lane ${i}`, laneX(i), VIEW_H - 8);

        // Asteroids
        const live = new Set();
        for (const a of world.asteroids) {
            live.add(a.id);
            const tx = laneX(a.lane), ty = rowY(a.row);
            let v = this.visuals.get(a.id);
            if (!v) { v = { x: tx, y: ty - ROW_H, flashUntil: 0 }; this.visuals.set(a.id, v); }
            v.y += (ty - v.y) * ease;
            v.x = tx;
            const { name, size, spin, pulse } = this.asteroidSprite(a);
            const rotation = (now / 1000) * spin * (a.variant > 0.5 ? 1 : -1) + a.variant * 6;
            if (pulse) { // unstable: a throbbing red glow behind it
                const glow = 0.35 + 0.25 * Math.sin(now / 140);
                const g = ctx.createRadialGradient(v.x, v.y, 10, v.x, v.y, size * 0.75);
                g.addColorStop(0, `rgba(255, 80, 40, ${glow})`);
                g.addColorStop(1, 'rgba(255, 80, 40, 0)');
                ctx.fillStyle = g;
                ctx.fillRect(v.x - size, v.y - size, size * 2, size * 2);
            }
            this.drawSprite(name, v.x, v.y, size, rotation);
            if (v.flashUntil > now) {
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                this.drawSprite(name, v.x, v.y, size, rotation, 0.6);
                ctx.restore();
            }
            if (ui.showOverlay && a.row >= 0 && a.row <= PLAYER_ROW) this.drawBadge(v.x + 38, v.y - 34, PLAYER_ROW - a.row, a.type);
        }

        // Lasers
        for (const l of world.lasers) {
            live.add(l.id);
            const tx = laneX(l.lane), ty = rowY(l.row);
            let v = this.visuals.get(l.id);
            if (!v) { v = { x: tx, y: rowY(PLAYER_ROW) - 30 }; this.visuals.set(l.id, v); }
            v.y += (ty - v.y) * Math.min(1, ease * 1.6);
            this.drawSprite('laser_a', tx, v.y, 72, -Math.PI / 2);
        }
        for (const id of this.visuals.keys()) if (!live.has(id)) this.visuals.delete(id);

        // Ship
        const targetX = laneX(world.playerLane);
        const dx = targetX - this.ship.x;
        this.ship.x += dx * Math.min(1, ease * 1.4);
        this.ship.tilt = Math.max(-0.35, Math.min(0.35, dx * 0.004));
        if (this.hideShipAt && now >= this.hideShipAt) { this.shipVisible = false; this.hideShipAt = 0; }
        if (this.shipVisible) {
            const frame = Math.floor(now / 90) % 2 ? 'ship_a' : 'ship_b';
            const bob = Math.sin(now / 260) * 2;
            this.drawSprite(frame, this.ship.x, rowY(PLAYER_ROW) + bob, 92, this.ship.tilt);
        }

        // Effects
        this.effects = this.effects.filter(e => now < e.start + e.duration);
        for (const e of this.effects) {
            if (now < e.start) continue;
            const t = (now - e.start) / e.duration;
            const y = e.y + e.vy * (now - e.start) / 1000;
            this.drawSprite(e.sprite, e.x, y, e.size * (1 + e.grow * t), e.rotation, e.fade ? 1 - t * t : 1);
        }

        this.drawHud(world, ui, now);
    }

    drawBadge(x, y, rowsAway, type) {
        const ctx = this.ctx;
        const danger = rowsAway <= 2;
        ctx.fillStyle = danger ? 'rgba(239, 68, 68, 0.9)' : 'rgba(15, 23, 42, 0.85)';
        ctx.strokeStyle = { metal: '#94a3b8', ice: '#67e8f9', stone: '#d6b98c', explosive: '#f87171' }[type] || '#f8fafc';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(x - 15, y - 11, 30, 22, 6);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#f8fafc';
        ctx.font = '700 13px "JetBrains Mono", ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(rowsAway), x, y + 1);
        ctx.textBaseline = 'alphabetic';
    }

    drawHud(world, ui, now) {
        const ctx = this.ctx;
        ctx.textAlign = 'left';
        ctx.fillStyle = '#f8fafc';
        ctx.font = '800 22px Inter, system-ui, sans-serif';
        ctx.fillText(`${world.score}`, 16, 34);
        ctx.font = '600 11px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(`SCORE  ·  ${world.destroyed} destroyed`, 16, 50);

        ctx.textAlign = 'right';
        ctx.font = '600 12px Inter, system-ui, sans-serif';
        const labelW = ctx.measureText(ui.controllerLabel).width;
        ctx.fillStyle = 'rgba(2, 6, 23, 0.75)';
        ctx.beginPath();
        ctx.roundRect(VIEW_W - 26 - labelW, 14, labelW + 20, 24, 8);
        ctx.fill();
        ctx.fillStyle = '#a5b4fc';
        ctx.fillText(ui.controllerLabel, VIEW_W - 16, 31);

        if (ui.paused && world.status === 'playing') {
            ctx.textAlign = 'center';
            ctx.fillStyle = 'rgba(250, 204, 21, 0.95)';
            ctx.font = '700 14px Inter, system-ui, sans-serif';
            ctx.fillText('PAUSED  ·  N = step one tick  ·  P = resume', VIEW_W / 2, 84);
        }

        if (!this.shipVisible) return;
        // Decision bubble above the ship: what the controller is doing right now.
        let label = null, color = '#e2e8f0';
        if (ui.thinkingSince) {
            const secs = ((now - ui.thinkingSince) / 1000).toFixed(1);
            label = `thinking${'.'.repeat(1 + Math.floor(now / 300) % 3)} ${secs}s`;
            color = '#fde68a';
        } else if (ui.lastAction && now - ui.lastActionAt < 700) {
            label = { LEFT: '◀ LEFT', RIGHT: 'RIGHT ▶', SHOOT: '✦ SHOOT', STAY: '• STAY' }[ui.lastAction];
            if (ui.lastConfidence != null) label += ` ${Math.round(ui.lastConfidence * 100)}%`;
            color = ui.lastAction === 'SHOOT' ? '#fca5a5' : '#a7f3d0';
        }
        if (label) {
            ctx.font = '700 13px "JetBrains Mono", ui-monospace, monospace';
            const w = ctx.measureText(label).width + 18;
            const x = Math.min(VIEW_W - w / 2 - 4, Math.max(w / 2 + 4, this.ship.x));
            const y = rowY(PLAYER_ROW) - 70;
            ctx.fillStyle = 'rgba(2, 6, 23, 0.8)';
            ctx.beginPath();
            ctx.roundRect(x - w / 2, y - 13, w, 24, 8);
            ctx.fill();
            ctx.fillStyle = color;
            ctx.textAlign = 'center';
            ctx.fillText(label, x, y + 4);
        }
    }
}
