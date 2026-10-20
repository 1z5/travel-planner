# Travel Planner (AI Itinerary Generator)

Enter destination / start-end times / budget / preferences / pace / your hotel / must-visit spots → step-5 generates a **structured itinerary JSON** → Amap POI verification + transit estimation → an itinerary with a health-check report.

> Trip length is 1–4 days (minute-precision start/end pickers; same-day round trips automatically skip the hotel). The 4-day cap is empirical: 5-day single generations reliably overflow the output budget and time out (16 minutes and still failing). 5+ days are on the M6 roadmap.

## Why it's built this way

Travel planning isn't chat — it's **constraint satisfaction**: budget, time, geographic distance, POI reality. Hence:

1. **The LLM only emits structured JSON** (per-day time slots: POI / duration / cost / rain backup) rendered by the frontend — the model gets no room to freestyle
2. **Hallucination governance is the product**: every sight and restaurant is verified against Amap POI search, and inter-stop transit is estimated with the distance matrix — one closed restaurant in the itinerary and the user never comes back
3. **Health-check, don't rewrite**: v1 never rewrites the LLM's itinerary; it surfaces every risk (detours / pace / budget / unverified POIs) honestly

## Quick start

```bash
cp .env.example .env   # pre-generated; fill in LLM_API_KEY (MOCK mode works without an Amap key)
npm install
npm run dev             # http://localhost:3000
```

Config:

