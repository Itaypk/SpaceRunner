/**
 * Decision makers. Each one turns the current world into one of ACTIONS.
 *  - HeuristicBot: a small look-ahead search. A non-LLM baseline to compare against.
 *  - DecisionAgent: a decision model (e.g. nimble) via Ollama's /v1/systemone endpoint.
 *  - LlmAgent: a general chat LLM via /api/chat. The "too slow for this" comparison.
 */

class HeuristicBot {
    constructor(depth = 6) {
        this.depth = depth;
        this.name = 'Heuristic bot';
        // The bot's rulebook is frozen in code, written before any rule change existed.
        // Like most hand-written policies ("if metal: dodge, else: shoot"), anything that
        // isn't metal is treated as a breakable rock.
        this.knownTypes = ['ice', 'stone', 'metal'];
    }

    /** Try every action sequence `depth` ticks ahead (4^6 = 4096 cheap simulations, ~1-2 ms). */
    decide(world) {
        const sim = world.clone();
        sim.rules = {};
        const unknown = new Set();
        sim.asteroids = sim.asteroids
            .filter(a => a.row >= 0) // only what's visible
            .map(a => {
                if (this.knownTypes.includes(a.type)) return a;
                unknown.add(a.type);
                return { ...a, type: 'ice', hp: 1 };
            });
        let best = { action: 'STAY', value: -Infinity };
        for (const action of ['STAY', 'SHOOT', 'LEFT', 'RIGHT']) {
            const value = this.search(sim, action, this.depth);
            if (value > best.value) best = { action, value };
        }
        let reasoning = `look-ahead value ${best.value.toFixed(1)}`;
        if (unknown.size) reasoning += ` · doesn't know "${[...unknown].join(', ')}", treats it as ice`;
        return { action: best.action, reasoning };
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
- LEFT / RIGHT: move one lane immediately. Moving into a lane where an asteroid has rows_away 0 (beside you)
  or 1 is a crash, even if your own lane is clear.
- SHOOT: fire a laser up your current lane. It travels 4 rows per turn and damages the first asteroid it meets.
  A laser fired when an asteroid is at rows_away 1 still hits it before it reaches you.
- STAY: do nothing this turn.

Each turn you receive the current state as JSON: per lane, the nearest asteroids (closest first) and any lasers already in flight.

STRATEGY
- Only change lanes when your own lane is threatened by something you can't shoot in time.
  Every move into another lane is a risk.
- Before choosing LEFT or RIGHT, check the target lane: any asteroid there with rows_away 0 or 1 means a crash.

Survive as long as possible. Destroying asteroids is a bonus, surviving is what counts.`;

// Two variants, matching the two state formats (raw grid facts vs. pre-digested lane facts).
const DEFAULT_DECISION_INSTRUCTIONS = {
    raw: `The state describes a spaceship in a 4-lane asteroid field, seen from above. Lanes are numbered 0 (far left) to 3 (far right); the ship is in \`player_lane\`.
Each entry in \`lanes\` lists that lane's nearest asteroids, closest first. \`rows_away\` is how many turns until the asteroid reaches the ship's row; asteroids move 1 row per turn.
If an asteroid reaches the ship's row in the ship's lane, the ship is destroyed. Ice needs 1 laser hit, stone needs 2 (\`hits_left\`), metal cannot be destroyed and must be dodged.
Changing lanes is only safe if the target lane has no asteroid at rows_away 0 (beside the ship) or 1, even when the ship's own lane is clear. Only change lanes when the ship's own lane is threatened.
Which action keeps the ship alive this turn and in the turns after it?`,
    digested: `The state describes a spaceship flying through an asteroid field, seen from above.
\`current_lane\` is the ship's lane: \`threat\` says what is coming ("none", "shootable" for ice/stone, "must_dodge" for metal, "unknown" for other types; \`nearest\` names the type) and \`turns_to_impact\` says how soon it hits the ship if the ship stays.
\`left_lane\` and \`right_lane\` describe the neighbouring lanes: \`exists\` is false at the edge of the field, and \`safe_to_enter\` says whether moving there this turn is safe; if not, \`blocked_by\` says why, and moving there crashes the ship. Their \`threat\` and \`turns_to_impact\` describe what comes next in that lane.
Only change lanes when the ship's own lane is threatened, and never into a lane that isn't safe to enter.
A metal asteroid can only be dodged. Ice and stone can be shot, but stone needs 2 hits (\`hits_left\`).
Which action keeps the ship alive this turn and in the turns after it?`,
};

/**
 * Pre-compute the facts a decision model would otherwise have to work out with arithmetic
 * ("is rows_away <= 1?"), framed relative to the ship so they map onto the action options.
 */
const THREAT_BY_TYPE = { ice: 'shootable', stone: 'shootable', metal: 'must_dodge' };

function digestObservation(obs) {
    const describe = lane => {
        const info = obs.lanes[lane];
        if (!info) return { exists: false };
        const ahead = info.asteroids.filter(a => a.rows_away >= 1);
        const nearest = ahead[0];
        const out = {
            exists: true,
            // Facts only: a type this code doesn't know about is reported as "unknown", not guessed.
            threat: !nearest ? 'none' : THREAT_BY_TYPE[nearest.type] || 'unknown',
        };
        if (nearest) {
            out.nearest = nearest.type;
            out.turns_to_impact = nearest.rows_away;
            if (nearest.hits_left) out.hits_left = nearest.hits_left;
        }
        if (info.lasers_in_flight) out.lasers_in_flight = info.lasers_in_flight;
        return out;
    };
    const side = lane => {
        const d = describe(lane);
        if (!d.exists) return d;
        // An asteroid beside the ship isn't "ahead", so `threat` can't show it. Say explicitly
        // why a lane is blocked, so the two signals never look contradictory.
        const blocking = obs.lanes[lane].asteroids.find(a => a.rows_away <= 1);
        const out = { exists: true, safe_to_enter: !blocking };
        if (blocking) out.blocked_by = `${blocking.type} ${blocking.rows_away === 0 ? 'beside the ship' : 'arriving next turn'}`;
        return { ...out, ...d };
    };
    const lane = obs.player_lane;
    return { turn: obs.turn, current_lane: describe(lane), left_lane: side(lane - 1), right_lane: side(lane + 1) };
}

// Option descriptions for the choice question. Order matters: ties go to the earlier option.
const DEFAULT_DECISION_CRITERIA = {
    STAY: 'Stay in the current lane and do nothing. Right when nothing in the ship\'s lane is about to arrive.',
    SHOOT: 'Fire a laser up the current lane. Right when the nearest asteroid in the ship\'s lane is ice or stone.',
    LEFT: 'Move one lane to the left (lane number - 1). Only right when the current lane is threatened and the left lane is safe to enter; a crash if anything in the left lane is beside the ship or arrives next turn.',
    RIGHT: 'Move one lane to the right (lane number + 1). Only right when the current lane is threatened and the right lane is safe to enter; a crash if anything in the right lane is beside the ship or arrives next turn.',
};

const withNotes = (text, notes) => notes ? `${text}\n\n${notes}` : text;

/** Fingerprints of earlier default prompts, so saved-but-unedited copies get upgraded. */
const promptHash = s => { let x = 5381; for (let i = 0; i < s.length; i++) x = ((x * 33) ^ s.charCodeAt(i)) >>> 0; return x; };
const LEGACY_DEFAULT_HASHES = {
    systemPrompt: [462703211],
    decisionInstructions: [3465441998, 247429411], // raw, digested
};

/** Shared plumbing for talking to a local Ollama server. */
class OllamaClient {
    constructor() {
        this.baseUrl = 'http://localhost:11434';
        this.model = '';
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

    /** POST JSON; returns { data, latencyMs }. Throws OllamaError (with .status) or AbortError. */
    async post(path, body) {
        this.abort();
        this.controller = new AbortController();
        const started = performance.now();
        let res;
        try {
            res = await fetch(this.url(path), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: this.controller.signal,
            });
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            throw new OllamaError(
                `Can't reach Ollama at ${this.baseUrl}. Is it running? If it is, it's probably CORS: ` +
                `open the game from http://localhost (see README) or set OLLAMA_ORIGINS.`);
        }
        const text = await res.text();
        let data = {};
        try { data = JSON.parse(text); } catch (_) { data = { error: text.trim() }; }
        if (!res.ok) throw new OllamaError(data.error || `HTTP ${res.status}`, res.status);
        return { data, latencyMs: Math.round(performance.now() - started) };
    }
}

class OllamaError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.status = status;
    }
}

