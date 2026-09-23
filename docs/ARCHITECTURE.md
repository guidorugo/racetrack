# Architecture

Racetrack is a single Node.js service plus a static browser client, with one
rules engine shared between them.

```
┌──────────────── Browser ────────────────┐          ┌──────────────── Server (Node) ────────────────┐
│ main.js ─ screens, controller lifecycle │          │ app.js ─ HTTP: static files, /healthz, CSP    │
│ gameView.js ─ HUD, input, animations    │          │ wsGateway.js ─ WebSocket transport, heartbeat │
│ renderer.js ─ canvas                    │   JSON   │ roomManager.js ─ rooms, turns, bots,          │
│ LocalController ── rules engine         │◄────────►│                  reconnection, timers         │
│ OnlineGameController ── OnlineSession ──┼─ /ws ────┤        │                                      │
│                      Connection         │          │        ▼                                      │
└──────────────────┬──────────────────────┘          └────────┬──────────────────────────────────────┘
                   │  same ES modules, served at /shared/     │
                   └──────────► src/shared ◄───────────────────┘
                      game.js · track.js · geometry.js · bot.js · distanceField.js · protocol.js
```

- **Local games** (single player, hot seat) run the engine in the browser. The
  server only serves files.
- **Online games** run the engine on the server, which is the single source of
  truth. Clients send *requests* ("move with acceleration a on turn n"); the server
  validates, applies, and broadcasts the full room snapshot to everyone in the room.

There is no build step: the browser loads the ES modules directly (`/client/js/…`
and `/shared/…`), and the file layout on disk mirrors the URL layout, so the same
modules can be imported by Node for tests.

---

## The rules engine (`src/shared`)

### State

`GameState` is plain JSON (`game.js`), so it can be cloned, sent over the network
and compared in tests:

```js
{
  schema, trackId, laps, maxRounds,
  status: 'playing' | 'finished', endReason: 'win' | 'round-limit' | 'all-retired' | null,
  winnerId, turn /* moves applied */, round, currentPlayerIndex,
  players: [{ id, name, kind, botLevel, color, startPosition, position, velocity,
              crashes, lapProgress, moves, status: 'racing' | 'finished' | 'retired' }],
  history: [{ turn, round, playerId, acceleration, from, target, to, velocity,
              outcome: 'moved' | 'crashed' | 'won', crash: 'wall' | 'car' | null,
              lapDelta, note }]
}
```

All transitions are pure functions returning new states: `createGame`,
`getMoveOptions`, `evaluateMove`, `applyMove`, `retirePlayer`. They copy only what
they change (the top level and the player objects) and share the rest — move
records, positions and velocities are replaced, never mutated — so a move stays
cheap even late in a long race. Invalid input raises a
`GameError` with a stable `code` (e.g. `INVALID_ACCELERATION`, `NOT_YOUR_TURN`,
`GAME_OVER`) that also travels over the network protocol.

### A move, step by step (`applyMove`)

1. Reject if the game is over, the track doesn't match, the acceleration isn't
   integer in `[-1, 1]²`, or (when a `playerId` is given) it isn't that player's turn.
2. `velocity' = velocity + acceleration`, `target = position + velocity'`.
3. **Wall check:** crash if the straight segment `position → target` touches any wall
   edge, or `target` is not on the drivable surface.
4. **Car check:** crash if another car still racing sits on `target`. Paths may
   cross other cars; only the landing point matters.
5. On a crash: position unchanged, velocity zero, `crashes + 1`, turn ends.
6. Otherwise move; update `lapProgress` by the finish-line crossing (`-1/0/+1`). If
   that was a forward crossing and `lapProgress ≥ laps`, the car finishes and gets
   its `place`; the first finisher is the winner. With `finishMode: 'first'` the game
   ends at once; with `'all'` it ends when no car is left racing.
7. Record the move and pass the turn to the next racing car; the round counter
   increases when play wraps around. Past `maxRounds` the game ends as a draw.

