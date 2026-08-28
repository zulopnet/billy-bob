# Billy Bob Joe Bob and the Chocolate Banjo

A browser game in Three.js. Billy Bob Joe Bob lives in the back of the
**Giga-Mart Wholesale Club**, in a fort made of paper towels, with a banjo made
of magic chocolate. Six critters in the store can play. Beat all six at a banjo
duel and they join your band for the show on the Free Sample Stage.

Plays with an Xbox controller, a keyboard, or a phone in landscape. **Co-op**:
two players split-screen on one television, or up to four over the internet. No
art assets: every mesh, texture and sound effect is generated in code at runtime.
The exception is the three backing loops, which are generated banjo recordings —
see [The music](#the-music).

Live at <https://zulop.net/games/billy-bob/>.

---

## Playing

| | Controller | Keyboard P1 | Keyboard P2 |
|---|---|---|---|
| Walk | left stick | `WASD` | `IJKL` |
| Look | right stick | arrow keys | numpad `8 4 6 2` |
| Jump / fork up / fly up | **A** | `Space` | `Right Shift` |
| Duel · drive · get out · strum | **X** | `E` | numpad `0` |
| Flying banjo (and the horn) | **B** | `Q` | numpad `.` |
| Dance / fork down / fly down | **Y** | `F` | numpad `+` |
| Pause | **☰** Start | `Esc` | — |
| The four banjo strings | **A B X Y** | `1 2 3 4` (or `Z X C V`) | numpad `7 9 1 3` |

The four strings are bound to the four face buttons deliberately: an Xbox pad's
A/B/X/Y are physically coloured green/red/blue/yellow, and those are exactly the
four string colours the duel draws. *"Press the green one"* is then a complete
instruction for a child who cannot read yet.

The two keyboard halves share no keys at all, because two children on one
keyboard will lean on each other's. That cost the numpad its old job as a
left-handed alias for WASD — an alias that silently steers the *other* player is
worse than no alias.

URL overrides: `?quality=low|high`, `?touch=1|0`, `?room=ABCD` (join that online
game directly), `?ws=` (point the relay somewhere else).

## Playing together

The title screen's PLAY button opens **"Who's playing?"**, and the choice is made
once per session:

* **Just me** — one player, as it always was.
* **Two of us, here** — split-screen on one screen. Player 1 on top. A second
  gamepad drives player 2 if there is one; otherwise the second keyboard set
  above does. The store, the chocolate chips and the band are shared; the melt
  meter, the camera and the flying banjo are per-player.
* **Somebody far away** — up to four players over the internet. You get a
  four-letter code to read out, or you type in the one you were given.
  <https://zulop.net/games/lobby> can also arrange the match and launch everybody
  into the same room at once.

Split-screen and online are an either/or, on purpose: two local players sharing
one socket would need two seats in the room and two outbound streams, and nobody
has asked for four children across two televisions.

**Online play degrades to single player and never breaks.** If the relay goes
away mid-game the peers quietly disappear, the connection pill says so, and the
store carries on. Nothing in `net/` is allowed to throw into the frame loop.

## The duels

### Against a critter

A critter plays a phrase of coloured notes; you play it back. Three or four
rounds, each a note longer than the last.

**You cannot lose a duel with a critter.** A wrong note makes a slide-whistle
noise and the same phrase plays again. Three wrong in a row and the phrase
quietly gets one note shorter until you can do it. What you actually play for is
the star: a duel cleared with no mistakes at all is worth a gold one.

Every note is consonant with every other (the four strings are a G major triad
plus the octave), so a child mashing all four buttons gets a chord rather than a
car crash.

### Against another player

Press **X** on another player — in split-screen or online — and you duel each
other instead. It is the same call-and-response shape and a different game:

* The phrase is **improvised**, not generated. Whoever is calling plays as many
  notes as the round asks for, on whatever strings they like.
* The other one plays it straight back. Then they **swap**, and the phrase gets
  one note longer, up to six.
* Each player has **three strings**. A wrong echo costs one. Run out and you
  lose the duel.

**Pause ends it.** Two players who never miss are never eliminated, so a player
duel is the one mode that could in principle run forever — pressing pause calls
it off for both of them. (A critter duel needs no such escape: it always ends by
itself.)

This one *does* have a loser, which is the one place in the game that is true.
Losing to the game is miserable and pointless; losing to your brother is the
entire point, he is right there, and you can immediately play again. It is still
padded: three strings rather than one, and a caller who freezes is never
punished — the clock running out on a *call* plays a note for them and moves on.
Only the echo can cost you anything. Both players get chocolate chips at the end.

A duel takes the whole screen and un-splits it. It is a shared moment, and it is
also enormously simpler than running two duel state machines side by side.

## Big Earl, the forklift

Big Earl used to be the sixth critter. He is a vehicle now — walk up and press
**X**.

One stick does everything: push forward to go, pull back to reverse, push
sideways to steer. Velocity is always along the heading, so he physically cannot
spin out or end up facing a way nobody asked for; the steering assist is huge at
walking pace and tapers off with speed. **A** raises the forks and **Y** lowers
them, 4.6m of travel, and **B** is the horn.

The deck on the forks is a **real moving platform**. One player drives, the other
stands on the forks and gets lifted to the top of the racking — which is the
co-op half of the whole feature, and the reason `Player.groundProviders` exists.
Riders are swept along by the frame's translation *and* rotated about Earl's
centre by the frame's turn, so riding round a corner works the way it looks like
it should. They are still not allowed inside a rack.

## The flying banjo

**B** used to say "howdy". It now sends the banjo up on its own.

The racking is 8m tall, loaded to 6.3m, and the ceiling is at 11m, so a good
third of the interesting places in the building are above where a jump reaches.
Big Earl's forks solve that for two players; this solves it for one. While the
banjo is out, the body stands where it was left and the camera goes with the
banjo — it is a mode, not a gadget.

Three rules stop it from becoming a way to get lost:

* It runs on a **flight meter**, and an empty meter simply flies it home. It
  cannot strand anybody, anywhere, ever.
* It is **tethered**. Past 26m from the body it is pulled back — hard enough that
  you cannot cross the store with it, gently enough that you do not notice.
* It **cannot go through the building**. Soft collision, fat radius: this is for
  reaching a shelf, not for noclip.

Its grab radius is deliberately wider than a walking player's: at 6m up, judging
a metre and a half by eye is genuinely hard.

## The melt meter

The banjo is chocolate. Near the rotisserie in the food court it softens, then
droops, then melts — and melting just walks you to the freezer with a funny
noise. Nothing is ever lost. Cool off in **Frosty Foods**, or grab one of the ice
pops scattered around the warm half of the store. Every player has their own
meter; melting takes the flying banjo home with you, or you would be warped to
the freezer while your camera stayed six metres up an aisle.

## The band

| | Who | Where | Instrument |
|---|---|---|---|
| 🦝 | Ricky Raccoon | Aisle 1, up the pallets | washboard |
| 🐐 | Doris the Goat | Garden & Patio | mouth harp |
| 🐧 | Chilly Pete | Frosty Foods | icicle chimes |
| 🐶 | Meatball | The Hot Rotisserie | squeaky-toy bass |
| 🕊️ | Sir Reginald | The Television Wall | mandolin |
| 🦉 | Wanda the Warehouse Owl | The Loading Dock | slide whistle |

Wanda took Big Earl's seat when he became drivable. She is deliberately on the
dock **floor** rather than up in her rafters: she is the last duel, and putting
her somewhere that needs the flying banjo would make finishing the game depend on
finding a mode you can miss.

---

## The music

Three backing beds — `store`, `duel` and `finale` — plus every duel note, live in
`core/Audio.js`.

Every duel note is synthesised — a Karplus-Strong plucked string rendered
offline per pitch, sequenced by a lookahead scheduler that hands the audio thread
absolute start times. So is the unused `title` bed.

**The three beds are recordings**: `src/audio/{store,duel,finale}-loop.ogg` are
ACE-Step 1.5 renders, and they are the only samples in the game. Four things
about them matter:

- **They are all in G major**, at the tempo of the pattern each replaced (132,
  146, 152), and so is `STRINGS`. A duel plays those pitches straight over
  whatever bed is running, so a bed in another key makes every *correct* answer
  sound wrong. This is the constraint to respect if you ever regenerate one.
- **They are cut to loop.** A raw generation opens with an intro and closes with
  a fade-out, which seams audibly every pass. `tools/loopify.py` takes a 16-bar
  region starting on a downbeat, searches ±half a bar for the end whose following
  audio best continues the start, and crossfades that material back over the head.
- **Their levels are measured, not judged by ear.** `BEDS[name].gain` puts the
  store bed 2 dB under the arrangement it replaced — a continuous recording at
  equal RMS crowds the effects over it — then holds the other two at their
  original level *relative* to it, so the duel still drops back and the finale
  still opens up. The measurement is in the comment above `BEDS`.
- **They fail soft.** If a file will not load or decode, `setMusic` falls back to
  that bed's `PATTERNS` entry and the game sounds exactly as it used to. That is
  deliberate, and it is also why you cannot tell by ear whether the files
  arrived — `node tools/bed-check.mjs` asserts the buffer sources specifically.

Regenerating one:

```sh
python tools/gen-music.py <outdir> tools/music-spec.json   # ACE-Step 1.5 + a GPU
python tools/loopify.py take.wav loop.wav --bars 16 --bpm 132
ffmpeg -i loop.wav -ac 1 -ar 44100 -c:a libvorbis -q:a 4 src/audio/store-loop.ogg
ffmpeg -i loop.wav -ac 1 -ar 44100 -c:a aac -b:a 96k  src/audio/store-loop.m4a
```

`tools/music-spec.json` holds every prompt that was auditioned, shipped one
first. Mono, because nothing in a bed is panned and stereo doubled the download
for nothing. Vorbis is preferred at load time and AAC is the Safari fallback:
both `decodeAudioData` faithfully, where MP3's encoder padding would tick at the
wrap. Re-rendering gives a *new* take — the seed ACE-Step reports back is not the
one you passed it — so keep the files rather than expecting to reproduce them.

---

## Building and testing

```sh
npm install
npm run dev            # vite dev server on :5175
npm run build
npm run preview        # serve the build on :4174

node tools/smoke.mjs   # 55 checks in a real browser against dist/
node tools/gamepad.mjs # 22 checks driving a synthetic Xbox pad
node tools/bed-check.mjs             # 19 checks: the beds loaded, not the fallback
node tools/shots.mjs   # screenshots of every scene into shots/
node tools/shots.mjs duel raccoon    # or just some of them
```

`tools/smoke.mjs` drives the built game in headless Chromium. The first page is
solo: it boots, walks, jumps, collides, checks the melt meter both ways, plays a
whole duel correctly by reading the phrase out of the live `Duel` object, checks
that wrong notes never end a critter duel, and runs the finale to the end screen.
A **second page** then boots in split-screen and covers everything co-op: two
players who answer only to their own half of the keyboard, Big Earl driven and
his forks used as a moving platform with a rider carried on them, the flying
banjo reaching a chip no jump could, and a whole player-versus-player duel played
through to a winner.

The co-op half deliberately steps the state machines with fixed `dt` rather than
waiting on wall-clock time: SwiftShader renders at about one frame a second, and
a duel driven by real frames would take most of a minute and be flaky besides.

`tools/gamepad.mjs` stubs `navigator.getGamepads` with a synthetic pad and plays
the game through it — including winning a whole duel on A/B/X/Y alone. It runs
the suite twice, once for `mapping: 'standard'` (Chrome on Windows/macOS) and
once for the Linux xpad layout where `mapping` is `''`, the right stick is on
axes 3/4 rather than 2/3 and the triggers are bipolar axes. That second pass is
the one that catches "my controller half-works on Linux".

`tools/shots.mjs` exists because a passing smoke test proves the machine runs and
proves nothing about whether the store *looks* like a store. Several real bugs in
this repo — mirrored signs, a banjo held upside down, 1.3m aisles, an oven with
its contents sealed inside it — were only ever visible in a screenshot.

Both run on SwiftShader, so **treat frame rate as relative only**; a stall there
is the software rasteriser, not the game. Draw-call and triangle counts *are*
meaningful.

## Module map

```
src/
  main.js              boot, and the fatal-error screen
  core/
    Input.js           gamepad + keyboard + touch -> one InputState, x2 players
    touch.js           SHARED mobile layer — see the warning below
    Audio.js           Karplus-Strong banjo, SFX, the backing band, and the
                       three recorded beds
  audio/
    store-loop.ogg     the only samples in the game — see The music above
    duel-loop.ogg
    finale-loop.ogg
    *.m4a              the same loops for Safari, which will not decode Vorbis
    MathUtils.js       frame-rate-independent damping
    Rng.js             seeded mulberry32
  net/
    NetClient.js       online co-op: rooms, peers, interpolation, world sync
  world/
    Store.js           the building, collision, and the heat zones
    Textures.js        every surface, drawn on a canvas
    Batch.js           static-geometry merging + instanced pools
  chars/
    Rigs.js            the four players, the banjo, five critters, Big Earl,
                       the flying banjo, and the pickups
  game/
    Game.js            renderer, viewports, mode state machine, entity lists
    Player.js          movement, the follow camera, the melt meter
    RemotePlayer.js    somebody else's Billy Bob, drawn from the wire
    Duel.js            the call-and-response state machine (vs a critter)
    PvpDuel.js         the call-and-response state machine (vs a player)
    NoteMotes.js       the coloured lights both duels fly between players
    Forklift.js        Big Earl, driving, and the fork platform
    FlyingBanjo.js     the B-button mode
    HUD.js             all interface, in the DOM
```

The server half lives in the website repo, not here:

```
~/saas-website/server/multiplayer.js          the /ws/bb relay (makeRoomRelay)
~/saas-website/server/multiplayer-bb.test.cjs 17 checks against that relay
~/saas-website/src/pages/GameLobby.jsx        the lobby's entry for this game
```

`node multiplayer-bb.test.cjs` (run from `~/saas-website/server`) stands the hub
up on a throwaway port and plays the wire protocol through it with two real
clients. It covers the half of online co-op the browser tests cannot reach:
`tools/smoke.mjs` exercises split-screen, where both players are local, and stops
at the socket.

### Things that will bite you

- **`src/core/touch.js` is copy-duplicated across four repos** with no shared
  package. A fix here must be applied to all four: `~/cave-ray/game/src/core/`,
  `~/dog/src/core/`, `~/forged-dominion_3D/src/ui/`, `~/billy-bob/src/core/`.

- **Player 1 must come first in `Game.players`.** `NetClient` walks that list
  looking for the first entry with `isLocal !== false` to decide whose position
  to broadcast. A remote peer ahead of the local player puts somebody else's
  coordinates on the wire under your name.

- **Side 0 in a `PvpDuel` is always the challenger, on BOTH machines.** That
  agreement is the only reason a relayed note lands on the right player. Notes
  are the machine's sole input, so both clients derive the same state from the
  same stream. The two exceptions are the clocks, and they are split on purpose:
  a **call** timeout plays a note for whoever froze and is run by the client that
  owns that player (so it cannot race that player finally pressing a button); an
  **echo** timeout costs a string, which is scoring, and is run only by
  `authority` (so two machines cannot decide different winners).

- **Exactly one thing may write `camera.position` per frame.** In a split-screen
  player duel both bodies are local and both would otherwise run
  `_placeDuelCamera` on the same camera; the result is a camera vibrating between
  two nearly-identical two-shots. `_updatePvp` hands the camera to the first
  local side only. The same rule is why a forklift driver's `Player` deliberately
  does not place a camera.

- **`locked` is not "cannot act".** It means "your body stands still and your
  camera is framed for you", and every local player is locked during a duel —
  the duellists included. That is what routes them through `_updateLocked`, which
  is what holds the duel camera.

- **WebGL's viewport origin is bottom-left.** Player 1 is the top half, so player
  1 gets the *higher* y in `_render`. Getting it backwards silently swaps the two
  views and looks like a control bug.

- **A chase camera on a fixed boom does not survive contact with the building.**
  `Game._placeDriveCamera` pulls its boom in with `Player._clearance` and clamps
  to the shell for a reason: Earl parks at `z = -37`, the boom is 9.5m and the
  back wall is at `z = -45`, so climbing into him where he starts put the camera
  *outside the building*, filling the screen with the inside face of a wall
  until you drove away. The smoke tests were entirely happy about it. It was
  `tools/shots.mjs` that found it, which is the whole argument for that tool.

- **Split-screen shots need `_render()`, not `renderer.render()`.** A split shot
  taken with a bare `render()` comes out as one full-screen view of player 1 —
  which looks fine and is wrong.

- **X is read twice per frame, and Big Earl is where that bites.**
  `_updateForklift` asks "does the driver want out?"; `_updateInteraction`, later
  in the same frame and off the same `InputState`, asks "does anybody want in?".
  `pressed` is a one-frame edge, so both see the same press. Three separate
  guards exist because of this and none of them is optional:

  - `ENTER_GRACE` — the press that puts a child in the seat is still flagged
    when the ride's first update runs. Without it you cannot get in at all.
  - `EXIT_COOLDOWN` + `canEnter` — exit() drops you 2.1m away and the boarding
    range is 3.6m, so without it the press that got you out put you straight
    back in, and X looked completely dead. This one shipped, briefly.
  - `Game._exitedThisFrame` — and the same press would otherwise do everything
    *else* X does at the spot you were dropped. Park Earl beside Wanda, press X
    to get out, and you land in a banjo duel you did not ask for.

  Note that calling `enter()` and `exit()` directly — as most of the forklift
  checks in `tools/smoke.mjs` do — cannot reproduce any of these. They only
  happen through the loop, which is why there is a check that drives the whole
  thing with real key presses.

- **Banner and sign facing.** A plane's normal points at `+Z`, so `rotY` is the
  direction it faces and every banner must face *into* the building: back wall
  `0`, front wall `π`, left wall `π/2`, right wall `-π/2`. Get it wrong and the
  text renders mirrored. Signs are `FrontSide` so the wrong side vanishes rather
  than reading backwards.

- **`AISLE_HALF_WIDTH` in Store.js.** It sets how far the racking sits from an
  aisle centreline, and the walkable aisle is `2 * (AISLE_HALF_WIDTH - 1.3)`.
  At the original value the aisles were 1.3m across and no camera could see
  anything but cardboard.

- **`Batch.add` buckets by material identity.** Pass a fresh material per prop
  and you get one draw call per prop and no saving at all. Anything that *moves*
  must not go through `Batch` — use an `InstancePool` (the pickups) or a plain
  mesh.

- **`mergeStatic` in Rigs.js** collapses a rig's static parts. A mesh that
  animates on its own transform must be marked `userData.animated = true` or it
  silently stops moving, with no error. Big Earl's beacon, his wheels and his
  fork carriage are all marked; the carriage especially, since a merged carriage
  is a forklift whose forks never leave the floor.

- **`tools/shots.mjs` must park the render loop** before setting the camera.
  `Player._placeCamera` runs every frame and will overwrite it, and every shot
  quietly comes out as the default follow camera.

- **Playwright against zulop.net: never pass a string predicate to
  `waitForFunction`.** The site sends `script-src 'self' 'wasm-unsafe-eval'`,
  string predicates get `eval`'d in the page, CSP blocks them, and the harness
  reports "not booted" for a page that is fine. Pass a function.

## Deploying

Three steps for the game, and skipping either of the last two is a *silent*
failure:

```sh
npm run deploy                              # 1. build + copy into public/games/
cd ../saas-website && npx vite build        # 2. public/ is only copied at ITS build
#    3. 'billy-bob' must be in GAME_SLUGS in saas-website/server/server.js
systemctl --user restart zulopai-backend
```

`express.static` runs with `index: false`, so a slug missing from `GAME_SLUGS`
does **not** 404 — it falls through to the SPA catch-all and serves the React
homepage with HTTP 200. Cache purging cannot fix it and `curl` returns 200
either way. Verify in a real browser.

`npm run deploy` checks all three and prints what is outstanding.

**Online play needs the backend restart specifically.** The `/ws/bb` relay lives
in `saas-website/server/multiplayer.js`, which is server code — a `vite build`
does not touch it. A deploy that skips the restart ships a game whose "Somebody
far away" button dials a socket the server has never heard of, and the error the
player sees is a generic "could not reach the game server".

## On the names

The Giga-Mart Wholesale Club is invented, as are every brand, product and
critter in it. All music is generated at runtime from an original chord
progression and a pentatonic set; the bluegrass forward roll used in the
arrangement is a picking technique, not a tune. Nothing here quotes or depicts
any real company, film or composition.
