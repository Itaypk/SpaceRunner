/**
 * Core game rules. Pure logic, no DOM: the same World class drives the real game
 * and the heuristic bot's look-ahead simulation.
 *
 * The world is a grid: LANES columns x ROWS rows. Asteroids fall 1 row per tick,
 * lasers rise LASER_SPEED rows per tick. Working on a grid (instead of pixels)
 * makes collisions exact and gives the decision model a state it can reason about
 * ("metal, 3 rows away") instead of raw pixel distances.
 */

const LANES = 4;
const ROWS = 16;              // visible rows 0..15, spawn row is -1 (off-screen)
const PLAYER_ROW = 14;
const LASER_SPEED = 4;        // rows per tick
const START_LANE = 1;
const ACTIONS = ['LEFT', 'RIGHT', 'SHOOT', 'STAY'];

const ASTEROID_TYPES = {
    ice:   { hp: 1 },
    stone: { hp: 2 },
    metal: { hp: Infinity },  // indestructible: must be dodged
    explosive: { hp: Infinity }, // only with the "explosive" rule: shooting it destroys the ship
};

/**
 * Rule changes that can be switched on mid-game. The point: the heuristic bot's rules are
 * hard-coded and don't know about them; model pilots get one extra sentence of instructions.
 */
const RULE_CHANGES = {
    explosive: {
        title: 'Explosive asteroids',
        text: 'NEW RULE: some asteroids are now "explosive" (glowing red). An explosive asteroid cannot be destroyed: ' +
            'shooting it detonates it and the blast destroys the ship. Never shoot when the nearest asteroid in the ' +
            'ship\'s lane is explosive; dodge it like metal.',
    },
};

/** Small seeded PRNG (mulberry32) so a seed always produces the same asteroid field. */
function createRng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * The asteroid field, generated from a seed and independent of how the player plays.
 * Two runs with the same seed face exactly the same asteroids - handy for comparing
 * models side by side.
 *
 * Fairness: metal asteroids can't be shot, so a careless spawner can build an
 * unpassable metal wall. We track the set of lanes the player *could* be in at each
 * tick (starting from START_LANE) when only metal is considered, and downgrade a
 * metal spawn to stone if it would leave no surviving lane.
 */
class Track {
    constructor(seed) {
        this.rng = createRng(seed);
        this.spawns = [];            // spawns[tick] = { lane, type, variant } | null
        this.lastSpawnTick = Array(LANES).fill(-Infinity);
        this.metalAtPlayerRow = [];  // metalAtPlayerRow[tick] = Set of lanes blocked by metal
        this.reachable = [new Set([START_LANE])]; // reachable[tick] = lanes alive at end of tick
    }

    spawnFor(tick) {
        while (this.spawns.length <= tick) this.generateNext();
        return this.spawns[tick];
    }

    generateNext() {
        const tick = this.spawns.length;
        // Always draw the same number of random values per tick, so the stream stays aligned.
        const spawnRoll = this.rng(), laneRoll = this.rng(), typeRoll = this.rng(), variantRoll = this.rng();

        const spawnChance = 0.35 + Math.min(0.45, tick * 0.0015);
        const lane = Math.floor(laneRoll * LANES);
        let spawn = null;
        if (tick > 0 && spawnRoll < spawnChance && tick - this.lastSpawnTick[lane] >= 2) {
            let type = typeRoll > 0.82 ? 'metal' : typeRoll > 0.45 ? 'stone' : 'ice';
            if (type === 'metal' && !this.blockerIsFair(tick, lane)) type = 'stone';
            // Some ice/stone spawns become explosive when that rule is on. Like metal they must be
            // dodged, so they're part of the fairness check whether or not the rule is active.
            const explosiveCandidate = type !== 'metal' && variantRoll < 0.2 && this.blockerIsFair(tick, lane);
            spawn = { lane, type, variant: variantRoll, explosiveCandidate };
            this.lastSpawnTick[lane] = tick;
            if (type === 'metal' || explosiveCandidate) this.blockedSet(tick + Track.TICKS_TO_PLAYER).add(lane);
        }
        this.spawns.push(spawn);
    }

    blockedSet(tick) {
        while (this.metalAtPlayerRow.length <= tick) this.metalAtPlayerRow.push(new Set());
        return this.metalAtPlayerRow[tick];
    }

    /** Would an undestroyable asteroid spawned now in `lane` still leave a survivable path? */
    blockerIsFair(tick, lane) {
        const arrival = tick + Track.TICKS_TO_PLAYER;
        // Everything up to arrival - 1 is already final (later spawns arrive later), so
        // only the arrival tick needs checking against the cached reachable lanes.
        const known = (t, l) => this.blockedSet(t).has(l);
        while (this.reachable.length < arrival) {
            const t = this.reachable.length;
            this.reachable.push(Track.advance(this.reachable[t - 1], t, known));
        }
        const withNew = (t, l) => known(t, l) || (t === arrival && l === lane);
        return Track.advance(this.reachable[arrival - 1], arrival, withNew).size > 0;
    }

    /** Lanes the player can occupy at the end of tick t, given the lanes at t-1. */
    static advance(prev, t, blocked) {
        const next = new Set();
        for (const l of prev) {
            for (const n of [l - 1, l, l + 1]) {
                if (n < 0 || n >= LANES) continue;
                // Moving sideways also collides with an asteroid that was beside you.
                if (n !== l && blocked(t - 1, n)) continue;
                if (blocked(t, n)) continue;
                next.add(n);
            }
        }
        return next;
    }
}
// An asteroid spawned at row -1 at the end of tick t is at PLAYER_ROW at the end of tick t + 15.
Track.TICKS_TO_PLAYER = PLAYER_ROW + 1;

