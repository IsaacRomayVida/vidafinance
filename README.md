# VIDA Finance

**Crédito respaldado por nómina para trabajadores formales en México.**\
*Payroll-backed lending for formal workers in Mexico.*

---

## Overview / Descripción General

VIDA Finance es una plataforma fintech que otorga microcréditos de corto plazo respaldados por nómina a empleados formales en México. El cobro se realiza mediante descuento directo de nómina a través de convenios con empleadores, lo que reduce el riesgo crediticio y permite tasas competitivas frente a alternativas informales.

VIDA Finance is a fintech platform providing short-term, payroll-backed micro-loans to formal employees in Mexico. Repayment is collected via direct payroll deduction through employer agreements, reducing credit risk and enabling competitive rates versus informal alternatives.

### Product Parameters / Parámetros del Producto

| Parámetro | Valor |
|-----------|-------|
| Plazo del préstamo | 30 días fijo |
| Tasa de interés | 30% mensual |
| Crédito máximo | 30% del salario mensual |
| Monto máximo | $5,000 MXN |
| Desembolso | 24 horas |

---

## Architecture / Arquitectura

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Firebase Platform                            │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐  ┌───────────┐ │
│  │   Hosting     │  │  Cloud       │  │ Firestore │  │   Auth    │ │
│  │  (SPA/CDN)   │  │  Functions   │  │ (Database)│  │(Email/Pwd)│ │
│  └──────┬───────┘  └──────┬───────┘  └───────────┘  └───────────┘ │
│         │                 │                                         │
└─────────│─────────────────│─────────────────────────────────────────┘
          │                 │
          │        ┌────────▼────────┐
          │        │   Redis 7       │
          │        │  (BullMQ queues)│
          │        └────────┬────────┘
          │                 │
     ┌────▼─────────────────▼──────────────────────────────────────┐
     │               Railway Microservices                          │
     │                                                              │
     │  ┌──────────────┐  ┌─────────────────┐  ┌───────────────┐  │
     │  │payment-server│  │notification-svc │  │ pdf-generator │  │
     │  │  :3001       │  │  :3002          │  │  :3003        │  │
     │  └──────────────┘  └─────────────────┘  └───────────────┘  │
     │                                                              │
     │  ┌──────────────────┐  ┌────────────┐  ┌────────────────┐  │
     │  │softcredito-      │  │ ml-service │  │  underwriting  │  │
     │  │adapter :3004     │  │  :8000     │  │  -service      │  │
     │  └──────────────────┘  └────────────┘  └────────────────┘  │
     └──────────────────────────────────────────────────────────────┘
```

La plataforma se compone de dos capas principales:

1. **Firebase** — Hosting del SPA, autenticación, base de datos Firestore y Cloud Functions (Gen2) como API gateway.
2. **Railway** — Microservicios containerizados conectados vía Redis/BullMQ para procesamiento asíncrono de pagos, notificaciones, documentos PDF, integración con SoftCrédito y scoring crediticio ML.

---

## Tech Stack / Stack Tecnológico

| Capa | Tecnología |
|------|-----------|
| Frontend | Vanilla HTML/CSS/JS — SPA con `history.pushState`, bilingüe (ES/EN) |
| Backend API | Firebase Cloud Functions (Gen2), Node.js 22 |
| Base de datos | Cloud Firestore |
| Autenticación | Firebase Authentication (Email/Password) |
| Cola de tareas | Redis 7 + BullMQ |
| Microservicios | Node.js (payment, notification, PDF, softcredito) + Python (ML) |
| ML/Scoring | XGBoost, LightGBM, Claude LLM judge |
| Pagos | Conekta (webhooks SPEI) |
| Notificaciones | Twilio (WhatsApp), SendGrid (email) |
| E-firma | Mifiel (NOM-151 pagarés) |
| KYC/AML | Incode, Truora, Verifik, Sardine, RiskSeal |
| Open Finance | Belvo |
| OCR Nómina | Google Document AI |
| Hosting | Firebase Hosting (frontend), Railway (microservicios) |
| CI/CD | GitHub Actions |
| Design | DM Serif Display + DM Sans, colores `#194445` (teal) y `#a28657` (oro) |

---

## Repository Structure / Estructura del Repositorio