/**
 * A decision model (e.g. nimble) through Ollama's decision endpoint, POST /v1/systemone.
 * No text generation: the model scores the given options directly and returns a
 * probability per option, which is why it's fast enough to act every tick.
 */
class DecisionAgent extends OllamaClient {
    constructor() {
        super();
        this.name = 'Decision model';
        this.model = 'nimble';
        this.instructions = DEFAULT_DECISION_INSTRUCTIONS.digested;
        this.criteria = DEFAULT_DECISION_CRITERIA;
        this.digestState = true;
        this.askDanger = false;
        this.ruleNotes = '';      // extra rule text, appended when a rule change is active
    }

    /** What actually goes into `state`. */
    stateFor(observation) {
        return this.digestState ? digestObservation(observation) : observation;
    }

    buildRequest(observation) {
        const questions = {
            action: { type: 'choice', instructions: withNotes(this.instructions, this.ruleNotes), criteria: this.criteria },
        };
        if (this.askDanger) {
            // A second, independent yes/no question. Each question is scored separately, so it costs latency.
            questions.danger = {
                type: 'noul',
                instructions: 'Will an asteroid in the ship\'s current lane reach the ship within the next 3 turns?',
            };
        }
        return { model: this.model, state: this.stateFor(observation), questions, keep_alive: '30m' };
    }

