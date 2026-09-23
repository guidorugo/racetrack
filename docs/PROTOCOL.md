# Online protocol

JSON text frames over a WebSocket at **`/ws`** on the same host that serves the
game (`ws://` for HTTP pages, `wss://` behind TLS). Every message is an object with a
`type`. Validation and constants live in `src/shared/protocol.js`, shared by client
and server; the server-side logic is `src/server/roomManager.js`.

- Client messages larger than 8 KiB close the connection (code 1009).
- Unknown fields are ignored; wrong types are rejected with `BAD_MESSAGE`.
- Each connection may send ~15 messages/s (bursts of 30). Beyond that messages are
  dropped (with one `RATE_LIMITED` error per 10 s window); more than 200 dropped
  messages within a window closes the connection (code 1008).
- At most `MAX_CONNECTIONS_PER_IP` (30) connections per client address; further
  upgrade requests get HTTP 429.
- The server pings every 15 s and terminates peers that don't answer, or whose unsent
  backlog exceeds 1 MiB (they stopped reading). Clients also send `ping` and treat
  ~40 s of silence as a dead connection.

## Client → server

| `type` | Fields | Who / when | Effect |
| --- | --- | --- | --- |
| `create_room` | `name`, `settings?` | not in a room; at most `MAX_ROOMS_PER_IP` open rooms per address | Creates a room with you as host → `joined`, then `room`. |
| `join_room` | `code`, `name` | not in a room; room in `lobby` or `finished` | Takes a free seat (max 4) → `joined`, `room`. Names are sanitised and made unique. |
| `resume` | `code`, `playerId`, `token` | anyone holding a seat token | Re-attaches to the seat (after a reload or drop) → `joined`, `room`. A connection still attached to that seat is closed with code 4000. If the seat was still connected nothing else changes: no broadcast, and the turn clock keeps running. |
| `leave_room` | — | in a room | Frees the seat (lobby) or retires the car (mid-race) → `left` (`reason: "left"`). |
| `add_bot` | `level`: `easy` \| `medium` \| `hard` | host, not during a race | Adds a bot seat. |
| `remove_player` | `playerId` | host, not during a race | Removes a bot or kicks a player (they receive `left` with `reason: "kicked"`). |
| `update_settings` | `settings` (partial) | host, not during a race | Updates room settings. |
| `start_game` | — | host, ≥ 2 seats, not during a race | Starts a race with the current seats (also used for rematches). |
| `move` | `turn`, `acceleration: {x, y}` | the player whose turn it is | Applies the move if `turn` equals the current turn number. |
| `ping` | — | anyone | → `pong`. |

`settings`: `{ trackId: "oval", laps: 1 | 2 | 3, finishMode: "first" | "all", turnTimeLimit: 0 | 30 | 60 | 120 }`
(seconds; `0` = no limit). `finishMode` decides when the race ends: `"first"` as soon
as someone finishes, `"all"` once every car still racing has finished (the first one
across still wins). Defaults: oval, 1 lap, `"first"`, 60 s.