A crashing move can therefore never win, and "moving into a wall" is handled by the
same rule everywhere: the rules engine is the only place that decides.

### Exact geometry (`geometry.js`, `track.js`)

All track vertices and car positions are integers, and the collision predicates
only multiply and subtract integers, so they are **exact** — no epsilons. The
segment-intersection test treats segments as closed (touching an endpoint or
overlapping collinearly counts), which is what makes "grazing a wall corner is a
crash" well defined. A `Track` precomputes a lookup table of on-track grid points and
flat arrays of wall edges with bounding boxes for fast rejection.

The surface is defined by the **even-odd rule** over all boundary polygons, so an
oval is just `[outer, inner]`; points exactly on a wall are off the track.

### Finish line and laps

The finish line is a segment from wall to wall plus a racing direction. For a point
`p`, `side(p) = (p − a) · n` where `n` is the line's normal pointing in the racing
direction. Points with `side ≥ 0` count as *past* the line (half-open rule). A move
crosses the line when it changes side **and** actually intersects the segment:

- behind → past: `+1` (landing exactly on the line counts);
- past → behind: `−1`;
- leaving the line forwards afterwards: `0` (no double counting).

`lapProgress` is the net number of forward crossings. Because the line spans the
whole track, net crossings equal how many times the car went around, so reversing
over the line and back can't fake a lap. Cars start *on* the line (already "past"
it), so driving off the grid doesn't count either.

### Tracks

Tracks are data (`tracks/oval.js`) validated by `validateTrackDefinition`: grid
bounds, simple non-touching polygons, a finish line whose endpoints are not on the
surface and which crosses the drivable surface exactly once (so it cuts the circuit
in one place), a direction not parallel to it, and ≥ 4 distinct start positions on
the surface and not behind the line. The `Track` constructor then checks the race
itself against the distance field: the finish must be reachable, and every start
position must be at the beginning of a lap (≥ 80% of a lap from the finish) — which
rules out a start grid "ahead" of the line but half-way round the track. The registry
(`tracks/index.js`) builds every `Track` at load time, so a broken definition fails
immediately.

---

## Bot AI (`bot.js`, `distanceField.js`)

1. **Distance field.** Reverse Dijkstra over 8-connected on-track grid points
   (orthogonal step 1, diagonal √2), seeded by the steps that cross the finish line
   forwards, with steps across the line removed. `dist[p]` is the shortest distance
   to finish from `p` going the right way round; `lapLength` is its maximum.
   Remaining race distance adds `lapLength` per extra lap (and for a lap lost by
   reversing).
2. **Search.** For each of the nine moves the bot explores crash-free continuations
   to a depth of 2 (easy/medium) or 6 (hard), memoised on
   `(x, y, vx, vy, lap, ply)`. A plan is scored by the remaining distance at its end,
   minus half of the progress one more turn of coasting would give (momentum bonus).
   Winning within the horizon scores best (earlier is better).
3. **Safety.** Leaves must satisfy `canStop`: some sequence of maximal braking steps
   (steering allowed) brings the car to rest without touching a wall. Unsafe leaves
   are heavily penalised, dead ends (every continuation crashes) more so, and moves
   that crash right now most of all.
4. **Other cars.** Landing on another car is a crash, so they block the immediate
   move exactly. For the second move of a plan, medium and hard bots also avoid the
   squares rivals occupy now or will reach if they keep their speed. Medium bots add
   a *fragility* penalty to plans that end where only one move keeps the car safe:
   with a rival on that one square the car would be forced to crash. (Measured over
   40 four-car races this cut medium-bot crashes from about 23 to 6, at no cost in
   lap time. Hard bots look far enough ahead not to need it.)
5. **Difficulty.** Easy adds random score noise and a 15% chance of a random
   non-crashing move; medium adds somewhat less noise; hard is deterministic. All randomness
   comes from an injectable seeded RNG, so bot games are reproducible in tests.