```
vidafinance/
├── public/                          # Frontend SPA (Firebase Hosting)
│   ├── index.html                   # Punto de entrada SPA
│   ├── css/style.css                # Estilos globales
│   └── js/app.js                    # Routing, i18n, componentes, Firebase SDK
├── functions/                       # Cloud Functions (Gen2)
│   ├── index.js                     # API endpoints
│   └── package.json
├── services/                        # Microservicios Railway
│   ├── payment-server/              # Conekta webhooks + desembolso SPEI
│   ├── notification-service/        # WhatsApp (Twilio) + email (SendGrid)
│   ├── pdf-generator/               # Contratos y recibos con Puppeteer
│   ├── softcredito-adapter/         # API wrapper SoftCrédito SPEI + nómina
│   ├── ml-service/                  # Scoring XGBoost/LightGBM + Claude LLM
│   ├── underwriting-service/        # Verificación KYC/AML + gobierno
│   └── shared/                      # Middleware compartido (CORS, auth, rate limiting)
├── images/                          # Assets SVG del logo
├── scripts/                         # Scripts de verificación
├── firebase.json                    # Config: hosting, Firestore, Functions, emuladores
├── firestore.rules                  # Reglas de seguridad Firestore
├── firestore.indexes.json           # Índices compuestos Firestore
├── storage.rules                    # Reglas de seguridad Storage
├── SERVICES.md                      # Documentación de microservicios Railway
├── SETUP.md                         # Guía detallada de configuración
└── README.md                        # Este archivo
```

Para detalles de cada microservicio, consulta **[SERVICES.md](SERVICES.md)**.

---

## Local Development Setup / Configuración de Desarrollo Local

### Prerequisites / Requisitos Previos

