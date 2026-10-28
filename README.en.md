# Travel Planner (travel-planner)

> [中文文档](README.md)

**Verify the real world before planning the trip.** Destination / dates / budget / preferences → grounded generation from live Amap facts (POIs, opening hours, closure days, real transit) → a structured itinerary → **reproducible executability checks (Trip Check)** → mechanical repair → persistent sharing → in-trip mode.

- Live demo: <https://travel-planner-demo.onrender.com> (free Render instance; may cold-start for 30–60s; demo itineraries are read-only and clonable)
- Public verifier: <https://travel-planner-demo.onrender.com/verify>
- Status: v9 (2026-10-28; Trip Check verification layer + deterministic repair + shareable evidence). Full history in [CHANGELOG.md](CHANGELOG.md).

## What it solves

An LLM can write an itinerary, but it doesn't know that the Suzhou Museum is closed on Mondays, or that two stops are 22 minutes apart. This project:

1. **Fetches facts before generation** — real POIs, opening hours, closure days are injected into the prompt, so the model plans on ground truth instead of memory;
2. **Produces verifiable verdicts** — two axes (structural consistency A–D/score; factual verification verified/partial/unverified), every issue tagged with a rule ID and evidence;
3. **Signs nothing, proves reproducibility** — same document + same engine/ruleset → same credential ID (sha256). Anyone can recompute it; it is **not** a digital signature;
4. **Repairs only mechanically** — shift times, remove same-day duplicates; everything else is reported as unrepairable, never fabricated;
5. **Stays executable** — closure days, detours and impossible connections surface before departure; in-trip mode shows only today.

## Capabilities

| Area                  | What it does                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Grounded generation   | Amap candidate list → prompt → structured itinerary; degrades honestly when facts are unavailable                        |
| Trip Check            | Two-axis report, 17 rules, POI 3-state (hit/miss/error), `unknown` hours never alert                                     |
| Open verification API | `POST /api/verify`, `/api/verify/schema`, `/api/verify/repair`, `GET /api/verify/openapi`; CORS, rate-limited, stateless |
| Deterministic repair  | Time-shift / dedupe only; preview → confirm write (revision+1, optimistic concurrency); before/after credentials         |
| Shareable evidence    | `/p/<id>/check` report page, portrait poster, plain-text report, credential chain                                        |
| MCP                   | `POST /api/mcp` + `npm run mcp` (see [mcp/README.md](mcp/README.md))                                                     |
| Workspace             | Plan / map / adjust / today / check lenses, drag-to-reorder, itinerary copilot                                           |
| Sharing & in-trip     | Poster-grade share page + JSON-LD; `/t/<id>` today view with weather replanning and today's check                        |
| Metrics               | Privacy-bounded events (no phone/IP/content) + read-only summary endpoint                                                |

**Honesty boundaries**: credentials are reproducible hashes, not signatures; "unverified" never means "fine"; MOCK mode never claims real verification; Amap data is not stored long-term (commercial licensing noted in [NEXT_STEPS.md](NEXT_STEPS.md)).

## Stack & layout

Next.js 16 (App Router) · React 19 · strict TypeScript · Prisma 7 (memory/postgres) · zod 4 · Vitest + custom e2e orchestrator.

```
app/            product routes (home, new, workspace, share, in-trip, report) + API + marketing
lib/            planner, validation, Trip Check (verify/), Amap, stores, metrics
components/     workspace, PlanView, today view, check report, share actions
docs/           standard, ADRs, roadmap, security audit — index: docs/README.md
scripts/        gate / e2e / smoke-deployed / visual-check / demo / preflight
```

## Quick start

```bash
cp .env.example .env   # fill LLM_*; MOCK mode works without an Amap key
npm install
npx prisma generate    # required since Prisma 7 (no postinstall)
npm run dev            # http://localhost:3000
```

With an Amap key, run `npm run verify:amap` first (POI + transit smoke). Production setup: [DEPLOY.md](DEPLOY.md).

## Tests & acceptance

```bash
npm run gate          # typecheck + lint + format + unit + e2e (must be green)
npm test              # e2e: isolated servers + stub LLM/Amap
npm run gate:visual   # visual/accessibility regression (15 pages × desktop/mobile)
npm run check:env     # env drift / production safety check
```

Baseline (2026-10-28): **1202 unit tests + 776 e2e assertions**, `npm run gate` green; real-key evaluation across
Beijing / Shanghai / Guangzhou: 3/3 successful, POI verification 100% (51/51), median budget fit 82%.
Deployment acceptance: `node scripts/smoke-deployed.mjs <URL>` after Render reports the new commit via `/api/health`.

## Deployment

| Mode                   | When        | Notes                                                                                                     |
| ---------------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| [DEMO.md](DEMO.md)     | public demo | Render free Web Service + pre-generated fixtures; memory store, sleeps, not production                    |
| [DEPLOY.md](DEPLOY.md) | production  | `DATA_STORE=postgres` + auth provider + monitoring + domain; `preflight`/`check:env` block unsafe configs |

## Documentation

Index and reading order: [docs/README.md](docs/README.md). Key docs:
[standard](docs/TRIP-CHECK-STANDARD.md) · [strategy](docs/PRODUCT-REVOLUTION-2026-10.md) · [next steps](NEXT_STEPS.md) ·
[ADRs](docs/adr/) · [security](SECURITY.md) / [audit](docs/SECURITY-AUDIT-2026-10-28.md) · [API](API.md) · [history](CHANGELOG.md).

## Known boundaries

Reasoning-model latency (3–4 min for ≤4 days; multi-day streaming above that) absorbed by async jobs and quota refunds;
transit is a driving-matrix estimate, map lines are sequential not routing; share tokens act as capabilities until accounts exist;
repair is mechanical only; credentials are not signatures.

## License & contributing

[Apache-2.0](LICENSE) (Copyright © 2026 1z5) · [NOTICE.md](NOTICE.md) · [CONTRIBUTING.md](CONTRIBUTING.md).
Security reports: use the private channel in [SECURITY.md](SECURITY.md), not public issues.