- `LLM_*`: step-5 (OpenAI-compatible), pre-filled
- `AMAP_WEB_SERVICE_KEY`: apply for a "Web Service" key at the [Amap console](https://console.amap.com/dev/key/app) (free for personal use). Without it the app runs in MOCK mode (full pipeline works, POIs unverified, `plan.verified=false`). After getting a key, run `npm run verify:amap` for a 5-second end-to-end key check
- `DAILY_FREE_LIMIT`: daily free generations for anonymous users (per IP; storage switchable, see Architecture)

## Tests

```bash
npm test        # self-contained: spawns stub LLM + isolated-port test servers, cleans up after
```

124 assertions across four suites:

- **Input boundaries (20) + health check (2)**: empty body / bad city / day-range / budget / malformed JSON / hotel, must-visit and pace format & injection cases → all 400; `/api/health` returns 200 without leaking secrets
- **Fault injection (7)**: happy path / garbage output / empty content / upstream 500 / quota refund arithmetic / hotel + must-visit hard-constraint verification (satisfied items don't warn, missing items do, fuzzy hotel descriptions don't false-positive, prompt wiring verified)
- **LLM output structure checks (11)**: shuffled + gapped day numbering (array [Day2,Day3,Day1], day fields [5,9,2]) → normalized to consecutive 1..N without reordering content; day-count mismatch (asked 4 days, got 3) → corrective-instruction retry → then an explicit failure with the quota refunded
- **Amap integration (9, live-shaped stubs)**: `verified=true`, place-name → coordinates → distance → minutes conversion (incl. the 30-minute fallback for unmatched POIs), cost aggregation, precise miss warnings
- **Auth (49)**: dev provider (21) + WeChat OAuth (15) + SMS (13): code flows, 401/400 paths, cookie issuance, dual-track quota (10/day user vs 3/day IP), independent per-user accounting, SMS anti-spam (6th code → 429), full WeChat OAuth (CSRF state, code→openid, session), SMS via Tencent Cloud TC3 signing with server-side one-time codes

Plus 50 Vitest unit tests: Amap three-state semantics (QPS-exceeded retries 3× and is then classified as an error — never downgraded to "not found"), in-flight dedup, bounded concurrency, and RFC 5545 `.ics` details (cross-midnight DTEND rollover, folding by UTF-8 **bytes**, escaping, UID uniqueness).

Public-internet hardening: input character whitelists (user content is interpolated into prompts — injection defense), SMS flood control (5/hour per number, 20/hour per IP), httpOnly+HMAC sessions with constant-time comparison, OAuth state CSRF defense, open-redirect prevention, automatic Secure cookies in production, `/api/health` config self-check.

The stub services (`scripts/stub-llm.mjs` / `scripts/amap-stub.mjs`) switch LLM/Amap behavior by request content, making fault and integration tests run in seconds without burning real tokens or needing real keys. CI: typecheck → build → test.

## Architecture

```
app/page.tsx                  form + itinerary rendering + Markdown export (client)
app/api/plan/route.ts         POST → quota → create async job → return jobId (202)
app/api/plan/status/route.ts  GET ?id= → poll job status (running/done/error)
app/p/[id]/page.tsx           share page (SSR + dynamic OG metadata)
app/api/plan/ics/route.ts     .ics calendar export
lib/planner.ts                step-5 single-pass structured generation + zod schema (quality core)
lib/jobs.ts                   async jobs: background generation + health check, persisted via Store
lib/store/                    storage abstraction: JobStore/QuotaStore/CodeStore interfaces +
                              memory (default) / postgres (Prisma) implementations,
                              switched by DATA_STORE, both covered by contract tests
lib/amap.ts                   POI verification + distance-matrix transit estimation (MOCK fallback)
lib/validate.ts               hallucination governance + health check: detour / pace / budget / unverified
lib/ratelimit.ts              quota & rate limiting (daily dual-track + hourly-bucket anti-spam), via Store
```

**Why async jobs**: step-5 is a reasoning model; one full plan takes 2–4 minutes. Synchronous waiting breaks both the browser and serverless, so POST returns a jobId immediately and the frontend polls every 3s with a live elapsed timer; failures refund the quota automatically.

## Milestones

- [x] **M1 skeleton**: form → API → structured LLM output → MOCK health check → render
- [x] **Async jobs**: POST 202 + polling + elapsed display + failure refund
- [ ] **M2 live data**: pending an Amap key to leave MOCK mode and run the 20-city eval (`npm run eval:cases`)
- [x] **M3 auth**: three providers (dev / Tencent Cloud SMS via TC3 direct signing / WeChat OAuth2), self-signed HMAC session cookies (7 days, no DB), dual-track quota, SMS anti-spam, WeChat CSRF defense — pending vendor credentials to go live
- [ ] **M4 deployment**: prepped (standalone output + Dockerfile + DEPLOY.md); pending platform choice (CloudBase recommended) and domain registration
- [x] **M5 UX**: share links, Markdown/calendar export (M5's map visualization pending)
- [ ] **M6 extensions**: outbound travel, 5+ day trips, hotel/flight comparison, budget tracking

## Measured results (2026-10)

| Case               | Time                            | Warnings          | Notes                                                      |
| ------------------ | ------------------------------- | ----------------- | ---------------------------------------------------------- |
| Xi'an 4d ¥2500     | 253s                            | detour 2 + pace 3 | POIs real and sensible                                     |
| Suzhou 3d ¥2500    | 237s                            | detour 2 + pace 2 | booking tips accurate                                      |
| Hangzhou 3d ¥2800  | 253s (streaming)                | detour 3 + pace 2 | ¥2490 (89% of budget); 15151 tokens                        |
| Xiamen 4d ¥3500    | 297s (**standalone prod mode**) | detour 3 + pace 2 | ¥2945 (84%); booking/rainy-day fallback tips               |
| Hong Kong 3d ¥3000 | **496.6s** (first real user)    | pace 1            | ¥2439 (81%); 28805 tokens (cross-border doubles reasoning) |
| Chengdu 4d ¥3000   | 185s (isolated)                 | —                 | after the budget-prompt fix                                |

Key engineering findings (details in CHANGELOG.md):

- **undici headersTimeout**: non-streaming requests were silently killed at 300s (before our 420s SDK timeout) — fixed by streaming
- **SDK timeout semantics**: `timeout` only fires after `attempts × timeout` (30s timeout threw at 91s) — requires `maxRetries: 0`
- **Prompt complexity drives reasoning cost**: percentage-based budget rules grew reasoning from ~13k to 40k+ characters and tripled generation time — constraints must be anchors, not arithmetic
- **Streaming timeout reality**: with streaming, the timeout bounds chunk gaps, not total time — long jobs legitimately complete

## Known trade-offs (deliberate)

- Reasoning models are slow at constraint planning (~3–4 min, 185s for a 4-day Chengdu trip); async jobs + progress polling absorb it
- Transit is estimated from driving distance ÷ average urban speed, not real transit routing — good enough for v1
- Health-check only, never rewrite: rewriting introduces second-order errors and takes control away from the user
- **Deployment note**: 2–4 minute generations with continuously-executing jobs mean production must be a **long-running Node service** (CloudBase / lightweight server); pure serverless functions freeze after response and lose jobs

---

[中文文档](README.md)