Wall checks and braking analysis are cached per track (`WeakMap`), so decisions take
milliseconds. The fastest possible solo lap on the oval is 27 turns — it needs one
deliberate crash to kill speed instantly — and 28 without crashing (both verified by
a full state-space BFS); hard bots do it in ~29 and never crash on purpose.

---

## Browser client (`src/client`)

- **`main.js`** routes between screens (menu, setups, online menu, lobby, race) and
  owns the active controller.
- **Controllers** share one interface, so the race screen doesn't care where the game
  runs: `getState()`, `getTrack()`, `canMove()`, `submitMove(acc)`,
  `subscribe(fn)`, `getLocalPlayerId()`, `dispose()`, emitting
  `{type:'state', state, moves, reset}`, `{type:'error', message}` and `{type:'meta'}`.
  - `LocalController` runs the engine and schedules bot moves with a (injectable)
    timer.
  - `OnlineGameController` adapts an `OnlineSession`: `canMove()` is true only on the
    local player's turn, while connected, with no move in flight; moves are sent with
    their turn number and the view waits for the server's snapshot.
- **`OnlineSession`** handles create/join/resume/leave requests (matched to `joined`
  or to an `error` naming the request type, with timeouts), stores the seat token in
  `sessionStorage` (per tab), and resumes the seat after reconnects or reloads. A
  leave made while offline is remembered (even across a reload) and delivered as soon
  as the connection is back — by reclaiming the seat and leaving it — so the car
  doesn't race on under autopilot. Requests the user abandons are cancelled; if one
  was already sent and still seats the player, the session leaves that room at once.
  The connection is closed when nothing is left to do online.
- **`Connection`** is a WebSocket wrapper with exponential-backoff reconnection
  (with jitter, capped at 8 s, retrying for as long as the connection is wanted),
  heartbeats that detect half-open connections, and no retries after fatal close
  codes (session taken over elsewhere, policy violation).
- A **new race** in an online room is recognised by the room's `raceNumber`, so a
  rematch that started while a player was offline still resets their view cleanly.
- **`GameView`** renders the HUD, handles pointer / keyboard / move-pad input,
  requires a second pick for crashing moves (and for board taps on touch screens or
  tiny boards, where a finger can easily hit the neighbouring point), ignores keyboard
  auto-repeat, animates the latest move (ending the animation on a timer too, because
  `requestAnimationFrame` stops in background tabs), rebuilds the race log from the
  history after a reload, shows countdowns, and keeps the result dialog's buttons in
  step with the room (it can be reopened from the side panel).
- **`Renderer`** draws the static layer (paper, hatching, grid, walls, checkered line)
  once per resize into an offscreen canvas, then per frame: trails, crash marks,
  velocity arrows, the nine options (safe ○, crash ✕, finish ★), cars, and effects.
  Walls are drawn exactly as the engine sees them.

All text from players is inserted with `textContent`, never as HTML.

### Languages (`i18n.js`, `locales/`)

- Each language is a flat catalog `key → message` (`locales/en.js`, `es.js`, `pt.js`,
  `it.js`). English is the reference and the fallback for any missing message.
- `t(key, params)` fills `{name}` placeholders. `tn(key, count)` picks the plural form
  `key.<form>` using `Intl.PluralRules` for the current language (with an optional
  `key.zero`), so a language with more plural forms just adds them to its catalog.
  `errorMessage(code)` turns an error code into a sentence.
- Static text in `index.html` is marked with `data-i18n="key"` (text),
  `data-i18n-html="key"` (markup from the catalogs only — never player input) and
  `data-i18n-attr="aria-label:key; title:key"`. `applyTranslations()` fills those
  in, and sets `<html lang>`, the page title and the description. The English text
  left in the HTML is only what shows before the script runs.
