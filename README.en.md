# AI Travel Companion

[简体中文](README.md) · [Main app](https://travel-planner-demo.onrender.com) · [Offline verifier](https://1z5.github.io/AI-Travel-Companion/)

A self-hostable travel tool. Plan a trip before departure, then open Today to see what's next and get directions. Trip Check also checks existing itineraries. It reports schedule consistency and factual coverage separately. Its CLI, API, and offline verifier use the same rules.

Live place, hours, and route data come from Amap where available. Local trips can also display reference information included in their files. Check official notices for last-minute changes. Anyone with an itinerary link can view it and may be able to edit its plan.

## Try the Tokyo itinerary

Start a walk from the home page to record stops, photos, and notes on your device. You can attach your position to a stop and take it with you in a private backup. The Tokyo sample opens directly from the home page. In a production build, prepare it for offline use while connected, then reopen it offline to try marking an arrival. [Walkthrough and architecture diagram](README.md#试玩东京行程) · [Production setup](docs/DEPLOY.md)

When editing a Tokyo or Paris trip, you can also add places from the built-in city pack. Today shows place sources and counts stops with documented opening hours. Local calendar exports use the destination time zone when available.

Expand Offline Trip Check to check the schedule and compare matching stops with the bundled data. Imported opening-hour notes and route estimates remain available for reference.

## Run locally

Use Node.js 22 or later.

```bash
npm ci
npm run db:generate
cp .env.example .env
npm run dev
```

Open <http://localhost:3000>. Sample trips and offline verification work without keys. For itinerary generation, set `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY` in `.env.local`. For live maps and place data, set `AMAP_WEB_SERVICE_KEY`. In local-first mode, the browser keeps saved trips and arrival records across server restarts. Use `npm run gate` for the test suite with stubs. [Deployment and persistent storage](docs/DEPLOY.md)

[Documentation](docs/README.md) · [Trip Check standard](docs/TRIP-CHECK-STANDARD.md) · [Contributing](CONTRIBUTING.md) · [Apache-2.0 license](LICENSE) · [Third-party notices](NOTICE.md)
