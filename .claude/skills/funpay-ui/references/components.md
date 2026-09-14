# Components

All values reference `tokens.css`. `assets/reference.html` has every one of these running — search it by class name.

## Shared

**Board** — `.board{border-radius:var(--r-board);overflow:hidden;margin-bottom:10px;background:var(--board-grad);position:relative}` on a `--void` page with 10px body padding. Board titles are Doto, 15px, `--mute`, centred, 34px top padding.

**Label (Doto)** — `.dot{font-family:var(--font-dot);font-weight:600;letter-spacing:var(--dot-track);text-transform:uppercase}`. Screen names, brand mark, payroll date. Nothing else.

**Pill chip** — `.pill{display:inline-flex;align-items:center;gap:10px;padding:10px 18px;border-radius:var(--r-pill);font-size:15px;color:rgba(255,255,255,.75);background:var(--glass-light);backdrop-filter:var(--blur-sm)}` `.pill.on{background:#fff;color:var(--ink);padding-left:10px}` with `.cnt` a 24px circle in `--mark`/`--mark-ink`. The active chip going solid white is the only contrast jump on the screen.

**Avatar** — 34px circle, `--grad-ident`, initials 12px/600. Never stock faces.

---

## Borrower side

**Screen shell**
```css
.screen{position:relative;min-height:680px;aspect-ratio:9/17;border-radius:var(--r-board);overflow:hidden;
        padding:32px 28px;display:flex;flex-direction:column}
.screen.paper{background:var(--cream)}
.screen.leaf{ /* painted botanical — see imagery.md when a photo exists */
  color:#f4f7ee;
  background:
    radial-gradient(75% 55% at 62% 38%, rgba(110,138,60,.85) 0%, transparent 70%),
    radial-gradient(40% 75% at 50% 50%, #47611f 0%, transparent 80%),
    radial-gradient(60% 40% at 30% 85%, #dfe8b4 0%, transparent 70%),
    radial-gradient(70% 50% at 80% 8%, #ecf0d6 0%, transparent 75%),
    linear-gradient(180deg,#d6dfb2 0%,#a6b46a 45%,#3c5420 100%)}
.screen.leaf::before{content:'';position:absolute;inset:0;pointer-events:none;
  background:repeating-linear-gradient(112deg,rgba(255,255,255,.07) 0 1px,transparent 1px 9px);mix-blend-mode:soft-light}
```
Screen header: `.sc-head{display:flex;justify-content:space-between;align-items:center}` with a Doto name left and avatar right.

**Credit numeral**
```css
.h-bal-l{margin-top:auto;font-size:15px;font-weight:300;opacity:.85}
.h-bal{font-size:50px;letter-spacing:-.03em;line-height:1;font-weight:400}
.h-bal small{font-size:20px;font-weight:300;opacity:.7;margin-left:6px}   /* MXN */
```
Text over the leaf gets `text-shadow:0 1px 18px rgba(20,40,10,.4)`.

**Active loan chip** (frosted)
```css
.trip{margin-top:26px;padding:16px 16px 14px;border-radius:var(--r-card);
      background:var(--glass-light);backdrop-filter:var(--blur-md);
      border:1px solid rgba(255,255,255,.22);box-shadow:var(--glass-hl)}
.trip .t{display:flex;justify-content:space-between;font-size:15px}
.bar{height:6px;border-radius:3px;background:rgba(255,255,255,.22);margin:12px 0 8px;overflow:hidden}
.bar i{display:block;height:100%;border-radius:3px;background:#fff}   /* width = repaid % */
.trip .m{font-size:12.5px;opacity:.8;display:flex;justify-content:space-between}
```
Copy: `Loan · 8,000 MXN` / `42%` / `3,360 of 8,000 repaid` / `7 quincenas left`.

**Companion card** (acetate)
```css
.companion{margin-top:18px;padding:12px;border-radius:var(--r-card);background:var(--grad-assist);color:var(--ink);box-shadow:var(--shadow-float)}
.companion .top .dot{font-size:15px;color:rgba(20,40,20,.55)}
.exp{width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.55);display:grid;place-items:center}
.qs{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 8px}
.q{font-size:11.5px;padding:6px 10px;border-radius:20px;background:rgba(255,255,255,.64);color:var(--ink-soft)}
.q::after{content:'+';margin-left:6px;opacity:.55}
.ask{display:flex;align-items:center;gap:10px;background:var(--ink);color:var(--cream);padding:5px 14px 5px 5px;border-radius:30px;font-size:12.5px}
.ask .sp{width:28px;height:28px;border-radius:50%;background:var(--cream);color:var(--ink)}
```
Suggestions are facts and offers, never questions back to the user: `Next deduction: 720 on 15 Sep`, `Pay 1,500 early, save 210`, `Why is my limit 12,000`.

