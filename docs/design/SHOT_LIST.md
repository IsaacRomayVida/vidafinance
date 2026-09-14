# FunPay shot list — one story, told once

Every photograph and film in the product has exactly one home. Before
adding imagery anywhere, find its row here; if it has none, it does not ship.

## Why this exists

Until 2026-09-14 the whole product ran on five 3–5 s clips. The home page
played pharmacy, backpack and stall twice (hero reel, then again as section
backgrounds), the Employee and Employer pages reused kitchen and doorway, and
the app looped doorway behind Login and Home. Every section was a moving
wallpaper under a scrim: nothing was special, and motion fought the type.

## Rules

1. **One film per surface.** Website: the home hero. App: the cold-start
   intro. Everything else is a still or no imagery at all.
2. **A film plays once and holds its last frame.** No loops behind content.
3. **Nothing appears twice.** Not across pages, not between web and app.
4. **A board earns its photograph.** Boards whose content *is* the point —
   the steps, the cost calculator, FAQ — carry no imagery.
5. **Ops and employer sides use no photography** (funpay-ui): dark board,
   gradient and glass. The one exception is the `stage-*` surfaces below.
6. **Photographic only, and no kites.** Not in a film, not in a still,
   not as a cutout or motif in the UI (Isaac, 2026-09-08 and 2026-09-14).
7. **Composed, not cropped.** Desktop 16:9 and phone 9:16 of the same moment
   are generated as two compositions of one shot.

## Placements

Status: **live** = final asset in place · **placeholder** = existing asset
holding the slot until the new one is generated · **none** = no imagery by
design.

### Website (public-v2)

| ID | Where | Treatment | Asset | Status |
|---|---|---|---|---|
| H1 | Home · hero (desktop stage) | Film, plays once, holds | `video/live-kitchen.mp4` (poster `moment-kitchen.jpg`) | placeholder → G2 |
| H1 | Home · hero (phone background) | Same shot, 9:16 composition | `video/live-doorway.mp4` (poster `home-doorway.jpg`) | placeholder → G2 |
| H2 | Home · How it works | Paper board, the steps are the content | — | none |
| H3 | Home · Cost calculator | Sage board, nothing competes with the numbers | — | none |
| H4 | Home · Employers | Dark ops board over the stage surface | `images/brand/stage-employer.jpg` | live |
| H5 | Home · Trust | Still | `images/brand/moment-backpack.jpg` | live |
| H6 | Home · FAQ | Paper | — | none |
| H7 | Home · Closing | Sage | — | none |
| E1 | Employees · Use cases | Still | `images/brand/moment-pharmacy.jpg` | live |
| R1 | Employers · Closing statement | Dark ops board | — | none |
| O1 | Employer dashboard + ops console · stage panel | Stage surface | `images/brand/stage-ops.jpg` | live |

### App (mobile)

| ID | Where | Treatment | Asset | Status |
|---|---|---|---|---|
| A1 | Brand intro (cold start) | Film, once per launch, then the mark | `assets/intros/live-stall.mp4` (poster `home-stall.jpg`) | live |
| A2 | Home | Leaf painted field, no photo | — | none |
| A3 | Login (desktop hero) | Leaf painted field, no photo | — | none |

### Retired on 2026-09-14

Removed from the website bundle (7.5 MB → 0.6 MB of video): `hero.mp4`,
`hero-doorway.mp4`, `hero-market.mp4`, `hero-poster.jpg`, `showcase.mp4`,
`ambient-loop.mp4`, `ambient-loop-wide.mp4`, `live-backpack.mp4`,
`live-pharmacy.mp4`, `live-stall.mp4`. From the app: `live-doorway.mp4`,
`home-doorway.jpg`.

## Generation queue

Nothing here is generated until the placement mockup is approved on
alfa.suena.ch/funpay.

| ID | Output | Tool | Notes |
|---|---|---|---|
| G1 | `hero-dawn-16x9.png`, `hero-dawn-9x16.png` | OpenAI Images (`set=imagery`) | One moment, two compositions. Clear sky in the upper third (desktop: right half) for the headline. |
| G2 | `hero-dawn-16x9.mp4`, `hero-dawn-9x16.mp4` | fal.ai Seedance **pro**, image-to-video from G1, `duration: 10` | Replaces both H1 placeholders. Seedance returns 5 or 10 s per clip. |

**G1/G2 brief — "the shift ends."** A hotel staff member at the end of the
night shift steps out of the service entrance into first light, seen from
behind, and walks toward the open morning — palms, pale sky, the resort
behind her. The film arrives at stillness: she has stopped, the sky holds.
Grade, casting and negatives come from `MX`, `GRADE` and `NEG` in
`mobile/scripts/generate-brand-assets.mjs`; camera locked, motion small.
