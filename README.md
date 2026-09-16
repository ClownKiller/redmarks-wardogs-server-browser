# RedMarks Wardogs Server Browser

A Windows server browser for **WARDOGS**: browse every official and community server, see which map each is on and how full it is, track your favourites, and jump in with one click.

## What it does

- **Servers:** switch between **Official** and **Community** to see every server live: map, mode, region, players, full or empty, password lock, and ping estimate. Search, filter by region, and hide full, empty or locked servers.
- **Join:** copies the server's join code and starts WARDOGS through Steam. Paste the code (Ctrl+V) in the in-game server browser. WARDOGS has no official direct-join link yet.
- **Favourites:** star any server, or add one by its join code. Join codes don't change when a server restarts, so favourites keep working.
- **Regions:** players and servers in each region, a 24-hour trend, and your ping estimate to each one.
- **Details:** live info, join code with a copy button, level and cash limits, player history (24 hours to 90 days), uptime, and maps played.
- **Refreshes every 5 minutes** (or 10 or 15, set in Settings).

## Safe by design

- The app **never** opens, reads or changes WARDOGS game files, never reads game memory, and never runs inside the game.
- It never contacts Bulkhead's servers. The only Steam action is starting WARDOGS when you click Join, like a desktop shortcut.
- Server data comes from the free public [Wardog Servers API](https://wardogservers.com/devs), used as its owner asks: the whole list is downloaded once per refresh and filtered in the app, unchanged data is skipped, and requests are limited to 20 a minute.
- **Ping is an estimate.** Server addresses aren't public, so the app times a normal HTTPS connection to a large data centre in each region.
- Favourites and settings are saved in `%APPDATA%\RedMarks Wardogs Server Browser\`.

Server data: [Wardog Servers](https://wardogservers.com/). Not affiliated with Bulkhead, Team17 or Wardog Servers.

## Install

1. Open the **Releases** section on the right of this page and pick the newest release.
2. Download `RedMarks-Wardogs-Server-Browser-Setup-x.x.x.exe` and run it.
3. If Windows says "Windows protected your PC", click **More info**, then **Run anyway**. This appears because the app isn't signed with a paid certificate.

## Updating the project

1. Open the zip you were sent, select everything inside it, and copy it into this repository's folder on your PC. Choose **Replace** when asked.
2. In GitHub Desktop, type a short summary (for example "Version 1.0.0") and click **Commit to main**, then **Push origin**.
3. On github.com, open the **Actions** tab and wait for the green tick (about 5 minutes).
4. The new installer appears under **Releases**, and also at the bottom of the finished Actions run.

If the run shows a red cross, open it, click the failed step, and send a screenshot of the error.

## Project files

| Path | What it is |
| --- | --- |
| `.github/workflows/build.yml` | Tells GitHub how to test and build the installer |
| `build/icon.ico`, `build/icon.png` | App and installer icon |
| `scripts/copy-assets.js` | Copies the fonts and icons into the app during the build |
| `src/main/main.js` | Starts the app window and handles its security |
| `src/main/preload.js` | The fixed list of actions the screen may request |
| `src/main/api.js` | Talks to the Wardog Servers API (cache, rate limit, join-code checks) |
| `src/main/ping.js` | Region ping estimate |
| `src/main/store.js` | Saves favourites (by join code) and settings |
| `src/renderer/index.html` | Window layout |
| `src/renderer/styles.css` | Colours, fonts and look (edit here to re-skin) |
| `src/renderer/app.js` | Tabs, tables, filters and refresh timer |
| `src/renderer/chart.js` | Player history chart |
| `src/renderer/icon.png` | Window icon |
| `test/core.test.js` | Automated tests, run before every build |
| `package.json`, `package-lock.json` | App name, version and exact library versions |

## For developers

Requires Node.js 22.

```bash
npm ci          # install exact library versions
npm start       # run the app
npm test        # run the tests
npm run dist    # build the Windows installer into dist/
```

Fonts: Barlow Condensed and Saira Stencil One (SIL Open Font License). Icons: Tabler Icons (MIT).
