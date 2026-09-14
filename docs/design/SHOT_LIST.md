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

1. **Films are few and deliberate.** Website: the home hero and the Trust
   board (Isaac, 2026-09-14). App: the cold-start intro. Everything else is
   a still or no imagery at all.
2. **A film plays while on screen, once.** It holds its last frame while the
   reader stays and plays again when they come back. No loops behind content.
3. **Nothing appears twice.** Not across pages, not between web and app.
4. **A board earns its photograph.** Boards whose content *is* the point —
   the steps, the cost calculator, FAQ — carry no imagery.
5. **Logged-in ops and employer screens use no photography** (funpay-ui):
   dark board, gradient and glass, except the `stage-*` surfaces below. The
   public Empleados and Empleadores pages open on a photograph (Isaac,
   2026-09-14).
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
| H1 | Home · hero (desktop stage) | Film, plays once, holds | `video/hero-dawn-16x9.mp4` (poster `images/brand/hero-dawn-16x9.jpg`) | live |
| H1 | Home · hero (phone background) | Same shot, 9:16 composition | `video/hero-dawn-9x16.mp4` (poster `images/brand/hero-dawn-9x16.jpg`) | live |
| H2 | Home · How it works | Paper board, the steps are the content | — | none |
| H3 | Home · Cost calculator | Sage board, nothing competes with the numbers | — | none |
| H4 | Home · Employers | Dark ops board over the stage surface | `images/brand/stage-employer.jpg` | live |
| H5 | Home · Trust | Film from its still (8 s), plays on screen | `video/board-trust-walk.mp4` (poster `images/brand/moment-school-walk.jpg`) — mother and son walk to school, seen from behind (still run 34860578121, film run 34862030441; the shadow on the wall is hers) | live |
| H6 | Home · FAQ | Paper | — | none |
| H7 | Home · Closing | Sage | — | none |
| E0 | Employees · hero | Film from its stills (8 s, ends on the still) | `video/employee-hero-16x9.mp4` (run 34864341488, camera push-in; the frozen take read as a still) and `employee-hero-9x16.mp4` (run 34860181217) — a waiter starting his shift | live |
| E1 | Employees · "Lo que no puede esperar" | Film from its still (8 s), plays on screen | `video/board-usecase-clinic.mp4` (poster `images/brand/moment-clinic.jpg`) — a father carrying his daughter down a long path to the clinic (still run 34865743300, film run 34866294117; take 1 rejected) | live |
| R0 | Employers · hero | Film from its stills (8 s, ends on the still) | `video/employer-hero-16x9.mp4` (run 34864341488, camera push-in; the frozen take read as a still) and `employer-hero-9x16.mp4` (run 34860181217) — payroll morning in a resort HR office | live |
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
`live-pharmacy.mp4`, `live-stall.mp4`, `board-trust-backpack.mp4` and
`moment-backpack.jpg` (replaced by the lunch moment), then the hero placeholders
`live-kitchen.mp4`, `live-doorway.mp4` and the unplaced stills
`moment-kitchen.jpg`, `home-doorway.jpg`, `home-stall.jpg`,
`figure-green.jpg`. From the app: `live-doorway.mp4`, `home-doorway.jpg`.

## Generation queue

Nothing here is generated until the placement mockup is approved on
alfa.suena.ch/funpay.

| ID | Output | Tool | Notes |
|---|---|---|---|
| G1 | `images/brand/hero-dawn-16x9.jpg`, `images/brand/hero-dawn-9x16.jpg` | OpenAI Images (`set=hero-stills`) | **Approved 2026-09-14** — desktop from run 34837062464, phone redone in run 34838950151 with the figure in the bottom fifth (the first put her behind the buttons). Graded, cropped to exact 16:9 / 9:16. |
| G2 | `video/hero-dawn-16x9.mp4`, `video/hero-dawn-9x16.mp4` | fal.ai Seedance pro image-to-video from the committed G1 stills, 10 s, camera fixed | **Live 2026-09-14** — generated in run 34848115253, graded to match the stills in run 34849041744 (frame-0 saturation within .02 of the still). |

**G1/G2 brief — "the shift ends."** A hotel staff member at the end of the
night shift steps out of the service entrance into first light, seen from
behind, and walks toward the open morning — palms, pale sky, the resort
behind her. The film arrives at stillness: she has stopped, the sky holds.
Grade, casting and negatives come from `MX`, `GRADE` and `NEG` in
`mobile/scripts/generate-brand-assets.mjs`; camera locked, motion small.