    /** Returns { action, valid, probabilities, confidence, danger, raw, latencyMs, usage, request }. */
    async decide(observation) {
        const request = this.buildRequest(observation);
        let result;
        try {
            result = await this.post('/v1/systemone', request);
        } catch (err) {
            if (err instanceof OllamaError) throw DecisionAgent.explain(err, this.model);
            throw err;
        }
        const { data, latencyMs } = result;
        const answer = (data.answers && data.answers.action) || {};
        const valid = ACTIONS.includes(answer.choice);
        return {
            action: valid ? answer.choice : 'STAY',
            valid,
            probabilities: answer.probabilities || {},
            confidence: answer.confidence,
            danger: data.answers && data.answers.danger ? data.answers.danger.noul : undefined,
            usage: data.usage,
            raw: JSON.stringify(data, null, 2),
            latencyMs,
            request,
        };
    }

    static explain(err, model) {
        if (err.status === 404 && /model/i.test(err.message)) {
            return new OllamaError(`Model "${model}" not found. Run: ollama pull ${model || 'nimble'}`, 404);
        }
        if (err.status === 404) {
            return new OllamaError('This Ollama has no /v1/systemone endpoint. Decision models need Ollama v0.35.0 or newer.', 404);
        }
        if (err.status === 400) {
            return new OllamaError(`Ollama rejected the request: ${err.message}. Is "${model}" a decision model (e.g. nimble)?`, 400);
        }
        return new OllamaError(`Ollama error: ${err.message}`, err.status);
    }
}

/** A general chat LLM via /api/chat with structured output. Kept to show why it's too slow per tick. */
class LlmAgent extends OllamaClient {
    constructor() {
        super();
        this.name = 'LLM';
        this.systemPrompt = DEFAULT_SYSTEM_PROMPT;
        this.temperature = 0.2;
        this.withReasoning = true;
        this.disableThinking = true;
        this.thinkUnsupported = false; // learned from the server's response
        this.ruleNotes = '';
    }

    stateFor(observation) { return observation; }

    schema() {
        const action = { type: 'string', enum: ACTIONS };
        if (!this.withReasoning) return { type: 'object', properties: { action }, required: ['action'] };
        // Reasoning comes first so the model "thinks" before it commits to an action.
        return { type: 'object', properties: { reasoning: { type: 'string' }, action }, required: ['reasoning', 'action'] };
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
                { role: 'system', content: `${withNotes(this.systemPrompt, this.ruleNotes)}\n\n${responseHint}` },
                { role: 'user', content: JSON.stringify(observation) },
            ],
        };
        // Thinking models (qwen3, deepseek-r1, ...) can be several times slower when they think.
        if (this.disableThinking && !this.thinkUnsupported) body.think = false;
        return body;
    }

    /** Returns { action, reasoning, thinking, raw, valid, latencyMs, tokensPerSec, loadMs, request }. */
    async decide(observation) {
        const request = this.buildRequest(observation);
        let result;
        try {
            result = await this.post('/api/chat', request);
        } catch (err) {
            if (err instanceof OllamaError && request.think === false && /think/i.test(err.message)) {
                this.thinkUnsupported = true; // older server or model without the option: retry once
                return this.decide(observation);
            }
            if (err instanceof OllamaError) throw new OllamaError(`Ollama error: ${err.message}`, err.status);
            throw err;
        }
        const { data, latencyMs } = result;
        const raw = (data.message && data.message.content) || '';
        return {
            ...LlmAgent.parse(raw),
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