class World {
    constructor(seed, rules = {}) {
        this.seed = seed;
        this.rules = rules;       // active rule changes, e.g. { explosive: true }; shared, may change mid-game
        this.track = new Track(seed);
        this.tick = 0;
        this.playerLane = START_LANE;
        this.asteroids = [];
        this.lasers = [];
        this.destroyed = 0;
        this.shots = 0;
        this.status = 'playing';  // 'playing' | 'crashed'
        this.nextId = 1;
        this.events = [];         // what happened during the last tick (for rendering/logging)
    }

    get score() { return this.tick; }

    /** Copy for look-ahead simulation. Shares the (read-only) track. */
    clone() {
        const w = Object.create(World.prototype);
        Object.assign(w, this);
        w.asteroids = this.asteroids.map(a => ({ ...a }));
        w.lasers = this.lasers.map(l => ({ ...l }));
        w.events = [];
        return w;
    }

    /**
     * Advance one tick. Order matters and is documented in the prompt:
     *  1. apply the action, 2. sideways collision, 3. asteroids fall,
     *  4. lasers fly (and hit), 5. collision in the player row, 6. spawn.
     */
    step(action, { spawn = true } = {}) {
        if (this.status !== 'playing') return;
        if (!ACTIONS.includes(action)) action = 'STAY';
        this.events = [];
        this.tick++;

        // 1. Action
        if (action === 'LEFT' || action === 'RIGHT') {
            const target = this.playerLane + (action === 'LEFT' ? -1 : 1);
            if (target >= 0 && target < LANES) this.playerLane = target;
            else this.events.push({ kind: 'bump' });
        } else if (action === 'SHOOT') {
            this.lasers.push({ id: this.nextId++, lane: this.playerLane, row: PLAYER_ROW });
            this.shots++;
            this.events.push({ kind: 'shot', lane: this.playerLane });
        }

        // 2. Moved into an asteroid that is right beside us?
        if (this.checkCrash()) return;

        // 3. Asteroids fall
        for (const a of this.asteroids) a.row++;

        // 4. Lasers fly up one row at a time, so they can't tunnel through anything.
        for (const laser of this.lasers) {
            for (let s = 0; s <= LASER_SPEED && !laser.done; s++) {
                if (s > 0) laser.row--;
                // Lasers fade out before the top row, so they only ever hit asteroids that were
                // visible when the shot was decided (a new asteroid is at row 0 after its first fall).
                if (laser.row < 1) { laser.done = true; break; }
                const target = this.asteroids.find(a => a.lane === laser.lane && a.row === laser.row && a.hp > 0);
                if (target) {
                    laser.done = true;
                    this.hitAsteroid(target, laser);
                }
            }
        }
        if (this.status !== 'playing') return; // shot an explosive asteroid
        this.lasers = this.lasers.filter(l => !l.done);
        this.asteroids = this.asteroids.filter(a => a.hp > 0 && a.row <= ROWS);

        // 5. Asteroid reached our row?
        if (this.checkCrash()) return;

        // 6. New asteroid enters at the top
        if (spawn) {
            const s = this.track.spawnFor(this.tick);
            if (s) {
                const type = s.explosiveCandidate && this.rules.explosive ? 'explosive' : s.type;
                this.asteroids.push({
                    id: this.nextId++, lane: s.lane, row: -1, type,
                    hp: ASTEROID_TYPES[type].hp, variant: s.variant,
                });
            }
        }
    }

    hitAsteroid(asteroid, laser) {
        const at = { kind: '', id: asteroid.id, laserId: laser.id, lane: asteroid.lane, row: asteroid.row, type: asteroid.type };
        if (asteroid.type === 'metal') {
            this.events.push({ ...at, kind: 'deflect' });
            return;
        }
        if (asteroid.type === 'explosive') {
            asteroid.hp = 0;
            this.status = 'crashed';
            this.events.push({ ...at, kind: 'detonate' });
            this.events.push({ kind: 'crash', id: asteroid.id, type: 'explosive', cause: 'detonated', lane: this.playerLane });
            return;
        }
        asteroid.hp--;
        if (asteroid.hp <= 0) {
            this.destroyed++;
            this.events.push({ ...at, kind: 'destroy' });
        } else {
            this.events.push({ ...at, kind: 'hit' });
        }
    }

    checkCrash() {
        const hit = this.asteroids.find(a => a.lane === this.playerLane && a.row === PLAYER_ROW);
        if (!hit) return false;
        this.status = 'crashed';
        this.events.push({ kind: 'crash', id: hit.id, type: hit.type, lane: this.playerLane });
        return true;
    }

    /**
     * What a decision maker gets to see: visible asteroids per lane, nearest first.
     * rows_away = ticks until the asteroid reaches the player's row if nothing changes.
     */
    observe() {
        const lanes = [];
        for (let lane = 0; lane < LANES; lane++) {
            const asteroids = this.asteroids
                .filter(a => a.lane === lane && a.row >= 0 && a.row <= PLAYER_ROW)
                .sort((a, b) => b.row - a.row)
                .slice(0, 3)
                .map(a => {
                    const o = { type: a.type, rows_away: PLAYER_ROW - a.row };
                    if (a.type === 'ice' || a.type === 'stone') o.hits_left = a.hp;
                    return o;
                });
            const lasers = this.lasers.filter(l => l.lane === lane).length;
            const info = { lane, asteroids };
            if (lasers) info.lasers_in_flight = lasers;
            lanes.push(info);
        }
        return { turn: this.tick, player_lane: this.playerLane, lanes };
    }
}
