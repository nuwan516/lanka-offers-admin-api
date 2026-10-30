# Lanka Offers — Deployment Architecture & Operations Guide

## 1. Topology & Environment Overview

Lanka Offers operates as a lean, low-overhead deployment tailored for Phase 1 scale (< 2,000 active offers, < 50 RPS peak):

```text
                                [ Internet / Consumers ]
                                           │
                     ┌─────────────────────┴─────────────────────┐
                     │                                           │
                     ▼                                           ▼
          [ Web Frontend ] (Port 5173)              [ Mobile App ] (iOS/Android)
          Next.js App Router / Node.js              Direct HTTPS requests
                     │                                           │
                     └─────────────────────┬─────────────────────┘
                                           │
                                           ▼
                              [ Public Backend API ] (Port 3000)
                              Express / PM2 Service
                              Least-Privilege Role: lanka_offers_public_api
                                           │
                                           ▼
                              [ PostgreSQL Database ]
                              Neon Cloud (Serverless Postgres)
                                           ▲
                                           │ Operational Role (lanka_offers_admin)
                              [ Admin Control Plane ] (Port 3001)
                              Express / PM2 Service
                              Internal VPC / Private Access Only
                                           ▲
                                           │
                              [ Admin Dashboard UI ] (Port 5174)
                              Vite Static / Nginx
                              Internal Operations Console
```

---

## 2. Process Management (PM2)

Production Node.js services are orchestrated via PM2 using the configuration in `backend-api/ecosystem.config.js`:

```javascript
module.exports = {
  apps: [
    {
      name: 'lanka-offers-public-api',
      script: 'dist/app/server.js',
      cwd: './backend-api',
      instances: 2,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};
```

---

## 3. Environment Variables Reference

### 3.1 Public Backend (`backend-api/.env`)
| Variable | Required | Description |
|---|---|---|
| `DATABASE_PUBLIC_URL` | **Yes** | Postgres connection string strictly utilizing `lanka_offers_public_api` credentials. Fails closed if missing or privileged. |
| `PORT` | No | Server listen port (default: `3000`). |
| `CORS_ORIGIN` | No | Allowed frontend origins (comma-separated or `*`). |
| `NODE_ENV` | Yes | Set to `production`. |

### 3.2 Admin Control Plane (`admin/api/.env`)
| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | **Yes** | Privileged database connection string allowing DDL migrations, upserts, and review actions. |
| `PORT` | No | Admin API port (default: `3001`). |
| `NODE_ENV` | Yes | Set to `production`. |
| `SCRAPER_CONCURRENCY`| No | Max concurrent page fetches per scraper (default: `3`). |
| `GEMINI_API_KEY` | No | API key for selective LLM fallback validation. |

### 3.3 Consumer Web (`frontend/web/.env.local`)
| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | **Yes** | Public backend endpoint (e.g., `https://api.lanka-offers.me/api`). |

### 3.4 Admin Dashboard (`admin/dashboard/.env.local`)
| Variable | Required | Description |
|---|---|---|
| `VITE_API_URL` | **Yes** | Admin API endpoint (e.g., `http://localhost:3001/api`). |

---

## 4. Production Build & Release Steps

### 4.1 Backend API
```bash
cd backend-api
npm ci
npm run type-check
npm test
npm run build
pm2 start ecosystem.config.js
```

### 4.2 Admin API
```bash
cd admin/api
npm ci
npm run type-check
npm test
# Run migrations if new schema changes exist
npm run migrate
```

### 4.3 Web Frontend
```bash
cd frontend/web
npm ci
npm run typecheck
npm run build
npm start
```

### 4.4 Mobile App
```bash
cd frontend/mobile
flutter pub get
flutter test
# Release Android App Bundle
flutter build appbundle --release
# Release iOS IPA
flutter build ipa --release
```
