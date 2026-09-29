# Dubs — NBA 2K head-to-head tracker

An installable web app for tracking NBA 2K rivalries with your friends:

- Create an account (username + 4-digit PIN), search for friends by name, and add them instantly.
- Every friendship gets its own head-to-head tracker, and each player sees **their side** of the same
  games: their record, their streaks, their wins.
- Everything lives in one shared Google Sheet.

It's vanilla HTML/CSS/JS with no build step, and it works offline.

## Run locally

```bash
python3 -m http.server 5173
```

Open http://localhost:5173. (ES modules and the service worker need a server; `file://` won't work.)

With no Apps Script URL in `config.js`, it runs in **demo mode**:
- Sample accounts alex / 1111, sam / 2222, jordan / 3333 and riley / 4444, with some friendships and
  games already set up, all stored in your browser. You can also create new accounts.
- **Settings → Demo Mode** has a Sample Data switch and a **Simulate Offline** switch for trying the
  offline queue.

## Connect the Google Sheet

Follow **[SETUP.md](SETUP.md)**. In short: create a Sheet, paste `apps-script/Code.gs`, run
`setupSheet`, deploy as a web app, and put the URL in `config.js`. Then everyone signs up in the app.

## Deploy the site

The folder is the site; there's nothing to build.

- **GitHub Pages:** push this folder to a repo → Settings → Pages → Deploy from branch → `main` / root.
- **Netlify:** drag the folder onto app.netlify.com/drop, or run `netlify deploy --prod --dir .`

Then open the URL in Safari on each phone → Share → **Add to Home Screen**.

When you ship changes, bump `VERSION` in `sw.js`.

## How it works

- **Neutral storage, personal view.** Games are stored as `player1` / `player2`. `js/stats.js` turns each
  game into "me vs opponent" for whoever is signed in, and computes everything from that side. Wins
  flip to losses on the other phone.
- **Optimistic sync.** A saved game appears instantly and goes into an outbox (`js/store.js`) that's
  sent to the Sheet in the background.
  - If the phone is offline, the outbox waits and sends when the connection returns.
  - Adds are idempotent, so retries never create duplicates.
  - The nav bar shows *Saving*, *Offline · N pending*, or *Couldn't sync · Retry*.
- **Always fresh.** Data refreshes when the app opens, when it returns to the foreground, every 25
  seconds while open, and when the connection comes back. The last known data is cached, so the app
  opens instantly.
- **Accounts and friends.**
  - Sign up with a name, a username and a PIN. The server hashes the PIN, rate-limits wrong tries
    (5 → 5-minute lockout) and returns a session token that every read and write needs.
  - Accounts you've used on a phone appear as "Continue as …" on the welcome screen.
  - **Friends** searches everyone by name or @username. **Add** is instant, works both ways, and
    opens your tracker with that person. The dashboard's "vs Name ⌄" switches between rivalries,
    and the app reopens on the last one you viewed.
  - You can only log or edit games between yourself and a friend.
  - The phone stays signed in. **Require PIN on Open** in Settings re-asks for the PIN on launch
    (checked on-device, so it works offline).
- **Two games: NBA 2K and FIFA.** Every game has a `sport` (`2k` or `fifa`; empty = 2K). Settings →
  Game Mode picks which one the app shows, and it opens on whichever game you logged last. The screens
  are the same; FIFA swaps in draws (W–D–L), goals and goal difference, extra time (ET), penalty
  shootouts (PEN, stored as `player1_pens` / `player2_pens`), 1-goal games and clean sheets. FIFA
  teams come from the `FIFA Clubs/` folder (country → team in the picker) and are stored as `F-` + code (e.g. `F-ARS`).
- **Soft deletes.** Deleting sets `deleted = TRUE` in the Sheet. Undo sets it back.

## Project layout

```
index.html              App shell, PWA meta tags, boot script that avoids a lock-screen flash
config.js               APPS_SCRIPT_URL (empty = demo mode) and poll interval
manifest.webmanifest    PWA manifest
sw.js                   Service worker: network-first shell, cache-first logos
apps-script/Code.gs     Google Apps Script backend (see SETUP.md)
css/tokens.css          Design tokens: colour (light + dark), type scale, spacing, radii, motion
css/app.css             Layout and components
js/api.js               The one API module: signUp, signIn, signOut, getMe, getFriends, searchUsers,
                        addFriend, getGames, addGame, updateGame, deleteGame
js/demo.js              Demo backend behind the same interface (localStorage)
js/store.js             State, cache, optimistic outbox, offline queue, polling, sync status
js/stats.js             Pure stats: perspective(game, playerId), computeStats(games, playerId)
js/lock.js              Welcome, sign-in and sign-up screens, and the PIN pad
js/app.js               Screens, game form, team picker, swipe-to-delete, navigation
js/ui.js                Icons, logo tiles + fallback, sheets, alerts, toasts, haptics, count-up
js/teams.js             The single teams data file (name, city, nickname, abbr, colour, logo)
js/sample.js            Deterministic sample games for demo mode
assets/logos/           30 normalized 256×256 transparent WebP logos (abbr.webp)
tools/process_logos.py  Re-runnable logo pipeline (originals → assets/logos)
tools/process_icon.py   App icons, favicon and link-preview image from tools/logo-source.webp
tools/process_avatars.py Profile pictures (~/Desktop/H2H-Avatars → assets/avatars)
tools/process_clubs.py  FIFA teams: "FIFA Clubs/" → assets/clubs, assets/flags and js/clubs.js
tools/logo-sources/     Renamed copies of the original logo files
```

## Logos

`tools/process_logos.py` reads the originals from `~/Desktop/claudeHOOPS/NBA-Logos` and never modifies them.
It removes flat white and fake-checkerboard backgrounds, trims, centres on a 256px canvas and writes WebP.
If a logo is missing or fails to load, the app shows the team abbreviation on a circle of the team colour.
