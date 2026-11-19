/**
 * Wires everything together: the tick loop, the four pilots (keyboard, bot, decision model, LLM),
 * the clock modes (real-time / turn-based / paused + step) and the side panels.
 *
 * Clock semantics, which is the point of the demo:
 *  - Real-time:  the world ticks every `tickMs`. A decision that isn't ready by the
 *                deadline means the ship does nothing (STAY) that tick; the request keeps
 *                running and its answer is applied, late, on a later tick.
 *  - Turn-based: the world waits for each decision (tickMs becomes a minimum delay).
 *  - Paused:     nothing moves; "Step" (N) runs exactly one tick.
 */

const INTERRUPTED = Symbol('interrupted');
const TIMEOUT = Symbol('timeout');

// ---------- settings (persisted per browser, best effort) ----------
const DEFAULT_SETTINGS = {
    controller: 'keyboard', pacing: 'realtime', tickMs: 350, seed: 1234, showOverlay: true,
    baseUrl: 'http://localhost:11434', model: '', temperature: 0.2,
    withReasoning: true, disableThinking: true, systemPrompt: DEFAULT_SYSTEM_PROMPT,
    decisionModel: 'nimble', digestState: true, askDanger: false,
    decisionInstructions: DEFAULT_DECISION_INSTRUCTIONS.digested,
    ruleExplosive: false,
};
const settings = { ...DEFAULT_SETTINGS, ...readStorage('spacerunner.settings', {}) };
function readStorage(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (_) { return fallback; }
}
function writeStorage(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* private mode etc. */ }
}
const saveSettings = () => writeStorage('spacerunner.settings', settings);

// ---------- state ----------
const $ = id => document.getElementById(id);
const bot = new HeuristicBot();
const llm = new LlmAgent();
const decider = new DecisionAgent();
/** The two pilots that call a model. 'ollama' is the chat LLM (name kept for saved settings). */
const MODEL_PILOTS = {
    decision: { agent: decider, actor: 'Decision', model: () => settings.decisionModel },
    ollama: { agent: llm, actor: 'LLM', model: () => settings.model },
};
let renderer;
/** Active rule changes, shared with the world so they can be toggled mid-game. */
const activeRules = { explosive: settings.ruleExplosive };
const ruleNotes = () => Object.keys(RULE_CHANGES).filter(k => activeRules[k]).map(k => RULE_CHANGES[k].text).join('\n');
let world = new World(settings.seed, activeRules);
let phase = 'menu';            // 'menu' | 'playing' | 'over'
let paused = false;
let stepRequested = false;
let pendingKey = null;
let runId = 0;
let inflight = null;           // pending LLM request: { promise, forTick }
let stats;
const ui = { thinkingSince: 0, lastAction: null, lastActionAt: 0, lastConfidence: null };
let runs = readStorage('spacerunner.runs', []);

/** Something changed (key, pause, step...): wake up whoever waits. */
let wakeWaiters = [];
const waitForWake = () => new Promise(r => wakeWaiters.push(r));
function wake() { const w = wakeWaiters; wakeWaiters = []; w.forEach(r => r()); }

/** Cancel in-progress waits for a decision (controller switch, restart). */
const interrupts = new Set();
function interruptible(promise) {
    let resolveIntr;
    const intr = new Promise(r => { resolveIntr = r; interrupts.add(r); });
    return Promise.race([promise, intr]).finally(() => interrupts.delete(resolveIntr));
}
function interruptAll() { for (const r of interrupts) r(INTERRUPTED); interrupts.clear(); }
const sleep = ms => new Promise(r => setTimeout(r, Math.max(0, ms)));

function resetStats() {
    stats = { decisions: 0, latencies: [], invalid: 0, missed: 0, lastTps: null, confidences: [] };
}

// ---------- game lifecycle ----------
function startGame(seed = settings.seed) {
    settings.seed = seed;
    saveSettings();
    $('seed').value = seed;
    runId++;
    abortThinking();
    interruptAll();
    world = new World(seed, activeRules);
    renderer.reset();
    resetStats();
    pendingKey = null;
    phase = 'playing';
    $('overlay').classList.add('hidden');
    log('System', `New game · seed ${seed} · ${pilotLabel()} · ${settings.pacing}${activeRules.explosive ? ' · rule: explosive' : ''}`, 'sys');
    refreshUi();
    loop(runId);
}

