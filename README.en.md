# AI Travel Companion

[简体中文](README.md) · [Main app](https://travel-planner-demo.onrender.com) · [Offline verifier](https://1z5.github.io/AI-Travel-Companion/)

A self-hostable travel tool. Plan a trip before departure, then open Today to see what's next and get directions. Trip Check also checks existing itineraries. It reports schedule consistency and factual coverage separately. Its CLI, API, and offline verifier use the same rules.

Place, hours, and route data come from Amap where available. Check official notices for last-minute changes. Anyone with an itinerary link can view it and may be able to edit its plan.

## Run locally

Use Node.js 22 or later.

```bash
npm ci
npm run db:generate
cp .env.example .env
npm run dev
```

Open <http://localhost:3000>. Sample trips and offline verification work without keys. For itinerary generation, set `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY` in `.env.local`. For live maps and place data, set `AMAP_WEB_SERVICE_KEY`. Local memory storage loses trips on restart. See the [deployment guide](docs/DEPLOY.md) for persistent storage and `npm run gate` for the test suite with stubs.

[Documentation](docs/README.md) · [Trip Check standard](docs/TRIP-CHECK-STANDARD.md) · [Contributing](CONTRIBUTING.md) · [Apache-2.0 license](LICENSE) · [Third-party notices](NOTICE.md)