Room codes are 5 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`; input is
case-insensitive and may contain spaces or dashes.

## Server → client

| `type` | Fields | When |
| --- | --- | --- |
| `welcome` | `protocol`, `serverTime` | On connect. Clients should ask the user to reload if `protocol` differs from theirs (currently `1`). |
| `joined` | `code`, `playerId`, `token` | After a successful create/join/resume. Keep `token` secret; it is needed to `resume`. |
| `room` | `room` (snapshot below) | To everyone in the room after **every** change. |
| `left` | `reason`: `left` \| `kicked` \| `room-closed` | You are no longer in the room. |
| `error` | `code`, `message`, `requestType`, `details` | A request failed. `requestType` names the message type that caused it. `message` is plain English for logs and simple clients; user interfaces should show their own text for `code` (see below). |
| `pong` | `serverTime` | Reply to `ping`. |

### Room snapshot

```jsonc
{
  "code": "K7QXP",
  "phase": "lobby",          // "lobby" | "playing" | "finished"
  "version": 12,             // increases with every broadcast
  "raceNumber": 0,           // increases with every race started in the room
  "hostId": "p1",
  "settings": { "trackId": "oval", "laps": 1, "finishMode": "first", "turnTimeLimit": 60 },
  "seats": [
    { "playerId": "p1", "name": "Ada", "kind": "human", "botLevel": null, "color": "#0072B2",
      "connected": true, "autopilot": false, "left": false },
    { "playerId": "p2", "name": "Nitro (bot)", "kind": "bot", "botLevel": "hard", "color": "#D55E00",
      "connected": true, "autopilot": false, "left": false }
  ],
  "game": null,              // full GameState during and after a race (see docs/ARCHITECTURE.md)
  "turnDeadline": null,      // epoch ms (server clock) when the current turn times out
  "waitingFor": null,        // { playerId, until } while waiting for a disconnected player
  "serverTime": 1790170000000
}
```

Seat tokens are never included in snapshots. `serverTime` lets clients convert
`turnDeadline` / `waitingFor.until` to their local clock. A move made by the server
for a player carries `note: "timeout"` or `note: "autopilot"` in the game history.

## Error codes

Codes are stable and meant for programs; the `message` next to them is English and may
change. The web client shows its own translation of every code below (in the player's
language), and falls back to `message` for a code it doesn't know.

| Code | Meaning |
| --- | --- |
| `BAD_MESSAGE` | Not JSON / not an object / missing or mistyped field / unknown bot level. |
| `UNKNOWN_TYPE` | Unknown message `type`. |
| `RATE_LIMITED` | Too many messages. |
| `SERVER_FULL` | Room limit reached. |
| `TOO_MANY_ROOMS` | Too many open rooms created from your address. |
| `INVALID_NAME` | Empty name after sanitising. |
| `INVALID_SETTINGS` | Settings out of range. |
| `INVALID_ROOM_CODE` | Code has the wrong format. |
| `ROOM_NOT_FOUND` | No such room (or it closed). |
| `ROOM_FULL` | All 4 seats taken. |
| `GAME_IN_PROGRESS` | Not allowed while a race runs (joining, lobby changes, starting twice). |
| `ALREADY_IN_ROOM` | Leave your current room first. |
| `NOT_IN_ROOM` | The request needs a room. |
| `NOT_HOST` | Only the host can do that. |
| `INVALID_SESSION` | `resume` with an unknown seat or wrong token. |
| `SESSION_REPLACED` | Your seat was resumed from another connection (followed by close code 4000). |
| `NOT_ENOUGH_PLAYERS` | Fewer than 2 seats. |
| `GAME_NOT_RUNNING` | `move` outside a race. |
| `STALE_TURN` | `move.turn` is not the current turn (`details.turn` has the current one) — e.g. a double click. |
| `NOT_YOUR_TURN` | It is someone else's turn. |
| `INVALID_ACCELERATION` | Acceleration components must be integers in `[-1, 1]`. |
| `UNKNOWN_PLAYER` | `remove_player` target does not exist (or is yourself). |
| `INTERNAL_ERROR` | Unexpected server error (logged). |

## Close codes

| Code | Meaning | Client reaction |
| --- | --- | --- |
| 1001 | Server shutting down | Reconnect with backoff (rooms are gone after a restart). |
| 1008 | Policy violation (flooding) | Do not reconnect. |
| 1009 | Message too big | Reconnect. |
| 4000 | Session taken over by another connection | Do not reconnect; forget the seat. |

## Typical flows

**Create, join, race**

```
A → create_room {name:"Ada"}            A ← joined {code:"K7QXP", playerId:"p1", token}
                                        A ← room {phase:"lobby", seats:[Ada]}
B → join_room {code:"k7qxp", name:"Bo"} B ← joined {playerId:"p2", …}
                                        A,B ← room {seats:[Ada, Bo]}
A → add_bot {level:"hard"}              A,B ← room {seats:[Ada, Bo, Piston (bot)]}
A → start_game                          A,B ← room {phase:"playing", game:{turn:0, …}}
A → move {turn:0, acceleration:{x:1,y:0}}   A,B ← room {game:{turn:1}}
B → move {turn:1, acceleration:{x:1,y:0}}   A,B ← room {game:{turn:2}}
      (server moves the bot after BOT_MOVE_DELAY_MS)  A,B ← room {game:{turn:3}}
…                                       A,B ← room {phase:"finished", game:{winnerId:"p3"}}
```

**Dropped connection**

```
(B's socket dies)                       A ← room {seats:[…, {playerId:"p2", connected:false}]}
(if it is B's turn)                     A ← room {waitingFor:{playerId:"p2", until}}
(after RECONNECT_GRACE_MS)              A ← room {seats:[…, {autopilot:true}]}, then moves noted "autopilot"
B → resume {code, playerId:"p2", token} B ← joined, A,B ← room {…connected:true, autopilot:false}
```
