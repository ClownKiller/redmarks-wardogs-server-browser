# RedMarks Wardogs Server Browser

A Windows server browser for **WARDOGS**: see top community servers, track your favourites, check who's online, and see which map a server is on, how full it is, and a ping estimate for its region.

## What it does

- **Top 100:** the most popular community servers over the last 7 days. Star any to track it.
- **Favourites:** add servers by their in-game join code and watch them live: map, mode, players, full or empty, password lock.
- **Regions:** players online in each region, a 24-hour trend, and your ping estimate to each one.
- **Details:** live info, join code with a copy button, player history (24 hours, 7 days, 30 days), uptime, and maps played.
- **Refreshes every 5 minutes** (or 10 or 15, set in Settings).

## Safe by design

- The app **never** opens, reads or changes WARDOGS game files, never reads game memory, and never runs inside the game.
- It never contacts Bulkhead's or Steam's servers.
- Server data comes from the free public API at [wardogserverlist.com](https://wardogserverlist.com/api), used within its rules: at most 20 requests a minute (the limit is 60), with caching, and it backs off if asked to slow down.
- **Ping is an estimate.** Server addresses aren't public, so the app times a normal HTTPS connection to a large data centre in each region.
- Favourites and settings are saved in `%APPDATA%\RedMarks Wardogs Server Browser\`.

Not affiliated with Bulkhead or wardogserverlist.com.

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
| `src/main/api.js` | Talks to wardogserverlist.com (rate limit and cache) |
| `src/main/ping.js` | Region ping estimate |
| `src/main/store.js` | Saves favourites and settings |
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