**Request amount + caret**
```css
.amount{margin-top:auto;font-size:64px;letter-spacing:-.04em;line-height:1;display:flex;align-items:baseline;gap:4px}
.amount small{font-size:22px;font-weight:300;color:var(--mute)}
.amount i{width:2px;height:54px;background:var(--ink);align-self:center;margin-left:4px;animation:blink var(--caret-blink) steps(2,start) infinite}
@keyframes blink{to{visibility:hidden}}
```
Above it: `.pay-to` (15px `--mute`) "Repaid from payroll" and `.pay-who` (22px) "12 quincenas · 720 each" with the term count in the avatar circle.

**Tagged memo**
```css
.memo mark{background:var(--mark);color:var(--ink);padding:2px 7px;border-radius:6px;
           -webkit-box-decoration-break:clone;box-decoration-break:clone}
```
`School supplies for Diego — <b>tagged education</b>`. The bold suffix is the companion's work.

**Disclosure line** — same class as `.pay-to`, 13px, directly under the memo: `Total cost in plain sight: 8,640 repaid · CAT 38.5% informational`. Never hidden, never smaller than 13px, never behind a tap. See `copy-and-compliance.md` for exact formatting.

**Pill keypad**
```css
.pad{margin-top:auto;display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.pad span{height:52px;border-radius:var(--r-pill);background:#e9ebe1;display:grid;place-items:center;font-size:22px}
.pad span.go{background:var(--cta);color:var(--ink);font-weight:600;font-size:16px;grid-column:span 3;height:54px;margin-top:4px}
```
The `.go` pill states the amount: `Request 8,000`.

**Repayment steps**
```css
.step{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:var(--r-pill);background:#e9ebe1;font-size:14px}
.step .d{width:26px;height:26px;border-radius:50%;background:var(--mark);color:var(--mark-ink);display:grid;place-items:center;font-size:11px;font-weight:600}
.step.done .d{background:var(--ink);color:var(--cream)}
.step.done .v{color:var(--mute);text-decoration:line-through}
.step.now{background:#fff;box-shadow:var(--shadow-float)}
```
Each step: date · `Quincena n` sublabel · amount. Show four, then a plain line `and 8 more · 5,760 remaining`.

**Credit-line pass** (light glass)
```css
.vcard{aspect-ratio:1.586;border-radius:24px;padding:22px 24px;display:flex;flex-direction:column;color:var(--ink);
  background:var(--glass-pass);backdrop-filter:var(--blur-lg);border:1px solid rgba(255,255,255,.55);
  box-shadow:var(--shadow-glass),inset 0 1px 0 rgba(255,255,255,.85),inset 0 -22px 34px -26px rgba(255,255,255,.6);transform:rotate(-4deg)}
.vcard::before{content:'';position:absolute;inset:0;border-radius:inherit;pointer-events:none;mix-blend-mode:screen;
  background:linear-gradient(133deg,rgba(255,255,255,.6) 0%,rgba(255,255,255,.05) 28%,transparent 55%,rgba(255,255,255,.22) 100%)}
.vcard .num{margin-top:auto;font-size:19px;letter-spacing:.16em}   /* LIMIT 12,000 MXN */
```
Fields: HOLDER · EMPLOYER · SINCE. Never a PAN-style number; it is a credit line, not a card.

**Dark sheet** — `.sheet{background:var(--glass-dark);backdrop-filter:blur(26px) saturate(150%);border:1px solid rgba(255,255,255,.1)}` with one title, one sub, one toggle.

**Statement board** — h1 `clamp(38px,7vw,64px)`/400/−.02em, max-width 12ch, quiet spans at 300 in `--type-quiet`, inline `.ava` at `.95em`. Floats: capture bar (dark pill, four icon circles, active one cream) at −3°, identity card (`--grad-ident`, rows: employee · payroll · lender) at +5°.

---

## Ops side

**Board and panels**
```css
.ops{background:var(--ops-grad);color:var(--paper-dark);min-height:760px;display:grid;grid-template-columns:1.25fr 1fr;gap:10px;padding:10px}
.ops .panel{position:relative;border-radius:var(--r-panel);overflow:hidden;min-height:520px;padding:26px 24px}
.ops .panel.stage{background:var(--stage-grad)}
.ops .panel.data{background:rgba(0,11,26,.55);border:1px solid rgba(255,255,255,.06)}
@media (max-width:820px){.ops{grid-template-columns:1fr}}
```