- Language choice: `?lang=` in the URL, else the saved choice (`localStorage`), else
  the first match in `navigator.languages`, else English. A change notifies
  `onLanguageChange` listeners; `main.js` then re-applies the static text and has
  each screen redraw its own: the setup forms, the connection status, the lobby and
  the race screen. The race log is rebuilt from the game history, and an open result
  dialog is re-rendered. Default names the game filled in ("Player 2") follow the
  language; names a player typed are kept.
- Nothing language-specific crosses the network or enters the engine. The server
  sends error codes and data; engine errors carry codes too. Each browser puts them
  into words, so players in one room can each use their own language.

---

## Server (`src/server`)

- **`app.js`** — Node `http` server. Serves `/` (index), `/client/*` and `/shared/*`
  only (server code is never exposed; path traversal is rejected), streams files with
  `pipeline()` so aborted downloads never leak file descriptors, `ETag`s with
  revalidation, `/healthz`, and security headers (CSP `default-src 'self'` with
  WebSockets allowed only to the page's own host, `nosniff`, no framing). Shutdown
  closes every WebSocket and cuts off peers that don't finish the close handshake
  within a second.
- **`wsGateway.js`** — `ws` on `/ws` with an 8 KiB message limit, global and
  per-address connection limits (`TRUST_PROXY` makes it use `X-Forwarded-For`),
  optional `Origin` allow-list, ping/pong heartbeats that terminate dead peers (only a
  pong counts as a sign of life), and termination of peers whose unsent backlog grows
  past 1 MiB because they stopped reading.
- **`roomManager.js`** — transport-agnostic and fully unit-tested with a fake clock:
  - *Rooms*: 5-character codes from an unambiguous alphabet, up to 4 seats, a host
    who manages bots/players/settings, host hand-over, de-duplicated names.
  - *Turns*: a move must come from the current player's connection and name the
    current turn number; anything else is rejected with a specific error code.
  - *Automation* (one timer per room, always checked against the turn it was
    scheduled for, so late timers can't act on a newer turn): bot moves after
    `BOT_MOVE_DELAY_MS`; turn time limits (autopilot move on expiry); disconnected
    players get `RECONNECT_GRACE_MS` from the moment they dropped, then the autopilot
    drives until they return. A turn's deadline belongs to that turn: presence
    changes, reconnecting, or resuming from another tab never extend it (a `resume`
    for a seat that is already connected changes nothing and isn't broadcast). With
    nobody connected the race pauses, and the player to move gets a full turn when
    it resumes.
  - *Lifecycle*: seats of players who disconnect in the lobby are held for a grace
    period; rooms with nobody connected close after 5 minutes; idle rooms are swept
    after 2 hours; on shutdown every client is told its room closed.
  - *Abuse*: per-connection token-bucket rate limiting where dropped messages are
    counted per 10 s window, so sustained floods are disconnected even when part of
    them gets through; a cap on open rooms per client address; strict message
    validation (unknown fields dropped); sanitised names; constant-time token
    comparison.

---

## Testing strategy

- **Unit tests** for the pure engine, geometry, bots (including property tests over
  random states) and protocol validation.
- **RoomManager tests** drive the coordinator through fake connections and a fake
  clock, which makes every timing rule (bot delays, grace periods, turn limits,
  pauses, cleanups) deterministic.
- **Integration tests** start the real server on an ephemeral port and play full
  races over real WebSockets, asserting that every client sees identical state after
  every move.
- **Client tests** run the controllers, the reconnecting connection and the online
  session in Node with a scriptable fake WebSocket.
- **Translation tests** check every catalog against English: keys (each language's
  plural forms allowed), placeholders, allowed markup, a message for every error
  code. They also scan `index.html` and the client code, so every key used exists
  and every catalog key is used.
- **End-to-end tests** (`test/e2e`) drive headless Chromium through the DevTools
  protocol (a ~200-line dependency-free client) across all three modes and the
  language switcher (with each tab's preferred languages pinned, so results don't
  depend on the host's locale), and fail on any browser console error.
