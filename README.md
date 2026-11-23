# Space Runner: a decision-model demo

A small browser game for showing a **decision model** in action. A ship flies up an asteroid
field with 4 lanes, and each tick the pilot picks one of `LEFT`, `RIGHT`, `SHOOT`, `STAY`.

There are four pilots, so you can compare them live on the same asteroid field:

| Key | Pilot | How it decides |
| --- | --- | --- |
| `1` | Keyboard | you |
| `2` | Bot | a hand-written look-ahead search (classic baseline) |
| `3` | **Decision model** | e.g. [`nimble`](https://ollama.com/library/nimble) via Ollama's [decision API](https://docs.ollama.com/capabilities/decision) (`POST /v1/systemone`) |
| `4` | LLM | a general chat model via `POST /api/chat`. It's here to show why text generation is too slow for a per-tick decision. |

The panels show what the model is doing: the exact state it was sent, the probability of
each action (decision model) or its reasoning text (LLM), latency, and how many ticks it
was too slow for.

![sprites](assets/spritesheet.jpeg)

## Prerequisites

- **Ollama**: install the macOS app from <https://ollama.com/download> or run `brew install ollama`.
- **Ollama v0.35.0 or newer.** That's the first version with the decision endpoint; check with `ollama --version`.
- **Models pulled:** `nimble` for the decision pilot, plus a chat model for the LLM comparison
  (see [Choosing a chat model](#choosing-a-chat-model)).
- **Python 3** to serve the page (any static file server works). macOS already has it.
- A recent Chrome, Safari, Edge or Firefox.

No build step, no npm, and no CDN dependencies apart from optional web fonts, so it runs offline.

## Running the demo

1. Start Ollama. The desktop app starts the server for you. Without the app, run:

   ```bash
   ollama serve
   ```

2. Pull the decision model and a chat model:

   ```bash
   ollama pull nimble
   ```

   ```bash
   ollama pull qwen3:8b
   ```

3. Serve the game from the repository root:

   ```bash
   python3 -m http.server 8000
   ```

4. Open <http://localhost:8000>.
5. The **Ollama** card should say `connected`. Press **Warm up** for both the decision model
   and the chat LLM, so they're loaded into memory before the audience is watching. The first
   call can take 5 to 30 seconds. The log then shows the steady-state latency of each.
6. Press **Start** (or Enter).

### Why serve it over http://localhost?

The page calls Ollama (`/v1/systemone`, `/api/chat`) directly from the browser, so Ollama's
CORS rules apply. By default Ollama accepts requests from `localhost` and `127.0.0.1` pages on
any port. A page opened as `file://` sends `Origin: null`, which Ollama rejects.

- Keyboard and bot modes work when you just double-click `index.html`. The LLM mode needs
  the page served from localhost.
- To serve the page from another host, such as a second machine on the network, allow that
  origin in Ollama:

  ```bash
  OLLAMA_ORIGINS="http://my-host:8000" ollama serve
  ```

  For the macOS app, set the variable with
  `launchctl setenv OLLAMA_ORIGINS "http://my-host:8000"`, then restart the app.
- I haven't verified that `/v1/systemone` follows the same CORS rules as the rest of the API
  (the docs don't say). If the decision pilot reports "Can't reach Ollama" while the LLM pilot
  works, CORS on that endpoint is the likely cause. Workaround: put a tiny proxy in front, or
  ask me to add one.

## Controls

| Key | Action |
| --- | --- |
| `←` `→` (or `A` `D`) | move one lane |
| `Space` (or `↑`, `W`) | shoot |
| `↓` (or `S`) | stay (useful in turn-based mode) |
| `P` | pause / resume |
| `N` | step exactly one tick (pauses first if needed) |
| `R` | restart |
| `1` `2` `3` `4` | pilot: keyboard / bot / decision model / LLM |

You can switch pilots mid-game, for example to take over from the model. Switching resets the stats panel.

### Clock modes

These are the main thing the demo shows.

- **Real-time**: the world ticks every *N* ms (use the slider). If the pilot hasn't decided by
  the deadline, the ship does nothing that tick. The request keeps running, and its answer
  is applied on a later tick, so it acts on a state that's already out of date. The log
  marks these as `1 tick late`, and the stats count `ticks w/o decision`. This shows
  latency as part of decision quality.

  **Drop late answers** (checkbox) discards an answer that arrives after its tick: the ship
  stays instead of acting on an outdated state. Neither choice is free. Applying late answers
  causes crashes like "moved right because it was safe two ticks ago". Dropping them means a
  slow model barely acts at all.
- **Turn-based**: the world waits for every decision, so only reasoning quality matters. With
  the keyboard pilot, each key press is one turn.
- **Pause + Step**: freeze the world and advance one decision at a time. Each step sends one
  request, so you can talk through the state JSON, the reasoning, and the outcome.

### Why did it crash?

Every crash gets a one-line post-mortem in the log, on the game-over screen and in the
**Runs** table. It's one of three kinds:

- **wrong decision**: the state the pilot saw already showed the danger, e.g. "moved RIGHT
  into lane 2, although the state it saw showed metal 1 row away there".
- **outdated information**: the pilot decided on a state that had moved on by the time the
  action was applied (real-time mode, slow model).
- **too slow**: there was no decision in time, or a late answer was dropped.

That separates "the model got it wrong" from "the model was right too late", which are
different problems with different fixes: better context or a better model, versus a
faster model or turn-based play.

### Rule change: explosive asteroids

The **Rule change** card switches on a new asteroid type mid-game: *explosive* (glowing red).
It can't be destroyed, and shooting it detonates it, which destroys the ship. It only affects
asteroids that spawn after you flip the switch.

- **The bot** has its rules frozen in code, like any hand-written policy ("if metal → dodge,
  else → shoot"). It treats the unknown type as a breakable rock, shoots it, and dies, usually
  within 10–40 ticks. The log says why: `doesn't know "explosive", treats it as ice`.
- **The model pilots** get exactly one extra sentence appended to their instructions, shown
  in the card. Nothing else changes: no code, no redeploy.
- In the pre-digested state, the code reports an unknown type as `"threat": "unknown"` with
  `"nearest": "explosive"`. It states facts and doesn't guess, so the model can apply the new rule.

The honest counterpoint, in case someone raises it: a defensively written bot (unknown type →
dodge) would have survived. A bot updated with the new rule plays well again, but someone had
to change and ship code, while the model only needed a sentence. That trade-off is the point.

When an explosive is shot, it cracks open and bursts before the blast reaches the ship, and
the ship plays its own destruction sequence (hit → breaking apart → wreck).

The **seed** sets the asteroid field. The same seed always produces the same asteroids,
whoever is flying, so you can compare models (or a model against the bot) fairly. Finished
games are listed in the **Runs** table.

**Show rows_away** labels every asteroid with the number the model receives, which helps the
audience connect the JSON to the screen.

## How the decision model is called

Each decision is one call to `POST /v1/systemone`:

```json
{
  "model": "nimble",
  "state": { "turn": 42, "current_lane": { ... }, "left_lane": { ... }, "right_lane": { ... } },
  "questions": {
    "action": {
      "type": "choice",
      "instructions": "The state describes a spaceship ... Which action keeps the ship alive?",
      "criteria": {
        "STAY":  "Stay in the current lane and do nothing. Right when ...",
        "SHOOT": "Fire a laser up the current lane. Right when ...",
        "LEFT":  "Move one lane to the left ...",
        "RIGHT": "Move one lane to the right ..."
      }
    }
  },
  "keep_alive": "30m"
}
```

The answer is `answers.action.choice`, plus a probability for each of the four options and a
`confidence` (how concentrated the distribution is, not how likely it is to be right). Both
are shown as bars in the inspector, and the chosen action's probability appears above the ship.

Options in the **Decision** section:

- **Pre-digested state** (on by default). Decision models are bad at exact comparisons, and
  the advice is to compute those in code and give the model the semantic part. With this on,
  the state is framed relative to the ship and already answers the arithmetic:

  ```json
  {"turn": 42,
   "current_lane": {"exists": true, "threat": "must_dodge", "nearest": "metal", "turns_to_impact": 3},
   "left_lane":    {"exists": true, "safe_to_enter": false, "blocked_by": "ice arriving next turn", "threat": "shootable", "nearest": "ice", "turns_to_impact": 1, "hits_left": 1},
   "right_lane":   {"exists": true, "safe_to_enter": true, "threat": "none"}}
  ```

  Turn it off to send the raw grid observation (the same one the LLM gets). Comparing the
  two is a decent talk segment, because it's *the* practical question when using these
  models: how much to pre-digest before the model adds anything over plain code.
- **Also ask "in danger?"** adds a second, `noul` (yes/no probability) question. Questions
  are scored separately, so it shows how latency grows with each extra question.
- **Question instructions** are editable live, with a reset to default. The defaults switch
  along with the state format unless you've edited them.
  Prompts are saved in the browser. A saved copy of an *earlier default* is upgraded
  automatically when the defaults improve. A prompt you've edited is left alone (use
  **Reset to default** to get the new one).

## How the LLM is called

Each decision is one stateless call to `POST /api/chat`:

- **system**: the rules of the game (editable in *Ollama → System prompt*, with a reset button).
- **user**: the current observation, for example:

  ```json
  {"turn": 42, "player_lane": 1, "lanes": [
    {"lane": 0, "asteroids": []},
    {"lane": 1, "asteroids": [{"type": "metal", "rows_away": 3}]},
    {"lane": 2, "asteroids": [{"type": "stone", "rows_away": 6, "hits_left": 2}], "lasers_in_flight": 1},
    {"lane": 3, "asteroids": [{"type": "ice", "rows_away": 2, "hits_left": 1}]}]}
  ```

- `format`: a JSON schema (Ollama's structured outputs) that restricts `action` to the four
  legal values, with an optional `reasoning` string first. The answer is therefore always
  parseable. Anything odd is still counted as "invalid output" and treated as `STAY`.
  If a model rejects structured outputs, the game shows a **warning** (not an error), retries
  without `format`, and keeps playing with prompt-only JSON. The action is then picked out of
  the text, so invalid outputs become more likely.
- `think: false` (checkbox) turns off long thinking for reasoning models such as qwen3. If
  the server or model doesn't support the flag, the game retries once without it.
- `keep_alive: 30m` keeps the model loaded between turns.

## Strategy: act early

Real-time crashes with a slow model are mostly "too slow": the answer about an asteroid
one row away arrives after it has hit. The default prompts and option descriptions therefore
tell the model to act **early**: shoot ice and stone as soon as they're in the lane, however
far away, and move away from metal as soon as it appears. The digested state includes
`shots_needed` (hits left minus lasers already on their way), so the model doesn't over-shoot
or have to do the subtraction.

A simulation of a pilot that follows each strategy literally (40 seeds, answers applied
*k* ticks late) shows how much this matters:

| Answer arrives… | "Deal with it when it's close" | "Act early" |
| --- | --- | --- |
| on time | 286 ticks (median) | 372 |
| 1 tick late | 49 | 106 |
| 2 ticks late | 29 | 84 |

Two further ideas the simulation supports, not built in (yet):

- **Latency margin**: treat a lane as blocked if anything arrives within 1 + *k* turns, where *k*
  is the expected delay. That gives another 20–30%.
- **Prediction**: send the state projected *k* ticks ahead, i.e. as it will be when the
  answer arrives. Both need the game to estimate the model's latency.

## Choosing models

**Decision model:** `nimble` (9B, fine-tuned from Qwen3.5-9B). Ollama's model page claims
under 100 ms per answer on an M5 Max. On a plain M5 expect somewhat more. The default
tag is ~9.4 GB, and there are smaller ones such as `nimble:9b-q4_K_M` (5.6 GB) and MLX
variants (`nimble:9b-mxfp8`, `nimble:9b-nvfp4`). Some things to know from the docs:

- Decision models aren't in the Ollama CLI/SDKs yet (per the model page), which is why
  the game calls the HTTP API directly.
- Its prompt must fit in 8,192 tokens (the model page's notes; the tag list says 256K,
  which contradicts it). This game's requests are a few hundred tokens, so it doesn't matter.

### Choosing a chat model

A MacBook Pro M5 with 48 GB can run anything up to about 30B parameters comfortably. Some
starting points (tags as listed on <https://ollama.com/library>; check what's current
before the talk):

| Size | Examples | Notes |
| --- | --- | --- |
| Small (3–4B) | `llama3.2:3b`, `qwen3:4b`, `gemma3:4b` | Fast enough for real-time. Makes visible mistakes, which can be good on stage. |
| Medium (7–14B) | `qwen3:8b`, `gemma3:12b` | A good balance. Usually under a second per decision without reasoning. |
| Large (~30B) | `qwen3:30b-a3b` (MoE, fast for its size), `gemma3:27b` | Better decisions, but too slow for real-time at short ticks. Use turn-based. |

I haven't benchmarked these on an M5, so treat the latency claims as rough. Measure with
the stats panel before the talk.

Expect the heuristic bot to beat everything: it's a 50-line brute-force search with full
knowledge of the rules, and it didn't crash in my tests. That's a fair point to make on stage
(a decision model earns its place when the rules can't be written down, not in a toy game
with exact rules), but plan for it.

## A possible talk flow

1. Play a few seconds yourself (keyboard, real-time) to explain the rules.
2. **LLM** (`4`) in **Real-time** at ~350 ms: it misses most ticks (`ticks w/o decision`), and
   its answers arrive "N ticks late". Text generation is too slow to act every tick.
3. **Pause** and **Step** a few LLM turns. It can explain itself, but each answer takes seconds.
4. **Decision model** (`3`), same seed, still real-time: every tick gets an answer in tens of
   milliseconds. **Step** a few turns and show the probability bars: no text, just a distribution
   over the four actions.
5. Turn **Pre-digested state** off and replay the same seed: how much does the model do on
   its own, and how much was the feature engineering?
6. Optionally tick **Also ask "in danger?"** to show multi-question requests and their cost.
7. **The bot** (`2`): near-perfect and instant. Simple, boring and better, as long as the rules
   are known and fixed.
8. **Rule change**: switch on *explosive asteroids*. The bot blows itself up within seconds.
   Switch to the decision model on the same seed: one sentence of instructions and it adapts.
9. End with the **Runs** table (pilot, rules, score, avg latency, missed ticks).

## Game rules (exact)

- 4 lanes × 16 rows, and asteroids fall 1 row per tick. The ship is two rows tall: its nose
  is in row 13, its body in row 14. An asteroid hits as soon as it reaches the nose row, which
  is where the sprites visibly touch. One beside either half still blocks a lane change.
- `rows_away` counts turns until an asteroid reaches the nose row. It's 0 for an asteroid
  beside the ship.
- Asteroids: **ice** takes 1 hit, **stone** takes 2, **metal** can't be destroyed.
- Lasers travel 4 rows per tick, checked one row at a time, so nothing gets skipped.
- Order of one tick: apply the action → sideways collision → asteroids fall → lasers fly and
  hit → collision with the ship → a new asteroid may spawn.
- With the rule change on, explosive asteroids also can't be destroyed, and shooting one destroys the ship.
- Lasers fade out before the top row, so they only hit asteroids that were already visible
  when the shot was decided.
- The field never contains an unavoidable wall of undestroyable asteroids (metal, and
  explosive if the rule is on). The generator checks that a dodge-only path survives, and
  turns the offending asteroid into a normal one if not.
- Score = ticks survived.

## Rendering

The logic runs in discrete ticks, but the drawing doesn't hop from tile to tile. Each tick
animates every object from where it is drawn to its new position over the time until the
next tick is expected (the tick length in real-time mode, the measured decision pace in
turn-based mode). A laser hit plays out where the laser and the asteroid visually meet, and
on a crash the scene freezes at the moment of contact while the ship breaks apart.

## Project structure

```
index.html              page layout
css/style.css           styles (no framework)
js/game.js              rules: grid world, seeded asteroid field, observation
js/agents.js            heuristic bot, decision-model client, LLM client, default prompts
js/render.js            canvas renderer, sprites, effects
js/main.js              tick loop, clock modes, UI
assets/spritesheet.jpeg original sprite sheet
assets/spritesheet2.webp explosive asteroid + ship destruction frames
assets/sprites/*.png    sprites cut out of the sheet (transparent)
tools/extract_sprites.py regenerates assets/sprites from the sheet
```

To regenerate the sprites after editing a sheet: `pip install pillow numpy`, then
`python3 tools/extract_sprites.py`. Neither sheet has real transparency (one is on a navy
grid, the other on a *painted* checkerboard), so the script floods the background out from
each crop's border. The crop boxes are at the top of the script; a new sheet needs its own
boxes and background test.

## Ideas not implemented (yet)

- **Two models side by side** on the same seed, in split screen.
- **Short memory**: include the last few observations and actions in the prompt, and see
  whether it helps or just adds latency.
- **Observation format experiment**: an ASCII grid instead of JSON. Small models often
  handle one much better than the other.
- **Streaming** the reasoning tokens into the panel, so people watch it think.
- **Post-mortem on crash**: send the last few turns back to the model and ask what went wrong.
- **Export a run** as JSONL (observation, prompt, response, outcome) for later analysis.

## Credits and license

- Code: [MIT](LICENSE).
- Sprites (`assets/spritesheet.jpeg`, `assets/spritesheet2.webp` and the PNGs cut from
  them) were generated with Google Gemini. The original sheet keeps Google's C2PA content
  credentials marking it as AI-generated. They're included under the same MIT terms as far
  as any rights in them exist; copyright protection for purely AI-generated images is unsettled in many
  jurisdictions.
