/**
 * Canvas renderer. Logic happens in discrete ticks. To make motion continuous, each
 * tick animates every object linearly from where it is drawn now to its new grid
 * position over the expected time until the next tick, so the drawing runs at most
 * one tick behind the logic. Hits and crashes are shown where the sprites visually
 * meet, not where the grid says they happened.
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

// The ship covers rows PLAYER_ROW (nose) and PLAYER_ROW + 1 (body); its nose touches an
// asteroid in PLAYER_ROW - 1 just as that asteroid is about to hit.
const SHIP_SIZE = 84;
const SHIP_Y = rowY(PLAYER_ROW) + ROW_H / 2 + 8;
const NOSE_Y = SHIP_Y - SHIP_SIZE / 2;
const LASER_PX_PER_TICK = LASER_SPEED * ROW_H;
const LANE_CHANGE_MS = 220;  // lane changes are quicker than a tick, so steering feels responsive

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = t => Math.max(0, Math.min(1, t));
const easeInOut = t => t * t * (3 - 2 * t);

class Renderer {
    constructor(canvas, sprites) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.sprites = sprites;
        this.lastFrame = performance.now();
        this.stars = Array.from({ length: 110 }, () => ({
            x: Math.random() * VIEW_W, y: Math.random() * VIEW_H,
            size: Math.random() * 1.6 + 0.4, speed: Math.random() * 40 + 15,
            phase: Math.random() * Math.PI * 2,
        }));
        this.reset();
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
        this.visuals = new Map();   // entity id -> { fromX, fromY, toX, toY, ... }
        this.dying = [];            // removed entities still drawn until they visually meet their end
        this.effects = [];          // short-lived animations
        this.anim = { start: performance.now(), duration: 1, freezeAt: Infinity };
        this.ship = { fromX: laneX(START_LANE), toX: laneX(START_LANE) };
        this.shipHiddenAt = Infinity;
    }

    /** Animation progress 0..1 of the current tick (stops at the moment of a crash). */
    progress(now) {
        return clamp01((Math.min(now, this.anim.freezeAt) - this.anim.start) / this.anim.duration);
    }

    shipX(now) {
        const t = clamp01((Math.min(now, this.anim.freezeAt) - this.anim.start) / Math.min(LANE_CHANGE_MS, this.anim.duration));
        return lerp(this.ship.fromX, this.ship.toX, easeInOut(t));
    }

    /**
     * Called after every tick. durationMs: how long until the next tick is expected,
     * i.e. how long the movement of this tick should take on screen.
     */
    onTick(world, durationMs) {
        const now = performance.now();
        const p = this.progress(now);
        // Start every object from where it is drawn right now, so nothing jumps.
        for (const v of this.visuals.values()) {
            v.fromX = lerp(v.fromX, v.toX, p);
            v.fromY = lerp(v.fromY, v.toY, p);
        }
        this.ship.fromX = this.shipX(now);
        this.ship.toX = laneX(world.playerLane);
        this.anim = { start: now, duration: Math.max(1, durationMs), freezeAt: Infinity };

        const live = new Set();
        for (const a of world.asteroids) {
            live.add(a.id);
            let v = this.visuals.get(a.id);
            if (!v) {
                v = { fromX: laneX(a.lane), fromY: rowY(a.row - 1), shownHp: a.hp, hpAt: 0, flashAt: 0 };
                this.visuals.set(a.id, v);
            }
            v.toX = laneX(a.lane);
            v.toY = rowY(a.row);
            v.asteroid = a;
        }
        for (const l of world.lasers) {
            live.add(l.id);
            let v = this.visuals.get(l.id);
            if (!v) { v = { fromX: laneX(l.lane), fromY: NOSE_Y, laser: true }; this.visuals.set(l.id, v); }
            v.toX = laneX(l.lane);
            v.toY = rowY(l.row);
        }

        let impactT = 0; // when (0..1) a detonation's blast happens, for the crash that follows
        for (const e of world.events) {
            switch (e.kind) {
                case 'shot':
                    this.addEffect('spark_b', laneX(e.lane), NOSE_Y - 6, 36, 140);
                    break;
                case 'hit': case 'deflect': case 'destroy': case 'detonate':
                    impactT = this.resolveHit(e, now);
                    break;
                case 'crash':
                    this.resolveCrash(e, now, impactT);
                    break;
            }
        }

        // Lasers leaving the top keep flying until they're off screen; anything else just goes.
        for (const [id, v] of this.visuals) {
            if (live.has(id)) continue;
            if (v.laser) this.dying.push({ laser: true, x: v.toX, y: v.fromY, vy: -LASER_PX_PER_TICK / this.anim.duration, start: now, end: now + 600 });
            this.visuals.delete(id);
        }
    }

    /** A laser met an asteroid: keep both on screen until they visually touch. Returns that moment (0..1). */
    resolveHit(e, now) {
        const duration = this.anim.duration;
        const astV = this.visuals.get(e.id);
        const astToY = rowY(e.row);
        const astFromY = astV ? astV.fromY : astToY - ROW_H;
        const x = laneX(e.lane);
        // The laser was drawn at its previous position, or leaves the ship's nose if it was fired this tick.
        const laserV = this.visuals.get(e.laserId);
        const laserFromY = laserV ? laserV.fromY : NOSE_Y;
        this.visuals.delete(e.laserId);
        // Laser tip moves up LASER_PX_PER_TICK per tick, the asteroid's lower edge moves down.
        const gap = laserFromY - 36 - (astFromY + 36);
        const t = clamp01(gap / (LASER_PX_PER_TICK + (astToY - astFromY)));
        const meetMs = t * duration;
        const y = lerp(astFromY, astToY, t);
        this.dying.push({ laser: true, x, y: laserFromY, vy: -LASER_PX_PER_TICK / duration, start: now, end: now + meetMs });

        if (e.kind === 'hit' || e.kind === 'deflect') {
            if (astV) { astV.flashAt = now + meetMs; astV.hpAt = now + meetMs; }
            if (e.kind === 'hit') this.addEffect('spark_a', x, y + 30, 70, 260, { delay: meetMs });
            else this.addEffect('spark_b', x, y + 35, 60, 220, { delay: meetMs });
            return t;
        }
        // Destroyed: keep the asteroid falling until the laser reaches it.
        if (astV) {
            this.dying.push({ asteroid: astV.asteroid, x, y: astFromY, vy: (astToY - astFromY) / duration, start: now, end: now + meetMs });
            this.visuals.delete(e.id);
        }
        if (e.kind === 'destroy') {
            this.addEffect(e.type === 'ice' ? 'ice_shards' : 'stone_debris_b', x, y, 100, 450, { delay: meetMs, grow: 0.5 });
            this.addEffect('spark_b', x, y + 20, 70, 220, { delay: meetMs });
        } else { // detonate: the rock cracks open, bursts, then the blast
            this.addEffect('explosive_cracking', x, y, 88, 130, { delay: meetMs, fade: false });
            this.addEffect('explosive_burst', x, y, 92, 170, { delay: meetMs + 130, fade: false });
            this.addEffect('explosion', x, y, 200, 700, { delay: meetMs + 280, grow: 0.4 });
            this.addEffect('smoke', x, y, 210, 1500, { delay: meetMs + 650, grow: 0.3 });
        }
        return t;
    }

    /** The ship is destroyed: freeze the scene where the sprites touch and blow it up there. */
    resolveCrash(e, now, impactT) {
        const duration = this.anim.duration;
        let t;
        if (e.cause === 'detonated') t = impactT;               // frozen when the blast goes off
        else if (this.ship.fromX !== this.ship.toX) t = 0.5;    // slid sideways into it, halfway
        else t = 0.05;                                         // fell onto the nose: already touching
        const shipT = Math.min(t * duration, LANE_CHANGE_MS) / Math.min(LANE_CHANGE_MS, duration);
        const sx = lerp(this.ship.fromX, this.ship.toX, easeInOut(clamp01(shipT)));
        const at = t * duration + (e.cause === 'detonated' ? 280 : 0); // wait for the shockwave
        this.anim.freezeAt = now + t * duration;
        this.shipHiddenAt = now + at;
        const spin = { rotation: WRECK_ROTATION, fade: false };
        this.addEffect('ship_hit', sx, SHIP_Y, 96, 160, { ...spin, delay: at });
        this.addEffect('ship_breaking', sx, SHIP_Y, 96, 260, { ...spin, delay: at + 160 });
        this.addEffect('explosion', sx, SHIP_Y - 10, 150, 650, { delay: at + 220, grow: 0.3 });
        this.addEffect('ship_wreck', sx, SHIP_Y, 96, 1900, { rotation: WRECK_ROTATION, delay: at + 420, vy: 22 });
        this.addEffect('smoke', sx, SHIP_Y, 170, 1600, { delay: at + 650, grow: 0.25 });
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

    asteroidSprite(a, hp) {
        const pick = list => list[Math.floor(a.variant * list.length) % list.length];
        if (a.type === 'ice') return { name: pick(['ice_a', 'ice_b']), size: 80, spin: 0.4 };
        if (a.type === 'metal') return { name: pick(['metal_a', 'metal_b', 'metal_c']), size: 88, spin: 0.15 };
        if (a.type === 'explosive') return { name: 'explosive', size: 84, spin: 0.6, pulse: true };
        return { name: hp >= 2 ? pick(['stone_a', 'stone_b', 'stone_c']) : 'stone_cracked', size: 84, spin: 0.3 };
    }

    drawAsteroid(a, x, y, now, { hp = a.hp, flash = false } = {}) {
        const ctx = this.ctx;
        const { name, size, spin, pulse } = this.asteroidSprite(a, hp);
        const rotation = (now / 1000) * spin * (a.variant > 0.5 ? 1 : -1) + a.variant * 6;
        if (pulse) { // unstable: a throbbing red glow behind it
            const glow = 0.35 + 0.25 * Math.sin(now / 140);
            const g = ctx.createRadialGradient(x, y, 10, x, y, size * 0.75);
            g.addColorStop(0, `rgba(255, 80, 40, ${glow})`);
            g.addColorStop(1, 'rgba(255, 80, 40, 0)');
            ctx.fillStyle = g;
            ctx.fillRect(x - size, y - size, size * 2, size * 2);
        }
        this.drawSprite(name, x, y, size, rotation);
        if (flash) {
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            this.drawSprite(name, x, y, size, rotation, 0.6);
            ctx.restore();
        }
    }

    /**
     * ui: { paused, thinkingSince, lastAction, lastActionAt, lastConfidence, showOverlay, controllerLabel }
     */
    render(world, ui) {
        const now = performance.now();
        const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
        this.lastFrame = now;
        const p = this.progress(now);
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

        // Things that are gone logically but haven't visually reached their end yet
        const frozenNow = Math.min(now, this.anim.freezeAt);
        this.dying = this.dying.filter(d => now < d.end || this.anim.freezeAt < d.end); // frozen by a crash: keep
        for (const d of this.dying) {
            const tNow = Math.min(frozenNow, d.end);
            if (tNow >= d.end) continue;
            const y = d.y + d.vy * (tNow - d.start);
            if (d.laser) this.drawSprite('laser_a', d.x, y, 66, -Math.PI / 2);
            else this.drawAsteroid(d.asteroid, d.x, y, now);
        }

        // Asteroids and lasers
        for (const [, v] of this.visuals) {
            const x = lerp(v.fromX, v.toX, p), y = lerp(v.fromY, v.toY, p);
            if (v.laser) { this.drawSprite('laser_a', x, y, 66, -Math.PI / 2); continue; }
            const a = v.asteroid;
            if (now >= v.hpAt) v.shownHp = a.hp; // the cracked look appears when the laser lands
            this.drawAsteroid(a, x, y, now, { hp: v.shownHp, flash: now >= v.flashAt && now < v.flashAt + 160 });
            if (ui.showOverlay && a.row >= 0 && a.row <= PLAYER_ROW + 1) this.drawBadge(x + 36, y - 32, Math.max(0, PLAYER_ROW - a.row), a.type);
        }

        // Ship
        const shipX = this.shipX(now);
        const moving = this.ship.toX - this.ship.fromX;
        const laneT = clamp01((frozenNow - this.anim.start) / Math.min(LANE_CHANGE_MS, this.anim.duration));
        const tilt = Math.sign(moving) * Math.sin(Math.PI * laneT) * 0.3;
        this.shipDrawX = shipX;
        if (now < this.shipHiddenAt) {
            const frame = Math.floor(now / 90) % 2 ? 'ship_a' : 'ship_b';
            const bob = Math.sin(now / 260) * 2;
            this.drawSprite(frame, shipX, SHIP_Y + bob, SHIP_SIZE, tilt);
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

        if (now >= this.shipHiddenAt) return;
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
            const x = Math.min(VIEW_W - w / 2 - 4, Math.max(w / 2 + 4, this.shipDrawX));
            const y = SHIP_Y - 72;
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