function gameOver() {
    phase = 'over';
    abortThinking();
    const crash = world.events.find(e => e.kind === 'crash');
    const cause = !crash ? 'Crashed' : crash.cause === 'detonated' ? 'Shot an explosive asteroid' : `Crashed into ${crash.type}`;
    log('System', `${cause} · score ${world.score}`, 'err');
    const avg = average(stats.latencies);
    runs.unshift({
        pilot: pilotLabel(), pacing: settings.pacing, seed: world.seed, score: world.score,
        rules: activeRules.explosive ? 'explosive' : '',
        destroyed: world.destroyed, avgMs: avg ? Math.round(avg) : null, missed: stats.missed,
    });
    runs = runs.slice(0, 30);
    writeStorage('spacerunner.runs', runs);
    renderRuns();
    setTimeout(() => {
        if (phase !== 'over') return;
        $('overlay-title').textContent = 'Crashed';
        $('overlay-subtitle').textContent = `${cause} · score ${world.score} · ${world.destroyed} destroyed`;
        $('btn-start').textContent = 'Retry same field';
        $('overlay').classList.remove('hidden');
    }, 900);
    refreshUi();
}

async function loop(id) {
    while (id === runId && world.status === 'playing') {
        if (paused && !stepRequested) { await waitForWake(); continue; }
        const single = paused;
        stepRequested = false;
        const started = performance.now();
        const decision = await decide(id, single, started + settings.tickMs);
        if (id !== runId) return;
        if (!decision) continue; // interrupted: re-evaluate pause/controller
        applyTick(decision);
        if (world.status !== 'playing') break;
        const keyboardTurn = settings.controller === 'keyboard' && settings.pacing === 'turn';
        if (!single && !keyboardTurn) await sleep(settings.tickMs - (performance.now() - started));
    }
    if (id === runId && world.status !== 'playing') gameOver();
}

/** Returns { action, actor, ... } or null if the wait was interrupted. */
async function decide(id, single, deadline) {
    const turnBased = single || settings.pacing === 'turn';
    switch (settings.controller) {
        case 'keyboard': {
            if (turnBased && !single) {
                while (!pendingKey) {
                    await waitForWake();
                    if (id !== runId || settings.controller !== 'keyboard' || paused || settings.pacing !== 'turn') return null;
                }
            }
            const action = pendingKey || 'STAY';
            pendingKey = null;
            showObservation(world.observe(), 'Current state');
            return { action, actor: 'You' };
        }
        case 'bot': {
            showObservation(world.observe(), 'Current state');
            return { ...bot.decide(world), actor: 'Bot' };
        }
        case 'decision':
        case 'ollama': {
            const pilot = MODEL_PILOTS[settings.controller];
            if (!pilot.model()) {
                ollamaFailed('Pick a model first (Ollama settings).', pilot.actor);
                return null;
            }
            if (!inflight) inflight = startThinking(pilot);
            const mine = inflight;
            const waitFor = turnBased
                ? mine.promise
                : Promise.race([mine.promise, sleep(deadline - performance.now()).then(() => TIMEOUT)]);
            const result = await interruptible(waitFor);
            if (result === INTERRUPTED || id !== runId || inflight !== mine) return null;
            if (result === TIMEOUT) {
                stats.missed++;
                return { action: 'STAY', actor: `${pilot.actor} (still thinking)`, missed: true };
            }
            inflight = null;
            if (result.error) {
                if (result.error.name !== 'AbortError') ollamaFailed(result.error.message, pilot.actor);
                return null;
            }
            return { ...result, actor: pilot.actor, fromModel: true, stale: world.tick - result.forTick };
        }
    }
}

function startThinking(pilot) {
    const obs = world.observe();
    const forTick = world.tick;
    showObservation(pilot.agent.stateFor(obs), `Sent to model · turn ${forTick}`);
    ui.thinkingSince = performance.now();
    const entry = { forTick };
    entry.promise = pilot.agent.decide(obs)
        .then(r => ({ ...r, forTick }), error => ({ error }))
        .finally(() => { if (inflight === entry || !inflight) ui.thinkingSince = 0; });
    return entry;
}

function abortThinking() {
    llm.abort();
    decider.abort();
    inflight = null;
    ui.thinkingSince = 0;
}

function ollamaFailed(message, actor = 'Ollama') {
    abortThinking();
    paused = true;
    $('ollama-error').textContent = message;
    $('ollama-error').classList.remove('hidden');
    log(actor, message, 'err');
    refreshUi();
}

