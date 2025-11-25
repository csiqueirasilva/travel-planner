# Travel Planner API

Express + Prisma API for a classroom travel booking exercise. It exposes CRUD and search endpoints for hotels, locations, flights, clients, purchases, offers, bookings, itineraries, and admin reports. CORS is fully open for quick experimentation and all requests use a 7-digit `Authorization` header as the matricula.

## Quickstart (Docker)
1. Copy `.env.example` to `.env` (defaults assume docker-compose):  
   `cp .env.example .env`  
   Then set `ADMIN_TOKEN` (UUID-style string) and adjust `ADMIN_MATRICULAS` (comma-separated 7-digit matriculas) if you want different admins.
2. Build and start:  
   `docker-compose up --build -d`
3. Run database migrations and seed sample data:  
   `docker-compose exec api npx prisma migrate deploy`  
   `docker-compose exec api node prisma/seed.js`
4. The API listens on `http://localhost:3000` (Caddy will serve HTTPS on `https://leiame.app` in production).

## Development (local Node)
```bash
npm install
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/travel_planner"
npx prisma migrate dev --name init   # first time only
npm run seed
npm run dev
```

## Tests
- The suite has 34 Node test cases covering positive/negative paths against the OpenAPI spec.
- Ensure the API is running and `.env` includes `BASE_URL` (pointing at the running API) and `ADMIN_TOKEN`; `STUDENT_TOKEN`/`OTHER_TOKEN` can be set to override the defaults used in tests.
- Run: `npm run test:prod` (loads env via dotenv automatically).

## Auth
- Send `Authorization: 1234567` (7 digits) for student requests. For admin-only routes, send the admin token configured via `ADMIN_TOKEN` in `.env` or `config/admin.json`.
- Config: copy `config/admin.example.json` to `config/admin.json` and set a strong `adminToken` (this file is git-ignored). The server also reads `ADMIN_MATRICULAS` from env for legacy admin matriculas and falls back to `ADMIN_TOKEN` for admin access.
- Sample seed users: admin matricula `0000001`, student `1234567` (student rights); admin token overrides role checks.

## Endpoints (high level)
- `GET /health` simple status.
- Hotels: `GET/POST/PUT/PATCH/DELETE /hotels`, `GET /hotels/:id`, `GET /hotels/:id/availability`, `GET/POST /hotels/:id/reviews`.
- Locations: `GET/POST/PUT/DELETE /locations`, `GET /locations/:id`.
- Flights: `GET /planes` (filters `origin`, `destination`, `date`), `GET /planes/:id`, `POST/PUT/DELETE /planes`, alias `GET /planes/search`.
- Clients: `POST /clients`, `GET/PUT/DELETE /clients/:matricula`, admin list `GET /clients`.
- Purchases: `POST /purchases`, `GET/PUT/DELETE /purchases/:id`.
- Offers: `GET /offers`, `GET /offers/today`, `GET /offers/:id`, admin `POST/PUT/DELETE /offers`.
- Bookings: `POST /bookings`, `GET/PUT/DELETE /bookings/:id`.
- Itineraries: `POST /itineraries`, `GET/DELETE /itineraries/:id`.
- Reports (admin): `/reports/sales`, `/reports/clients`, `/reports/top-destinations`, `/reports/usage?matricula=`.
- Auth helper: `POST /auth/login` echoes `Bearer` token for a matricula.
- Docs: Swagger UI at `/docs` and raw spec at `/openapi.json`.
- Split OpenAPI specs (<=30 ops each): `/openapi-client.json` (student flows) and `/openapi-admin.json` (admin flows). Swagger UI exposes both in the selector at `/docs`.

## Notes
- CORS is fully open (`*`) in both Express and the reverse proxy (Caddy).
- The seed script wipes existing data before inserting fixtures; use once to reset the class sandbox.
# travel-planner