**Tag pill (dark glass)** — `.tag{padding:9px 16px;border-radius:var(--r-pill);font-size:13px;background:var(--glass-tag);backdrop-filter:var(--blur-sm);border:1px solid rgba(255,255,255,.08)}` with an optional 7px `--harmony` dot for the live one.

**Brand mark** — 22px rounded square in `--harmony` with a 700-weight initial in `--charcoal`, then the name at 17px/500.

**Spatial stack** — the signature.
```css
.stack{position:absolute;left:0;right:0;bottom:-30px;height:360px;perspective:1100px;perspective-origin:60% 30%;pointer-events:none}
.folder{position:absolute;left:50%;bottom:70px;width:200px;height:140px;margin-left:-100px;border-radius:16px;
  background:var(--glass-folder);backdrop-filter:blur(10px) saturate(140%);border:1px solid var(--glass-edge);
  box-shadow:var(--shadow-stack),inset 0 1px 0 rgba(255,255,255,.45);transform-style:preserve-3d;padding:34px 14px 12px;
  transform:rotateY(-42deg) rotateX(10deg) translateX(calc(var(--i)*118px)) translateZ(calc(var(--i)*-46px))}
.folder::before{content:'';position:absolute;left:14px;top:-12px;width:60px;height:14px;border-radius:7px 7px 0 0;background:inherit;border:1px solid var(--glass-edge);border-bottom:0}
.folder .doc{position:absolute;left:18px;right:18px;top:-24px;height:70px;border-radius:8px;background:rgba(255,255,255,.82);box-shadow:0 6px 14px rgba(0,0,0,.25);transform:rotate(-2deg)}
.folder .doc i{display:block;height:3px;border-radius:2px;background:rgba(0,11,26,.18);margin:9px 10px 0}
.folder .lbl{position:absolute;left:16px;bottom:12px;font-size:14px;transform:rotate(-8deg);transform-origin:left}
.folder .n{position:absolute;right:14px;top:36px;font-size:12px;opacity:.75}
.folder.lit{background:var(--glass-lit);border-color:rgba(160,255,190,.7);box-shadow:0 30px 70px -20px rgba(104,231,142,.5),inset 0 1px 0 rgba(255,255,255,.7)}
.folder.lit .lbl,.folder.lit .n{color:#05140a}
```
Markup: `<div class="folder" style="--i:-2"><div class="doc"><i></i><i></i><i></i></div><span class="n">6</span><span class="lbl">Xcaret Arte</span></div>`. Use `--i` from −3 to +2; `--i:0` is the lit one. Labels are employers, the current quincena, `AML / PLD`, `SAT`.

**Floating progress card**
```css
.prog{position:absolute;right:26px;bottom:250px;width:210px;padding:18px 18px 16px;border-radius:22px;
  background:var(--glass-prog);backdrop-filter:blur(22px) saturate(160%);border:1px solid rgba(255,255,255,.7);
  box-shadow:0 34px 70px -24px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.9);color:var(--charcoal);transform:rotate(-5deg)}
.prog::after{content:'';position:absolute;right:-30px;top:-20px;width:150px;height:150px;border-radius:50%;pointer-events:none;
  background:radial-gradient(circle,rgba(104,231,142,.75) 0%,rgba(104,231,142,0) 65%);filter:blur(6px);mix-blend-mode:screen}
.prog .v{font-size:40px;letter-spacing:-.03em;font-weight:300;margin-top:14px;line-height:1}
.prog .dotg{position:absolute;right:16px;bottom:18px;width:12px;height:12px;border-radius:50%;background:var(--harmony);box-shadow:0 0 0 6px rgba(104,231,142,.25)}
```
The `::after` glow is what ties the card to the lit folder beneath it. Keep it.

**KPI tiles** — `.kpi{padding:14px 12px;border-radius:16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06)}` — 11px uppercase label, 22px/400 value, unit or delta as a 12px `--harmony` suffix. Three across: OUTSTANDING · ACTIVE LOANS · PAR 30.

**Batch row** — `.batch{display:flex;align-items:center;gap:12px;padding:12px;border-radius:14px;background:rgba(255,255,255,.04);font-size:14px}` with a 26×20 folder glyph (`.fl`, green when the payroll file is received), employer name + sublabel (`412 employees · file received` / `file pending` / `3 leavers flagged`), and a tabular percentage, green if complete.

**Due item** — `.due{padding:14px;border-radius:16px;border:1px dashed rgba(104,231,142,.4)}` with a green dot: `CONDUSEF quarterly report — Due 10 Oct · 6 of 8 sections ready`.

**Action** — one white pill with a green dot: `Run 30 Sep batch`. Never two actions in the data panel.
