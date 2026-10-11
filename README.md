# CampusHub Full-Stack Project

CampusHub is a full-stack campus marketplace and event platform built with a Node.js/Express backend and a React frontend. This is the single merged project: the Phase 1 MVP, the Phase 2 features (Redis, SMS simulation, in-app P2P payment, tiered late fees, recurring events + waitlists, offline scan batches, CSV exports, payment-provider registry) and the Phase 3 multi-university tenancy all live in `backend/` and `frontend/`.

## Project structure

```text
CampusHub/
├── backend/                 # Express API + PostgreSQL backend
├── frontend/                # React + Vite frontend
├── docs/                    # SRS and build prompts
├── archive/                 # archived legacy copies
├── README.md                # full-stack project guide
└── .gitignore               # workspace ignore rules
```

## Stack

- Backend: Node.js, Express, PostgreSQL, JWT auth, Zod validation, Multer uploads
- Frontend: React, Vite, React Router, Axios
- Extra features: QR ticket verification, payment abstraction, merchant flows, rental flow, events, admin tools, Redis cache/rate limiting (optional), multi-university tenancy

## Features included

- Student marketplace with products and listings
- Event management and ticket purchase flow
- Rental bookings and tracking
- Merchant onboarding and approval
- Admin reports and moderation tools
- Notifications and favorites
- QR scanning for ticket validation
- Image uploads and profile/account setup
- Phase 2: in-app P2P payment, tiered rental late fees, recurring events, ticket waitlists, offline QR scan sync, admin/merchant CSV exports
- Phase 3: multiple universities (tenant isolation), Super Admin API, per-university feature flags and fees

## Local setup

### 1) Backend

```bash
cd backend
npm install
copy .env.example .env
createdb campushub
npm run db:migrate:all
npm run db:seed
npm run dev
```

Redis is optional (`REDIS_URL` in `.env`); without it rate limiting and caching fall back to in-process behavior.

The backend runs on:

- http://localhost:4000

### 2) Frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

The frontend runs on:

- http://localhost:5173

## Default demo login

After seeding the database, log in with one of the seeded demo accounts. The default password is:

```text
Password123!
```

For the full list of seeded users, see [backend/README.md](backend/README.md).

## Useful commands

### Backend

```bash
cd backend
npm run dev
npm run db:migrate:all
npm run db:seed
npm run test:smoke
npm run test:smoke:phase2
npm run test:tenancy
```

### Frontend

```bash
cd frontend
npm run dev
npm run build
npm run preview
```

## Verification

To validate the API behavior after changes, use the backend smoke test:

```bash
cd backend
set -a; source .env; set +a   # same secrets for the test's QR signing as the server
bash test/smoke.sh
bash test/smoke_phase2.sh     # on a freshly seeded database
bash test/tenancy.sh          # on a freshly seeded database
bash test/tenancy_phase2.sh   # on a freshly seeded database
```

Together these check the main acceptance flows (auth, marketplace, event purchases, rental lifecycle, duplicate ticket rejection), the Phase 2 features, and that no data crosses between universities.

## Important notes

- The active project code lives in [backend](backend) and [frontend](frontend).
- Reference documents and prompts are kept in [docs](docs).
- Older project versions remain in [archive](archive) for safety and historical comparison (the Phase 1+2 copy there is now fully contained in the active app).
- This is the single main full-stack project for the workspace. See [docs/PHASE3.md](docs/PHASE3.md) for the tenancy design.
- Frontend caveat: with 2+ universities, anonymous browsing needs an `X-University-Id` header; a Super Admin UI does not exist yet.

## Next steps

If you want to continue development, open the backend and frontend folders and work from the active main app. The archived folder is there as a backup reference only.
