/**
 * Decision makers. Each one turns the current world into one of ACTIONS.
 *  - HeuristicBot: a small look-ahead search. A non-LLM baseline to compare against.
 *  - OllamaAgent: asks a local model served by Ollama, via its /api/chat endpoint.
 */

class HeuristicBot {
    constructor(depth = 5) {
        this.depth = depth;
        this.name = 'Heuristic bot';
    }

    /** Try every action sequence `depth` ticks ahead (4^5 = 1024 cheap simulations). */
    decide(world) {
        const sim = world.clone();
        sim.asteroids = sim.asteroids.filter(a => a.row >= 0); // only what's visible
        let best = { action: 'STAY', value: -Infinity };
        for (const action of ['STAY', 'SHOOT', 'LEFT', 'RIGHT']) {
            const value = this.search(sim, action, this.depth);
            if (value > best.value) best = { action, value };
        }
        return { action: best.action, reasoning: `look-ahead value ${best.value.toFixed(1)}` };
    }

    search(world, action, depth) {
        const next = world.clone();
        next.step(action, { spawn: false });
        if (next.status === 'crashed') return -1000 + (this.depth - depth) * 50;
        if (depth <= 1) return this.evaluate(next);
        let best = -Infinity;
        for (const a of ACTIONS) best = Math.max(best, this.search(next, a, depth - 1));
        return best;
    }

    evaluate(world) {
        let value = world.destroyed * 4 - world.shots * 0.2;
        for (const a of world.asteroids) {
            if (a.lane !== world.playerLane || a.row > PLAYER_ROW || a.row < 0) continue;
            const distance = PLAYER_ROW - a.row;
            value -= (a.type === 'metal' ? 12 : 3) / Math.max(1, distance);
        }
        if (world.playerLane === 0 || world.playerLane === LANES - 1) value -= 0.5; // edges limit escape
        return value;
    }
}

const DEFAULT_SYSTEM_PROMPT = `You are piloting a spaceship through an asteroid field. Every turn you pick exactly one action.

THE WORLD
- There are 4 lanes, numbered 0 (far left) to 3 (far right). You are in "player_lane".
- Asteroids fly toward you, 1 row per turn. "rows_away" is how many turns until an asteroid reaches your row.
- If an asteroid reaches your row while you are in its lane, you crash and the game is over.
- Asteroid types:
  - ice: destroyed by 1 laser hit
  - stone: destroyed by 2 laser hits ("hits_left" tells you how many are still needed)
  - metal: indestructible. You MUST dodge it.

ACTIONS
- LEFT / RIGHT: move one lane immediately. Moving into a lane where an asteroid has rows_away 0 or 1 is a crash.
- SHOOT: fire a laser up your current lane. It travels 4 rows per turn and damages the first asteroid it meets.
  A laser fired when an asteroid is at rows_away 1 still hits it before it reaches you.
- STAY: do nothing this turn.

Each turn you receive the current state as JSON: per lane, the nearest asteroids (closest first) and any lasers already in flight.

Survive as long as possible. Destroying asteroids is a bonus, surviving is what counts.`;

class OllamaAgent {
    constructor() {
        this.name = 'Ollama';
        this.baseUrl = 'http://localhost:11434';
        this.model = '';
        this.systemPrompt = DEFAULT_SYSTEM_PROMPT;
        this.temperature = 0.2;
        this.withReasoning = true;
        this.disableThinking = true;
        this.thinkUnsupported = false; // learned from the server's response
        this.controller = null;
    }

    abort() {
        if (this.controller) this.controller.abort();
        this.controller = null;
    }

    url(path) { return this.baseUrl.replace(/\/+$/, '') + path; }

    async listModels() {
        const res = await fetch(this.url('/api/tags'));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return (data.models || []).map(m => m.name).sort();
    }

    schema() {
        const properties = { action: { type: 'string', enum: ACTIONS } };
        const required = ['action'];
        if (this.withReasoning) {
            // Reasoning comes first so the model "thinks" before it commits to an action.
            return {
                type: 'object',
                properties: { reasoning: { type: 'string' }, ...properties },
                required: ['reasoning', ...required],
            };
        }
        return { type: 'object', properties, required };
    }

    buildRequest(observation) {
        const responseHint = this.withReasoning
            ? 'Reply with JSON: {"reasoning": "<one or two short sentences>", "action": "LEFT|RIGHT|SHOOT|STAY"}'
            : 'Reply with JSON: {"action": "LEFT|RIGHT|SHOOT|STAY"}';
        const body = {
            model: this.model,
            stream: false,
            keep_alive: '30m',
            format: this.schema(),
            options: { temperature: this.temperature },
            messages: [
                { role: 'system', content: `${this.systemPrompt}\n\n${responseHint}` },
                { role: 'user', content: JSON.stringify(observation) },
            ],
        };
        // Thinking models (qwen3, deepseek-r1, ...) can be several times slower when they think.
        if (this.disableThinking && !this.thinkUnsupported) body.think = false;
        return body;
    }

    /**
     * Returns { action, reasoning, thinking, raw, valid, latencyMs, tokensPerSec, loadMs, request }.
     * Throws OllamaError for connection/server problems, AbortError if aborted.
     */
    async decide(observation) {
        this.abort();
        this.controller = new AbortController();
        const request = this.buildRequest(observation);
        const started = performance.now();
        let res;
        try {
            res = await fetch(this.url('/api/chat'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
                signal: this.controller.signal,
            });
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            throw new OllamaError(
                `Can't reach Ollama at ${this.baseUrl}. Is it running? If it is, it's probably CORS: ` +
                `open the game from http://localhost (see README) or set OLLAMA_ORIGINS.`);
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = data.error || `HTTP ${res.status}`;
            if (request.think === false && /think/i.test(msg)) {
                this.thinkUnsupported = true; // older server or model without the option: retry once
                return this.decide(observation);
            }
            throw new OllamaError(`Ollama error: ${msg}`);
        }
        const latencyMs = Math.round(performance.now() - started);
        const raw = (data.message && data.message.content) || '';
        const parsed = OllamaAgent.parse(raw);
        return {
            ...parsed,
            raw,
            thinking: data.message && data.message.thinking,
            latencyMs,
            loadMs: data.load_duration ? Math.round(data.load_duration / 1e6) : 0,
            tokensPerSec: data.eval_count && data.eval_duration
                ? Math.round(data.eval_count / (data.eval_duration / 1e9)) : null,
            request,
        };
    }

    /** Structured output should give valid JSON; still be defensive with odd models. */
    static parse(raw) {
        try {
            const obj = JSON.parse(raw);
            const action = String(obj.action || '').toUpperCase().trim();
            if (ACTIONS.includes(action)) return { action, reasoning: obj.reasoning || '', valid: true };
        } catch (_) { /* fall through */ }
        const match = raw.toUpperCase().match(/\b(LEFT|RIGHT|SHOOT|STAY)\b/);
        if (match) return { action: match[1], reasoning: '', valid: false };
        return { action: 'STAY', reasoning: '', valid: false };
    }
}

class OllamaError extends Error {}