| Herramienta | Versión | Instalación |
|-------------|---------|-------------|
| Node.js | 20+ | `brew install node` o [nodejs.org](https://nodejs.org) |
| Python | 3.10+ | `brew install python` (solo para ml-service) |
| Firebase CLI | latest | `npm install -g firebase-tools` |
| GitHub CLI | latest | `brew install gh` |
| Docker | latest | [docker.com](https://www.docker.com) (para microservicios) |

### 1. Clone & Install / Clonar e Instalar

```bash
git clone https://github.com/IsaacRomayVida/vidafinance.git
cd vidafinance

# Instalar dependencias de Cloud Functions
cd functions && npm install && cd ..
```

### 2. Firebase Setup / Configuración de Firebase

```bash
firebase login
firebase use vida-finance
```

### 3. Start Emulators / Iniciar Emuladores

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

Abre http://localhost:5000 para el frontend y http://localhost:4000 para la interfaz de emuladores.

### 4. Quick Frontend Only / Solo Frontend (rápido)

```bash
cd public
python3 -m http.server 5500
```

> **Nota:** Las rutas SPA como `/employers` darán 404 con el servidor Python. Usa los emuladores de Firebase para routing completo.

### 5. Railway Microservices (Local) / Microservicios Railway (Local)

Cada microservicio se puede ejecutar individualmente:

```bash
# Ejemplo: payment-server
cd services/payment-server
cp .env.example .env    # Configurar variables de entorno
npm install
npm start
```

Para el servicio ML (Python):

```bash
cd services/ml-service
cp .env.example .env
pip install -r requirements.txt
python main.py
```

---

## Environment Variables / Variables de Entorno

### Common to All Services / Comunes a Todos los Servicios

| Variable | Descripción |
|----------|-------------|
| `PORT` | Puerto del servicio |
| `REDIS_URL` | URL de conexión Redis (rediss:// para TLS) |
| `INTERNAL_SECRET` | Token de autenticación inter-servicios |
| `FIREBASE_SERVICE_ACCOUNT` | JSON de cuenta de servicio Firebase |
| `FIREBASE_SERVICE_ACCOUNT_B64` | Alternativa: cuenta de servicio en Base64 |

### Cloud Functions

| Variable | Descripción |
|----------|-------------|
| `NODE_ENV` | Modo del entorno (development/production) |
| `CONEKTA_API_KEY` | API key de Conekta (pagos) |
| `ML_SERVICE_URL` | URL del servicio ML |
| `PAYMENT_SERVER_URL` | URL del payment-server |
| `SOFTCREDITO_ADAPTER_URL` | URL del adaptador SoftCrédito |
| `NOTIFICATION_SERVICE_URL` | URL del servicio de notificaciones |
| `PDF_GENERATOR_URL` | URL del generador de PDF |

### payment-server (:3001)

| Variable | Descripción |
|----------|-------------|
| `CONEKTA_WEBHOOK_SECRET` | Secreto para verificar webhooks de Conekta |
| `SOFTCREDITO_ADAPTER_URL` | URL interna del adaptador SoftCrédito |

### notification-service (:3002)

| Variable | Descripción |
|----------|-------------|
| `TWILIO_ACCOUNT_SID` | SID de cuenta Twilio |
| `TWILIO_AUTH_TOKEN` | Token de autenticación Twilio |
| `TWILIO_WHATSAPP_FROM` | Número WhatsApp remitente |
| `SENDGRID_API_KEY` | API key de SendGrid (email) |

### pdf-generator (:3003)

| Variable | Descripción |
|----------|-------------|
| `FIREBASE_STORAGE_BUCKET` | Bucket de Storage (vida-finance.appspot.com) |
| `SOFOM_RFC` | RFC de la SOFOM |
| `SOFOM_ADDRESS` | Dirección de la SOFOM |
| `MIFIEL_APP_ID` | App ID de Mifiel (e-firma) |
| `MIFIEL_APP_SECRET` | Secreto de Mifiel |
| `MIFIEL_ENV` | Entorno Mifiel (sandbox/production) |
| `API_BASE_URL` | URL base para callbacks |

### softcredito-adapter (:3004)

| Variable | Descripción |
|----------|-------------|
| `SOFTCREDITO_API_URL` | URL base de la API SoftCrédito |
| `SOFTCREDITO_CLIENT_ID` | Client ID OAuth SoftCrédito |
| `SOFTCREDITO_CLIENT_SECRET` | Client Secret OAuth SoftCrédito |
| `PAYMENT_SERVER_URL` | URL interna del payment-server |

### ml-service (:8000)

| Variable | Descripción |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key de Claude (LLM judge) |
| `USE_ML_MODELS` | Habilitar modelos ML (boolean) |
| `ML_CACHE_TTL` | TTL de caché ML en segundos (default: 86400) |

### underwriting-service

| Variable | Descripción |
|----------|-------------|
| `VERIFIK_API_KEY` | API key de Verifik (verificación de identidad) |
| `VERIFIK_BASE_URL` | URL base de Verifik |
| `BELVO_SECRET_ID` | Secret ID de Belvo (open finance) |
| `BELVO_SECRET_PASSWORD` | Password de Belvo |
| `BELVO_BASE_URL` | URL base de Belvo |
| `INCODE_API_KEY` | API key de Incode (KYC) |
| `INCODE_API_URL` | URL de Incode |
| `INCODE_FLOW_ID` | Flow ID de Incode |
| `TRUORA_API_KEY` | API key de Truora (AML/PEP) |
| `TRUORA_BASE_URL` | URL base de Truora |
| `RISKSEAL_API_KEY` | API key de RiskSeal |
| `SARDINE_CLIENT_ID` | Client ID de Sardine (biometrics) |
| `SARDINE_SECRET_KEY` | Secret key de Sardine |
| `GOOGLE_DOCAI_PROJECT_ID` | GCP Project ID para Document AI |
| `GOOGLE_DOCAI_PROCESSOR_ID` | Processor ID de Document AI |
| `SW_USER` | Usuario de SW SAPiens (contabilidad) |
| `SW_PASSWORD` | Password de SW SAPiens |

### CI/CD (GitHub Actions Secrets)

| Variable | Descripción |
|----------|-------------|
| `FIREBASE_SERVICE_ACCOUNT_PRODUCTION` | Cuenta de servicio Firebase (producción, Base64) |
| `RAILWAY_API_TOKEN` | Token de Railway CLI |

---

## Deployment / Despliegue

### Firebase (Frontend + Functions)

```bash
# Desplegar todo (hosting + functions + firestore rules)
firebase deploy

# Solo frontend
firebase deploy --only hosting

# Solo Cloud Functions
cd functions && npm install && cd ..
firebase deploy --only functions

# Solo reglas de Firestore
firebase deploy --only firestore:rules
```

### Railway (Microservices)

Cada servicio en `services/` incluye un `Dockerfile` y `railway.json`. El despliegue se realiza vía GitHub Actions en el workflow `railway-deploy.yml`, o manualmente con Railway CLI:

```bash
# Instalar Railway CLI
npm install -g @railway/cli

# Login y deploy
railway login
railway up
```

### CI/CD Automático

- **Firebase**: El workflow `.github/workflows/firebase-deploy.yml` despliega automáticamente al hacer push.
- **Railway**: El workflow `.github/workflows/railway-deploy.yml` despliega los microservicios.

---

## SPA Routes / Rutas del SPA

| Ruta | Página |
|------|--------|
| `/` | Homepage |
| `/employers` | Landing para empleadores |
| `/employees` | Landing para empleados |
| `/login` | Inicio de sesión |
| `/onboarding` | Wizard de registro |
| `/employer/dashboard` | Dashboard del empleador |
| `/employee/dashboard` | Dashboard del empleado |
| `/about` | Acerca de |
| `/security` | Seguridad |
| `/privacy` | Política de privacidad |
| `/terms` | Términos de servicio |
| `/contact` | Contacto |

---

## Related Documentation / Documentación Relacionada

- **[SERVICES.md](SERVICES.md)** — Detalle de microservicios Railway (puertos, lenguajes, propósito)
- **[SETUP.md](SETUP.md)** — Guía completa de configuración y troubleshooting

---

## License / Licencia

Proprietary — VIDA Finance © 2024–2026. All rights reserved.\
Propietario — VIDA Finance © 2024–2026. Todos los derechos reservados.
