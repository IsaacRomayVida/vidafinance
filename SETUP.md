# Vida Finance — Setup & Configuration Guide

This document contains everything needed to set up the development environment from any machine.

---

## 1. Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | `brew install node` or [nodejs.org](https://nodejs.org) |
| Firebase CLI | latest | `npm install -g firebase-tools` |
| GitHub CLI | latest | `brew install gh` |
| Git | 2.x+ | Pre-installed on macOS |

---

## 2. Repository

```bash
git clone https://github.com/IsaacRomayVida/vidafinance.git
cd vidafinance
git checkout develop
```

---

## 3. Firebase Project

| Property | Value |
|----------|-------|
| **Project ID** | `vida-finance` |
| **Hosting URL** | https://vida-finance.web.app |
| **Console** | https://console.firebase.google.com/project/vida-finance/overview |

### Services enabled

- **Firebase Hosting** — serves the SPA frontend
- **Firebase Authentication** — Email/Password provider (must be enabled in Console)
- **Cloud Firestore** — database for employers, employees, loans, contact submissions
- **Cloud Functions (Gen2)** — backend API (`functions/index.js`, Node.js 20 runtime)

### Firebase CLI login

```bash
firebase login
```

If token is expired or switching machines:

```bash
firebase login --reauth
```

### Link project

```bash
firebase use vida-finance
```

Or manually set in `.firebaserc`:

```json
{
  "projects": {
    "default": "vida-finance"
  }
}
```

---

## 4. Project Structure

```
vidafinance/
├── public/                  # Frontend (deployed to Firebase Hosting)
│   ├── index.html           # SPA entry point
│   ├── css/style.css        # All styles
│   └── js/app.js            # All JS (routing, i18n, components, Firebase SDK)
├── functions/               # Cloud Functions (Gen2)
│   ├── index.js             # API endpoints
│   ├── package.json         # Dependencies (firebase-admin, firebase-functions)
│   └── package-lock.json
├── images/                  # SVG logo assets
│   ├── Logo Web 2.0.svg     # Full VIDA wordmark (source of truth)
│   ├── logov.svg             # V symbol with gradients
│   └── ida.svg               # IDA letterforms
├── firebase.json            # Hosting, Firestore, Functions, Emulators config
├── firestore.rules          # Security rules for Firestore
├── firestore.indexes.json   # Firestore composite indexes
├── .gitignore
├── vida-responsive.html     # Original design reference file
└── SETUP.md                 # This file
```

---

## 5. Local Development

### Quick start (static frontend only)

```bash
cd public
python3 -m http.server 5500
```

Then open http://localhost:5500. Note: SPA routes like `/employers` will 404 on the Python server — only the root `/` works. Use Firebase emulators for full SPA routing.

### Firebase Emulators (full stack)

```bash
cd functions && npm install && cd ..
firebase emulators:start
```

| Service | Port |
|---------|------|
| Hosting | 5000 |
| Functions | 5001 |
| Firestore | 8080 |
| Auth | 9099 |
| Emulator UI | 4000 |

---

## 6. Deployment

### Deploy everything

```bash
firebase deploy
```

### Deploy only hosting (frontend)

```bash
firebase deploy --only hosting
```

### Deploy only functions

```bash
cd functions && npm install && cd ..
firebase deploy --only functions
```

### Deploy only Firestore rules

```bash
firebase deploy --only firestore:rules
```

---

## 7. Firebase Console Setup (first-time only)

If setting up a new Firebase project from scratch:

1. Go to https://console.firebase.google.com
2. Create project with ID `vida-finance`
3. **Authentication** → Sign-in method → Enable **Email/Password**
4. **Firestore Database** → Create database → Start in production mode
5. **Hosting** → Get started (follow prompts)
6. **IAM** (GCP Console) → Ensure the default service account has:
   - Cloud Functions Developer
   - Storage Object Viewer
   - Firebase Admin SDK Administrator Service Agent

---

## 8. Git Workflow

```bash
# Always work on develop
git checkout develop

# After changes
git add -A
git commit -m "description of changes"
git push origin develop
```

### Git config for this project

```bash
git config user.name "Isaac Moreno"
git config user.email "isaac@vidateam.mx"
```

### GitHub CLI auth

```bash
gh auth login
# Select: GitHub.com → HTTPS → Login with browser
```

---

## 9. Key Technical Details

### Frontend Architecture

- **Single Page Application** — client-side routing via `history.pushState`
- **Bilingual** — Spanish (default) + English, toggled via `toggleLang()`
- **No frameworks** — vanilla HTML/CSS/JS
- **Firebase SDK** loaded via CDN in `index.html`

### Design System

- **Fonts**: DM Serif Display (headlines), DM Sans (body)
- **Brand color**: `#194445` (dark teal)
- **Gold accent**: `#a28657`
- **Philosophy**: Editorial, no-card design, light canvas with dark bookends
- **Logo**: Animated SVG wordmark — V appears first, then IDA slides in

### Product Rules

| Parameter | Value |
|-----------|-------|
| Loan term | 30 days fixed |
| Interest rate | 30% monthly |
| Max credit | 30% of monthly salary |
| Max amount | $5,000 MXN |
| Disbursement | 24 hours |

### SPA Routes

| Route | Page |
|-------|------|
| `/` | Homepage |
| `/employers` | Employer landing page |
| `/employees` | Employee landing page |
| `/login` | Login |
| `/onboarding` | Onboarding wizard |
| `/employer/dashboard` | Employer dashboard |
| `/employee/dashboard` | Employee dashboard |
| `/about` | About |
| `/security` | Security |
| `/privacy` | Privacy Policy |
| `/terms` | Terms of Service |
| `/partners` | Partners |
| `/investors` | Investors |
| `/contact` | Contact |
| `/press` | Press |

---

## 10. Troubleshooting

| Issue | Fix |
|-------|-----|
| Site not updating after deploy | Hard refresh (`Cmd+Shift+R`). Cache is set to `no-cache` but browsers may still cache. |
| `auth/configuration-not-found` | Enable Email/Password in Firebase Console → Authentication → Sign-in method |
| Functions deploy fails (permission) | Check GCP IAM roles for the default service account |
| `firebase login` fails in CI/IDE | Run `firebase login --reauth` in a terminal with browser access |
| SPA routes 404 on local server | Use Firebase emulators instead of `python3 -m http.server` |
