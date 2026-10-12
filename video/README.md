# TackPath product video

`out/tackpath-demo.mp4`: about 3 minutes, 1920x1080, H.264, 30 fps, no sound.
It is built from the real app pages, with no screen recording and no editing by hand.

Re-render it with one command, from the repo root:

```
bash video/render.sh
```

This takes about 6 minutes. Needs: node 18+, Chromium or Chrome (found the same way as the
tests, see `tests/browser.js`), and the `tackpath-driver` repo cloned next to `tackpath-app`
(or set `DRIVER_PAGE=/path/to/www/index.html`). ffmpeg is used from `PATH`, from `$FFMPEG`, or
from `ffmpeg-static`, which `render.sh` installs from npm if there is no ffmpeg.

This folder is not part of the website. Keep it off the branch GitHub Pages serves (see
"Not for the website" below).

## How it is made

1. **capture.mjs** opens the real pages in headless Chromium:
   - `dispatcher.html` at 1280x720 in its light theme;
   - `stow.html` (PathIQ) at the TC56 screen size, 360x640;
   - the driver app page (`tackpath-driver/www/index.html`) at phone size, 412x915.

   It then works through the flow with real clicks, taps, a file chooser, a pointer-drawn
   signature, and scans: TC56 scans go in through PathIQ's scanner plugin, and phone scans
   go to the app's own `processScan`.
   - Every request is answered locally. `lib/backend.mjs` runs the real security migrations
     in PGlite, reusing the stand-ins from `tests/security/fixture.mjs`.
   - `lib/apps.mjs` answers the gateway calls and the map, geocode and proof-of-delivery
     calls.
   - Nothing goes to the internet. There are no real keys and no production data.
   - Every screenshot is checked for text that must never appear (agent names, the real
     company code, Supabase, keys, long dashes). The capture stops if it finds any.
2. **stage.html** lays out one 1920x1080 frame per shot: device frames, the process strip,
   the caption, tap rings, scan chips and enlarged zoom panels.
3. **compose.mjs** crossfades the frames on the storyboard timeline with ffmpeg and writes
   `out/scenes.txt`.

## Scenes

| # | Start | Caption |
|---|-------|---------|
| 1 | 0:00 | Dispatch, simplified (title card) |
| 2 | 0:10 | Load your manifest in seconds |
| 3 | 0:30 | Assign a driver. They see it instantly |
| 4 | 0:50 | Warehouse scans every package |
| 5 | 1:25 | Stage the route. The driver is alerted |
| 6 | 1:40 | Driver scans the bin and loads the route |
| 7 | 2:05 | Turn by turn, every stop in order |
| 8 | 2:30 | Proof of delivery, captured at the door |
| 9 | 2:50 | You see it all, live (then the end card with tackpath.com) |

## What is staged for the recording

The app files are not changed. These differences exist only in the recording session
(`lib/session.mjs`):

- **Demo data.** The company is "Quick Haul", with made-up customers, streets and
  QH-20xx package numbers.
- **Map tiles.** The map tiles are drawn locally (`lib/tiles.mjs`) because there is no
  internet here. They are an illustrative street grid, not a real map. The OpenStreetMap
  credit is hidden because those tiles are not OSM.
- **Phone camera.** The camera shows a still image of a made-up package label (Chromium's
  fake camera). The scanned value is passed to the app as the camera decoder would pass it.
- **Google Maps.** Turn-by-turn navigation is not shown, because it happens in the Google
  Maps app. The video shows the "Navigate with Google Maps" step and the arrival prompt.
- **Hidden elements:**
  - the voice-assistant buttons;
  - the Google map embed in the dispatcher's route drawer (it needs the internet);
  - SmartSort's internal self-check list.
- **Dashes.** Long dashes in the pages' own text are shown as plain hyphens.
- **Times.** Times are shown in Atlanta time (America/New_York). The picked-up and
  delivered times are the real ones the server recorded during the run.
- **Off-camera stops.** Stops 2 to 5 are delivered off camera with the same app steps, so
  the dispatcher can show the route as delivered.

## Not for the website

GitHub Pages publishes this whole repository at tackpath.com. Merging `video/` into the
published branch would put these files and the mp4 on the website. Keep it on its own
branch, or exclude `video/` from the site before merging.
