# VIDA Finance

**Plataforma de préstamos respaldados por nómina para trabajadores mexicanos.**

Payroll-backed micro-lending platform for Mexican employees — instant credit decisions, SPEI disbursement, and automated payroll deductions.

---

## Table of Contents

- [Overview / Descripción General](#overview--descripción-general)
- [Architecture / Arquitectura](#architecture--arquitectura)
- [Tech Stack](#tech-stack)
- [Repository Structure / Estructura del Repositorio](#repository-structure--estructura-del-repositorio)
- [Local Development / Desarrollo Local](#local-development--desarrollo-local)
- [Environment Variables / Variables de Entorno](#environment-variables--variables-de-entorno)
- [Deployment / Despliegue](#deployment--despliegue)
- [Additional Documentation](#additional-documentation)

---

## Overview / Descripción General

VIDA Finance es una plataforma fintech que ofrece microcréditos respaldados por nómina a empleados en México. El sistema conecta empleadores y empleados: los empleadores registran a su empresa y nómina, y los empleados solicitan préstamos que se descuentan automáticamente de su salario.

**Parámetros del producto:**

| Parámetro | Valor |
|-----------|-------|
| Plazo del préstamo | 30 días fijos |
| Tasa de interés | 30% mensual |
| Crédito máximo | 30% del salario mensual |
| Monto máximo | $5,000 MXN |
| Desembolso | 24 horas vía SPEI |

VIDA Finance is a fintech platform offering payroll-backed micro-loans to employees in Mexico. The system connects employers and employees: employers register their company and payroll, and employees request loans that are automatically deducted from their salary. The platform features KYC/AML compliance, ML-driven underwriting, and electronic contract signing (NOM-151).

---

## Architecture / Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│                      Firebase Platform                       │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌────────────┐ │
│  │ Hosting  │  │Firestore │  │   Auth    │  │ Cloud Func │ │
│  │  (SPA)   │  │   (DB)   │  │(Email/Pw) │  │  (Gen2)    │ │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘  └─────┬──────┘ │
└───────┼──────────────┼──────────────┼──────────────┼────────┘
        │              │              │              │
        │              │         ┌────▼────┐         │
        │              │         │  App    │         │
        │              │         │ Check   │         │
        │              │         └─────────┘         │
        │              │                             │
┌───────▼──────────────▼─────────────────────────────▼────────┐
│                    Railway Microservices                      │
│  ┌────────────┐  ┌─────────────┐  ┌──────────────────────┐  │
│  │  payment   │  │notification │  │   pdf-generator      │  │
│  │  server    │  │  service    │  │   (Puppeteer)        │  │
│  │  :3001     │  │  :3002      │  │   :3003              │  │
│  └─────┬──────┘  └──────┬──────┘  └──────────────────────┘  │
│        │                │                                    │
│  ┌─────▼──────┐  ┌──────▼──────┐  ┌──────────────────────┐  │
│  │softcredito │  │  ml-service │  │   underwriting       │  │
│  │  adapter   │  │  (Python)   │  │   service            │  │
│  │  :3004     │  │  :8000      │  │   :3003              │  │
│  └────────────┘  └─────────────┘  └──────────────────────┘  │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Redis 7 — BullMQ queues + rate limiting + ML cache     │ │
│  │  :6379                                                  │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**Firebase** maneja el frontend (SPA), base de datos (Firestore), autenticación, y Cloud Functions como API gateway. **Railway** ejecuta los microservicios backend que procesan pagos, notificaciones, generación de PDFs, integración con SoftCrédito, underwriting con ML, y verificación KYC/AML. **Redis** conecta los servicios mediante colas BullMQ.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML/CSS/JS SPA, Firebase SDK (CDN) |
| Hosting | Firebase Hosting |
| Auth | Firebase Authentication (Email/Password) + App Check (reCAPTCHA Enterprise) |
| Database | Cloud Firestore |
| API Gateway | Cloud Functions Gen2 (Node.js 20) |
| Microservices | Node.js (5 services) + Python (ml-service) |
| Job Queues | BullMQ on Redis 7 |
| Payments | Conekta (webhooks), SPEI via SoftCrédito |
| Notifications | Twilio (WhatsApp), SendGrid (email) |
| PDF / Contracts | Puppeteer, Mifiel (NOM-151 e-signing) |
| ML / AI | XGBoost, LightGBM, Claude LLM judge |
| KYC / AML | Incode, Truora, Verifik, Belvo, RiskSeal, Sardine |
| OCR | Google Document AI (payroll slip parsing) |
| Infrastructure | Firebase (frontend), Railway (backend), Redis |
| CI/CD | GitHub Actions |

---

## Repository Structure / Estructura del Repositorio

```
vidafinance/
├── public/                          # Frontend SPA (Firebase Hosting)
│   ├── index.html                   # Punto de entrada de la aplicación
│   ├── css/style.css                # Estilos
│   └── js/app.js                    # Routing, i18n, componentes, Firebase SDK
├── functions/                       # Cloud Functions Gen2
│   ├── index.js                     # Endpoints de la API
│   └── package.json
├── services/                        # Microservicios Railway
│   ├── payment-server/              # Conekta webhooks + SPEI (BullMQ)
│   ├── notification-service/        # WhatsApp + email (BullMQ)
│   ├── pdf-generator/               # Contratos + recibos (Puppeteer)
│   ├── softcredito-adapter/         # SoftCrédito SPEI + descuento nómina
│   ├── underwriting-service/        # Verificación KYC/AML + scoring
│   ├── ml-service/                  # XGBoost/LightGBM + Claude LLM judge
│   └── shared/                      # Código compartido entre servicios
├── images/                          # Assets SVG del logo
├── scripts/                         # Scripts de utilidad
├── .github/workflows/               # CI/CD pipelines
├── firebase.json                    # Configuración Firebase
├── firestore.rules                  # Reglas de seguridad Firestore
├── firestore.indexes.json           # Índices compuestos Firestore
├── storage.rules                    # Reglas de Cloud Storage
├── SERVICES.md                      # Documentación de microservicios Railway
├── SETUP.md                         # Guía completa de configuración
└── README.md                        # Este archivo
```

---

## Local Development / Desarrollo Local

### Requisitos Previos

| Herramienta | Versión | Instalación |
|-------------|---------|-------------|
| Node.js | 20+ | `brew install node` o [nodejs.org](https://nodejs.org) |
| Python | 3.10+ | Requerido para ml-service |
| Firebase CLI | latest | `npm install -g firebase-tools` |
| GitHub CLI | latest | `brew install gh` |
| Docker | latest | Para Redis local (opcional) |

### Configuración Inicial

```bash
# 1. Clonar el repositorio
git clone https://github.com/IsaacRomayVida/vidafinance.git
cd vidafinance

# 2. Autenticarse en Firebase
firebase login
firebase use vida-finance

# 3. Instalar dependencias de Cloud Functions
cd functions && npm install && cd ..

# 4. Instalar dependencias de cada microservicio
cd services/payment-server && npm install && cd ../..
cd services/notification-service && npm install && cd ../..
cd services/pdf-generator && npm install && cd ../..
cd services/softcredito-adapter && npm install && cd ../..
cd services/underwriting-service && npm install && cd ../..

# 5. Copiar archivos de entorno
for svc in ml-service notification-service payment-server pdf-generator softcredito-adapter underwriting-service; do
  cp services/$svc/.env.example services/$svc/.env
done
```

### Iniciar Firebase Emulators (frontend + API)

```bash
firebase emulators:start
```

| Servicio | Puerto |
|----------|--------|
| Hosting | 5000 |
| Functions | 5001 |
| Firestore | 8080 |
| Auth | 9099 |
| Emulator UI | 4000 |

Abrir http://localhost:5000 para el frontend y http://localhost:4000 para la UI de emuladores.

### Iniciar un Microservicio (desarrollo)

```bash
cd services/payment-server
cp .env.example .env
# Editar .env con credenciales locales
npm run dev   # o npm start
```

### Redis Local

```bash
# Con Docker
docker run -d --name vida-redis -p 6379:6379 redis:7-alpine

# O con Homebrew
brew install redis && brew services start redis
```

---

## Environment Variables / Variables de Entorno

Cada microservicio tiene un archivo `.env.example` con todas las variables necesarias. A continuación se listan las variables por servicio.

### Variables Compartidas

| Variable | Descripción |
|----------|-------------|
| `FIREBASE_SERVICE_ACCOUNT` | JSON de credenciales del service account de Firebase |
| `INTERNAL_SECRET` | Token compartido para autenticación entre servicios |
| `REDIS_URL` | URL de conexión a Redis (ej: `redis://localhost:6379`) |

### payment-server (`:3001`)

| Variable | Descripción |
|----------|-------------|
| `PORT` | `3001` |
| `CONEKTA_WEBHOOK_SECRET` | Secret para validar webhooks de Conekta |
| `SOFTCREDITO_ADAPTER_URL` | URL interna del adaptador SoftCrédito |

### notification-service (`:3002`)

| Variable | Descripción |
|----------|-------------|
| `PORT` | `3002` |
| `TWILIO_ACCOUNT_SID` | SID de cuenta Twilio |
| `TWILIO_AUTH_TOKEN` | Token de autenticación Twilio |
| `TWILIO_WHATSAPP_FROM` | Número de WhatsApp origen |
| `SENDGRID_API_KEY` | API key de SendGrid para email |

### pdf-generator (`:3003`)

| Variable | Descripción |
|----------|-------------|
| `PORT` | `3003` |
| `FIREBASE_STORAGE_BUCKET` | Bucket de Storage (`vida-finance.appspot.com`) |
| `SOFOM_RFC` | RFC de la SOFOM para contratos |
| `SOFOM_ADDRESS` | Domicilio fiscal para contratos |
| `MIFIEL_APP_ID` | App ID de Mifiel para firma electrónica |
| `MIFIEL_APP_SECRET` | Secret de Mifiel |
| `MIFIEL_ENV` | Entorno Mifiel (`sandbox` o `production`) |
| `API_BASE_URL` | URL base de la aplicación |

### softcredito-adapter (`:3004`)

| Variable | Descripción |
|----------|-------------|
| `PORT` | `3004` |
| `SOFTCREDITO_API_URL` | URL de la API de SoftCrédito |
| `SOFTCREDITO_CLIENT_ID` | Client ID de SoftCrédito |
| `SOFTCREDITO_CLIENT_SECRET` | Client Secret de SoftCrédito |
| `PAYMENT_SERVER_URL` | URL interna del payment server |

### underwriting-service (`:3003`)

| Variable | Descripción |
|----------|-------------|
| `PORT` | `3003` |
| `VERIFIK_API_KEY` | API key de Verifik para verificación de identidad |
| `VERIFIK_BASE_URL` | URL base de Verifik |
| `SW_USER` / `SW_PASSWORD` | Credenciales de SW SAPiens (SAT) |
| `SW_BASE_URL` | URL base de SW SAPiens |
| `BELVO_SECRET_ID` / `BELVO_SECRET_PASSWORD` | Credenciales de Belvo open-finance |
| `BELVO_BASE_URL` | URL base de Belvo |
| `RISKSEAL_API_KEY` | API key de RiskSeal (digital footprint) |
| `RISKSEAL_MOCK` | `true` para modo mock |
| `SARDINE_CLIENT_ID` / `SARDINE_SECRET_KEY` | Credenciales de Sardine.ai |
| `SARDINE_MOCK` | `true` para modo mock |
| `GOOGLE_DOCAI_PROJECT_ID` | ID del proyecto de Google Document AI |
| `GOOGLE_DOCAI_PROCESSOR_ID` | ID del procesador Document AI |
| `INCODE_API_KEY` | API key de Incode KYC |
| `INCODE_MOCK` | `true` para modo mock |
| `TRUORA_API_KEY` | API key de Truora (AML/PEP) |
| `TRUORA_MOCK` | `true` para modo mock |

### ml-service (`:8000`)

| Variable | Descripción |
|----------|-------------|
| `PORT` | `8000` |
| `ANTHROPIC_API_KEY` | API key de Anthropic para Claude LLM judge |
| `USE_ML_MODELS` | `true` para activar modelos ML |
| `ML_CACHE_TTL` | TTL del cache ML en segundos |

> **Nota:** Nunca commits archivos `.env` al repositorio. Solo los `.env.example` se versionan.

---

## Deployment / Despliegue

### Firebase (Frontend + Functions + Firestore)

```bash
# Desplegar todo (hosting + functions + reglas)
firebase deploy

# Solo frontend
firebase deploy --only hosting

# Solo Cloud Functions
cd functions && npm install && cd ..
firebase deploy --only functions

# Solo reglas de Firestore
firebase deploy --only firestore:rules

# Solo reglas de Storage
firebase deploy --only storage
```

**URLs de producción:**

| Recurso | URL |
|---------|-----|
| Aplicación web | https://vida-finance.web.app |
| Firebase Console | https://console.firebase.google.com/project/vida-finance/overview |

### Railway (Microservicios)

Los microservicios en `services/` se despliegan en Railway. Cada servicio tiene su propio `Dockerfile` o `package.json` start script.

```bash
# Instalar Railway CLI
npm install -g @railway/cli

# Autenticarse
railway login

# Desplegar un servicio específico
cd services/payment-server
railway up

# O desplegar desde el dashboard de Railway
# https://railway.app
```

Cada servicio en Railway necesita las variables de entorno configuradas en su panel de Settings > Variables.

### CI/CD

El repositorio utiliza GitHub Actions (`.github/workflows/`) para automatizar el despliegue. Los pushes a `main` activan el pipeline de producción.

---

## Additional Documentation

| Documento | Descripción |
|-----------|-------------|
| [SERVICES.md](SERVICES.md) | Tabla de microservicios Railway con puertos, lenguajes y funciones |
| [SETUP.md](SETUP.md) | Guía completa de configuración, Firebase Console setup, troubleshooting |

---

## License / Licencia

Propiedad privada de VIDA Finance. Todos los derechos reservados.

Private property of VIDA Finance. All rights reserved.