function applyTick(decision) {
    world.step(decision.action);
    renderer.onTick(world);
    ui.lastAction = decision.action;
    ui.lastActionAt = performance.now();
    ui.lastConfidence = decision.fromModel && decision.probabilities ? decision.probabilities[decision.action] : null;

    if (decision.fromModel) {
        stats.decisions++;
        stats.latencies.push(decision.latencyMs);
        if (!decision.valid) stats.invalid++;
        if (decision.tokensPerSec) stats.lastTps = decision.tokensPerSec;
        if (typeof decision.confidence === 'number') stats.confidences.push(decision.confidence);
        $('ollama-error').classList.add('hidden');
        showResponse(decision);
    }
    let detail = '';
    if (decision.latencyMs) detail += ` · ${decision.latencyMs}ms`;
    if (decision.loadMs > 500) detail += ` (model load ${(decision.loadMs / 1000).toFixed(1)}s)`;
    if (decision.stale) detail += ` · ${decision.stale} tick${decision.stale > 1 ? 's' : ''} late`;
    if (decision.valid === false) detail += ' · invalid output';
    if (ui.lastConfidence != null) detail += ` · p=${ui.lastConfidence.toFixed(2)}`;
    const quietTick = decision.actor === 'You' && decision.action === 'STAY';
    if (!quietTick) log(decision.actor, `${decision.action}${detail}`, decision.missed ? 'warn' : decision.fromModel ? 'llm' : '',
        decision.fromModel || /doesn't know/.test(decision.reasoning || '') ? decision.reasoning : '');
    if (world.events.some(e => e.kind === 'destroy')) log('', 'asteroid destroyed', 'dim');
    refreshUi();
}

// ---------- controls ----------
function setController(c) {
    settings.controller = c;
    saveSettings();
    abortThinking();
    interruptAll();
    resetStats(); // stats describe one pilot, so mixing them would mislead
    wake();
    if (phase === 'playing') log('System', `Pilot → ${pilotLabel()} (stats reset)`, 'sys');
    refreshUi();
}

function setPacing(p) {
    settings.pacing = p;
    saveSettings();
    wake();
    refreshUi();
}

function togglePause() {
    if (phase !== 'playing') return;
    paused = !paused;
    if (paused) { abortThinking(); interruptAll(); }
    else $('ollama-error').classList.add('hidden');
    wake();
    refreshUi();
}

function step() {
    if (phase !== 'playing') { paused = true; startGame(); return; }
    if (!paused) { paused = true; abortThinking(); interruptAll(); }
    stepRequested = true;
    wake();
    refreshUi();
}

const KEY_ACTIONS = {
    ArrowLeft: 'LEFT', a: 'LEFT', ArrowRight: 'RIGHT', d: 'RIGHT',
    ' ': 'SHOOT', ArrowUp: 'SHOOT', w: 'SHOOT', ArrowDown: 'STAY', s: 'STAY',
};

window.addEventListener('keydown', e => {
    // Ignore typing in text fields, but not sliders/checkboxes (they keep focus after a click).
    if (e.target.closest && e.target.closest('textarea, select, input[type=text], input[type=number]')) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const action = KEY_ACTIONS[key];
    if (action) {
        e.preventDefault();
        if (phase !== 'playing' || settings.controller !== 'keyboard') return;
        const turnLike = paused || settings.pacing === 'turn';
        if (turnLike && e.repeat) return; // one press = one turn
        pendingKey = action;
        if (paused) stepRequested = true;
        wake();
        return;
    }
    if (key === 'p') togglePause();
    else if (key === 'n') step();
    else if (key === 'r' || (key === 'Enter' && phase !== 'playing')) startGame();
    else if (key === '1') setController('keyboard');
    else if (key === '2') setController('bot');
    else if (key === '3') setController('decision');
    else if (key === '4') setController('ollama');
    else return;
    e.preventDefault();
});

// ---------- panels ----------
function pilotLabel() {
    if (settings.controller === 'keyboard') return 'Keyboard';
    if (settings.controller === 'bot') return 'Heuristic bot';
    if (settings.controller === 'decision') return `Decision · ${settings.decisionModel || 'no model'}`;
    return `LLM · ${settings.model || 'no model'}`;
}

function refreshUi() {
    for (const btn of document.querySelectorAll('[data-controller]')) btn.classList.toggle('active', btn.dataset.controller === settings.controller);
    for (const btn of document.querySelectorAll('[data-pacing]')) btn.classList.toggle('active', btn.dataset.pacing === settings.pacing);
    $('ollama-panel').classList.toggle('dimmed', !MODEL_PILOTS[settings.controller]);
    $('decision-panel').classList.toggle('dimmed', settings.controller !== 'decision');
    $('llm-panel').classList.toggle('dimmed', settings.controller !== 'ollama');
    $('tick-ms').value = settings.tickMs;
    $('tick-ms-label').textContent = settings.pacing === 'turn' ? `min ${settings.tickMs} ms / tick` : `${settings.tickMs} ms / tick`;
    $('pacing-hint').textContent = settings.pacing === 'turn'
        ? 'The world waits for every decision. Latency doesn\'t matter, only decision quality.'
        : 'The world doesn\'t wait. If the pilot hasn\'t decided by the deadline, the ship does nothing that tick.';
    $('btn-pause').textContent = paused ? 'Resume (P)' : 'Pause (P)';
    $('btn-pause').disabled = phase !== 'playing';
    $('tick-counter').textContent = `Tick ${world.tick}`;

    const lat = stats ? stats.latencies : [];
    $('stat-decisions').textContent = stats ? stats.decisions : 0;
    $('stat-avg').textContent = lat.length ? `${Math.round(average(lat))} ms` : '–';
    $('stat-p95').textContent = lat.length ? `${Math.round(percentile(lat, 0.95))} ms` : '–';
    const showConfidence = settings.controller === 'decision' || (stats && stats.confidences.length && !stats.lastTps);
    $('stat-tps-label').textContent = showConfidence ? 'avg confidence' : 'tokens/s';
    $('stat-tps').textContent = showConfidence
        ? (stats && stats.confidences.length ? average(stats.confidences).toFixed(2) : '–')
        : (stats && stats.lastTps ? `${stats.lastTps}` : '–');
    $('stat-invalid').textContent = stats ? stats.invalid : 0;
    $('stat-missed').textContent = stats ? stats.missed : 0;
}

function showObservation(state, title) {
    $('obs-title').textContent = title;
    // One line per lane / per key: readable on a projector, unlike fully pretty-printed JSON.
    if (!Object.values(state).some(Array.isArray)) {
        $('state-json').textContent = JSON.stringify(state, null, 2);
        return;
    }
    const lines = Object.entries(state).map(([k, v]) => Array.isArray(v)
        ? `  "${k}": [\n${v.map(x => '    ' + JSON.stringify(x)).join(',\n')}\n  ]`
        : `  "${k}": ${JSON.stringify(v)}`);
    $('state-json').textContent = `{\n${lines.join(',\n')}\n}`;
}

function showResponse(d) {
    const extra = d.tokensPerSec ? ` · ${d.tokensPerSec} tok/s`
        : d.usage ? ` · ${d.usage.input_tokens} tokens in` : '';
    $('response-meta').textContent = `${d.actor} · turn ${d.forTick} · ${d.latencyMs} ms${extra}${d.valid ? '' : ' · INVALID'}`;
    $('response-action').textContent = d.action;
    const probs = $('response-probs');
    probs.replaceChildren();
    probs.classList.toggle('hidden', !d.probabilities);
    if (d.probabilities) {
        // A decision model returns a distribution over the options: show all of it.
        for (const a of ACTIONS) {
            const p = d.probabilities[a] || 0;
            const row = document.createElement('div');
            row.className = `prob-row${a === d.action ? ' chosen' : ''}`;
            const label = document.createElement('span');
            label.textContent = a;
            const bar = document.createElement('span');
            bar.className = 'prob-bar';
            const fill = document.createElement('span');
            fill.style.width = `${(p * 100).toFixed(1)}%`;
            bar.appendChild(fill);
            const pct = document.createElement('span');
            pct.textContent = `${(p * 100).toFixed(1)}%`;
            row.append(label, bar, pct);
            probs.appendChild(row);
        }
        let summary = `confidence ${typeof d.confidence === 'number' ? d.confidence.toFixed(2) : '–'}`;
        if (typeof d.danger === 'number') summary += ` · in danger? p=${d.danger.toFixed(2)}`;
        $('response-reasoning').textContent = summary;
    } else {
        $('response-reasoning').textContent = d.reasoning || (d.thinking ? '' : '(no reasoning requested)');
    }
    $('response-thinking').textContent = d.thinking || '';
    $('response-thinking').classList.toggle('hidden', !d.thinking);
    $('response-raw').textContent = d.raw;
}

function log(actor, text, kind = '', reasoning = '') {
    const row = document.createElement('div');
    row.className = `log-row ${kind}`;
    const t = document.createElement('span');
    t.className = 'log-tick';
    t.textContent = String(world.tick).padStart(4, '0');
    const body = document.createElement('span');
    if (actor) {
        const a = document.createElement('strong');
        a.textContent = `${actor}: `;
        body.appendChild(a);
    }
    body.appendChild(document.createTextNode(text));
    if (reasoning) {
        const r = document.createElement('div');
        r.className = 'log-reason';
        r.textContent = reasoning;
        body.appendChild(r);
    }
    row.append(t, body);
    const el = $('action-log');
    el.appendChild(row);
    while (el.childElementCount > 200) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
}

function renderRuns() {
    const body = $('runs-body');
    body.replaceChildren();
    for (const r of runs) {
        const tr = document.createElement('tr');
        for (const v of [r.pilot, r.pacing === 'turn' ? 'turn' : 'real-time', r.rules || '–', r.seed, r.score, r.destroyed,
            r.avgMs === null ? '–' : `${r.avgMs}`, r.missed]) {
            const td = document.createElement('td');
            td.textContent = v;
            tr.appendChild(td);
        }
        body.appendChild(tr);
    }
    $('runs-empty').classList.toggle('hidden', runs.length > 0);
}

const average = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
function percentile(xs, p) {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

async function refreshModels() {
    const status = $('ollama-status');
    status.className = 'status pending';
    status.textContent = 'connecting…';
    try {
        const models = await llm.listModels();
        const list = $('model-list');
        list.replaceChildren(...models.map(m => Object.assign(document.createElement('option'), { value: m })));
        const chatModels = models.filter(m => !/^(nimble|tev|clef)/.test(m));
        if (!settings.model && chatModels.length) {
            settings.model = chatModels[0];
            $('model').value = settings.model;
            saveSettings();
        }
        status.className = 'status ok';
        status.textContent = models.length ? `connected · ${models.length} model${models.length > 1 ? 's' : ''}` : 'connected · no models pulled';
    } catch (err) {
        status.className = 'status bad';
        status.textContent = 'not reachable (see README: CORS / ollama serve)';
    }
    syncAgent();
}

async function warmUp(pilotKey, btn) {
    const pilot = MODEL_PILOTS[pilotKey];
    if (!pilot.model()) return ollamaFailed('Pick a model first.', pilot.actor);
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
        // The first call loads the model into memory; the second shows the steady-state latency.
        const first = await pilot.agent.decide(new World(1).observe());
        const second = await pilot.agent.decide(new World(2).observe());
        log(pilot.actor, `${pilot.model()} ready · first call ${first.latencyMs}ms (includes loading), then ${second.latencyMs}ms`, 'sys');
        $('ollama-error').classList.add('hidden');
    } catch (err) {
        if (err.name !== 'AbortError') ollamaFailed(err.message, pilot.actor);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Warm up';
    }
}

// ---------- wiring ----------
function bindSettingInput(id, key, parse = v => v, after = () => {}) {
    const el = $(id);
    const isCheck = el.type === 'checkbox';
    if (isCheck) el.checked = settings[key]; else el.value = settings[key];
    el.addEventListener(isCheck ? 'change' : 'input', () => {
        settings[key] = parse(isCheck ? el.checked : el.value);
        saveSettings();
        after();
    });
}

function setRule(key, on) {
    activeRules[key] = on;
    settings.ruleExplosive = activeRules.explosive;
    saveSettings();
    $('rule-text').classList.toggle('hidden', !on);
    if (phase === 'playing') {
        log('System', on ? `Rule change: ${RULE_CHANGES[key].title} (new spawns only). Models get 1 extra sentence, the bot gets nothing.`
            : `Rule change off: ${RULE_CHANGES[key].title}`, 'warn');
    }
    syncAgent();
}

function syncAgent() {
    decider.ruleNotes = llm.ruleNotes = ruleNotes();
    Object.assign(decider, {
        baseUrl: settings.baseUrl, model: settings.decisionModel, digestState: settings.digestState,
        askDanger: settings.askDanger, instructions: settings.decisionInstructions,
    });
    Object.assign(llm, {
        baseUrl: settings.baseUrl, model: settings.model, temperature: settings.temperature,
        withReasoning: settings.withReasoning, disableThinking: settings.disableThinking,
        systemPrompt: settings.systemPrompt,
    });
    refreshUi();
}

function init(sprites) {
    renderer = new Renderer($('game-canvas'), sprites);
    resetStats();

    for (const btn of document.querySelectorAll('[data-controller]')) btn.addEventListener('click', () => setController(btn.dataset.controller));
    for (const btn of document.querySelectorAll('[data-pacing]')) btn.addEventListener('click', () => setPacing(btn.dataset.pacing));
    $('btn-start').addEventListener('click', () => startGame());
    // Keep focus off buttons, so Space shoots instead of re-clicking the last button.
    document.addEventListener('click', e => { const b = e.target.closest('button'); if (b) b.blur(); });
    $('btn-new-field').addEventListener('click', () => startGame(Math.floor(Math.random() * 1e6)));
    $('btn-restart').addEventListener('click', () => startGame());
    $('btn-pause').addEventListener('click', togglePause);
    $('btn-step').addEventListener('click', step);
    $('btn-dice').addEventListener('click', () => { $('seed').value = Math.floor(Math.random() * 1e6); $('seed').dispatchEvent(new Event('input')); });
    $('btn-refresh-models').addEventListener('click', refreshModels);
    $('btn-warmup').addEventListener('click', e => warmUp('ollama', e.currentTarget));
    $('btn-warmup-decision').addEventListener('click', e => warmUp('decision', e.currentTarget));
    $('btn-reset-instructions').addEventListener('click', () => {
        $('decision-instructions').value = DEFAULT_DECISION_INSTRUCTIONS[settings.digestState ? 'digested' : 'raw'];
        $('decision-instructions').dispatchEvent(new Event('input'));
    });
    $('btn-reset-prompt').addEventListener('click', () => {
        $('system-prompt').value = DEFAULT_SYSTEM_PROMPT;
        $('system-prompt').dispatchEvent(new Event('input'));
    });
    $('btn-clear-runs').addEventListener('click', () => { runs = []; writeStorage('spacerunner.runs', runs); renderRuns(); });

    $('rule-explosive').checked = activeRules.explosive;
    $('rule-explosive').addEventListener('change', e => setRule('explosive', e.target.checked));
    $('rule-text').textContent = RULE_CHANGES.explosive.text;
    $('rule-text').classList.toggle('hidden', !activeRules.explosive);
    bindSettingInput('tick-ms', 'tickMs', Number, refreshUi);
    bindSettingInput('seed', 'seed', v => Math.max(0, parseInt(v, 10) || 0));
    bindSettingInput('show-overlay', 'showOverlay');
    bindSettingInput('base-url', 'baseUrl', String, syncAgent);
    bindSettingInput('model', 'model', v => v.trim(), syncAgent);
    bindSettingInput('temperature', 'temperature', Number, () => { $('temperature-label').textContent = settings.temperature.toFixed(1); syncAgent(); });
    bindSettingInput('with-reasoning', 'withReasoning', Boolean, syncAgent);
    bindSettingInput('disable-thinking', 'disableThinking', Boolean, syncAgent);
    bindSettingInput('system-prompt', 'systemPrompt', String, syncAgent);
    bindSettingInput('decision-model', 'decisionModel', v => v.trim(), syncAgent);
    bindSettingInput('ask-danger', 'askDanger', Boolean, syncAgent);
    bindSettingInput('decision-instructions', 'decisionInstructions', String, syncAgent);
    bindSettingInput('digest-state', 'digestState', Boolean, () => {
        // Swap in the matching default instructions, unless the user has edited them.
        const box = $('decision-instructions');
        if (Object.values(DEFAULT_DECISION_INSTRUCTIONS).includes(box.value)) {
            box.value = DEFAULT_DECISION_INSTRUCTIONS[settings.digestState ? 'digested' : 'raw'];
            settings.decisionInstructions = box.value;
            saveSettings();
        }
        syncAgent();
    });
    $('temperature-label').textContent = Number(settings.temperature).toFixed(1);
    $('base-url').addEventListener('change', refreshModels);

    syncAgent();
    renderRuns();
    refreshModels();
    showObservation(world.observe(), 'Current state');
    log('System', 'Press Start (or Enter). Keys 1-4 switch pilot.', 'sys');

    const frame = () => {
        renderer.render(world, {
            ...ui, tickMs: settings.tickMs, paused, showOverlay: settings.showOverlay,
            controllerLabel: pilotLabel(),
        });
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
}

loadSprites().then(init);
