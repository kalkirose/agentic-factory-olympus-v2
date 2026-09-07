# ADR-038: Scaling posture — vertical-first deployment + horizontal-ready code from day one

**Status:** Accepted
**Date:** 2026-05-19
**Deciders:** Kalki, Claude
**Category:** Infrastructure & Deployment (Step 4 Category 5)
**Related:** NFR35 (concurrent session capacity), NFR36 (single-instance launch), NFR50 (always-on), ADR-002 (Redis on Railway — Redis-BullMQ queue is multi-instance-safe), ADR-023 (state management — discipline on module-level state), ADR-027 (Railway hosting), `architecture.md` § Step 4 Category 5 (archived 2026-07-18; current planning canon: cremerius-project/specs/)

## Context

NFR35 budgets 50 concurrent configurator sessions + 200 concurrent page views without >20% degradation (the configurator-session half is wave scope; the page-view half is the launch profile, per roadmap). NFR36 explicitly specifies single-instance launch — no autoscaling, no multi-region. NFR50 mandates always-on. *(amended 2026-07-04 — label drift: previously mis-cited as NFR47, which is zero-downtime deploys)*

The naive read: "single-instance launch" → "don't worry about multi-instance until forced to" → write code freely with cross-request state and module-level caches.

The reality: multi-instance retrofit is expensive. If we discover horizontal scale is needed (sudden traffic spike, regional expansion, etc.), reorganizing in-process state into shared infrastructure (Redis, DB) is days-to-weeks of work, blocking the scale event.

The Cat 4 / Cat 5 work-through identified this as an architectural decision worth making explicit: **single-instance deployment, multi-instance-ready code**. Almost everything in our stack (statelessness, Redis-backed Medusa workflow engine, Cloudflare load-balancing, R2/Postgres durable storage) is already multi-instance-safe by construction. The remaining gaps are small and worth closing now.

## Decision

**Vertical-first single-instance deployment with explicit horizontal-readiness discipline rules enforced in code.** Deploy as single-instance per NFR36; write all code to be deployable multi-instance without retrofit. Documented horizontal trigger criteria.

## Why this is the right call

**Retrofit cost is real.** Untangling in-process state from a codebase that wasn't designed for it takes days per concern. We can write the code right the first time at near-zero marginal cost.

**80% of horizontal readiness is already implicit in prior decisions:**

- **Statelessness** — Cat 4 locked no session affinity; state lives in Postgres + Redis + client.
- **Session cookies** (ADR-006) — `__Host-` Lax cookies work across instances.
- **Rate limiting** (ADR-017) — Redis-backed counters shared across instances.
- **Webhook idempotency** — Medusa's `IdempotencyKeyService` is DB-backed.
- **Workflow engine** — Medusa v2's Redis workflow engine uses BullMQ 5.x queues (multi-instance-safe by default).
- **Same-origin proxy** (ADR-010) — replica load-balancing is the Railway proxy's job; Cloudflare proxies to the single Railway origin and does not balance our replicas. *(amended 2026-07-04 — attribution fix)*
- **Asset delivery** (ADR-029) — R2 + CF off-origin; no origin involvement at scale.

**Closing the remaining 20% is cheap.** Six discipline rules + an ESLint guard + one env flag (~30 lines of code). Trivial cost; saves ~half-day to days of retrofit.

**Deployment topology and code posture are decoupled.** "Single-instance deployment" (NFR36) doesn't constrain "code is multi-instance safe" (this ADR). Easy to scale up later by changing replica count from 1 to N — no code changes.

**Trigger criteria are concrete.** "Sustained CPU >70% on largest instance" — measurable, not vibes-based. Operator action is the dashboard upgrade (vertical) or replica-count change (horizontal); both documented.

## How it works

**Deployment topology (per ADR-027):**

| Service | Plan | Replicas |
|---|---|---|
| storefront | $5/mo (1 vCPU, 1GB) | 1 |
| medusa | $10/mo (1 vCPU, 2GB) | 1 |
| Background workers | In-process inside Medusa | — |

Replica count stays at 1 at launch. It is a Railway dashboard setting, not an env var — Railway exposes `RAILWAY_REPLICA_ID` and `RAILWAY_REPLICA_REGION` to the process, but no `RAILWAY_REPLICA_COUNT` exists.

**Vertical scale path (dashboard moves, no engineering):**

| Step | Trigger |
|---|---|
| Storefront 1→2GB | NFR1 (FMP 1.5s) violations under load (Lighthouse soft fail in Stage 2 CI per ADR-026) |
| Medusa 2→4GB | Workflow queue depth growth OR `sharp` OOM on Mattes import OR memory-headroom alarm |
| Medusa 4→8GB | Sustained CPU >70% during business hours |

**Horizontal scale triggers (engineering work):**

| Threshold | Action |
|---|---|
| Storefront sustained CPU >70% on largest instance | Set replica count to 2 in the Railway dashboard. Already stateless; no code changes. Railway proxy load-balances. |
| Medusa CPU/memory pressure at largest instance OR workflow queue backlog | Extract background worker to a dedicated Railway service running the same OCI image with `WORKER_ONLY=1`, which will set Medusa's native `workerMode: "worker"` once the wiring lands (see rule 5). Config + provisioning plus the one-line wiring, not structural code work. *(amended 2026-07-04)* |

**Horizontal-readiness discipline rules (enforced from day one):**

1. **No local disk persistence.** All durable writes go to R2 or Postgres. Ephemeral disk allowed (scratch buffers, temp files inside a request) but must not survive process restart.
2. **No cross-request in-process caches.** Anything shared across requests goes to Redis. In-request memoization fine; module-level caches with mutable state forbidden.
   - **Storefront `$state` discipline** (per ADR-023): Module-level `$state` exports permitted **only** for static/derived values (locale config, brand tokens, simple UI flags). Never use module-level `$state` to accumulate per-request state — breaks horizontal scaling and risks cross-request data leaks in SSR.
3. **Migrations run via release command, not server boot.** Medusa's default; the rule (expand/contract, Railway pre-deploy command, rollback semantics) is codified in ADR-041 and orchestrated by the ADR-040 pipeline. On multi-instance, only one process runs migrations. *(amended 2026-07-04 — previously claimed "codified in ADR-040")*
4. **Scheduled jobs (if added) use Medusa's scheduler on the Redis workflow engine.** Double-execution is prevented by BullMQ repeatable-job keying (`schedule_<jobId>`) plus single-consumer pickup — a job registered by N instances exists once and fires once; no Redis lock is involved. The in-memory engine offers no such protection (per-process timers double-fire across instances) — the Redis engine is what makes multi-instance safe. Never naive `setInterval` in app code (would fire N times with N instances).
5. **Worker extraction uses Medusa's native `workerMode`; wiring lands with the scaling trigger.** Medusa v2 ships `server` / `worker` / `shared` process modes in `medusa-config.ts` — no hand-rolled boot logic skipping the HTTP listener. The `WORKER_ONLY` env var exists in the env schema (ADR-036) but is consumed by nothing yet; the wiring below is the target shape, added when the trigger fires:

   <!-- amended 2026-07-04: native workerMode replaces the hand-rolled boot flag -->
   ```ts
   // apps/medusa/medusa-config.ts
   module.exports = defineConfig({
     projectConfig: {
       // dedicated worker service runs the same OCI image with WORKER_ONLY=1;
       // if a separate web-only service is split out later, it runs "server"
       workerMode: process.env.WORKER_ONLY === "1" ? "worker" : "shared"
     }
   })
   ```

6. **CI multi-instance smoke test (optional, recommended).** Boots 2 Medusa containers behind a load balancer against one Neon branch; runs core E2E flows. Catches in-process-state assumptions early.

**Enforcement surface:**

- **ESLint rule** banning `fs.writeFile*` (and friends) outside `src/lib/server/r2-upload/**` (storefront) and outside known R2-upload modules (Medusa).
- **Code-review checklist item:** "any new state across requests goes through Redis or DB" — added to PR template.

## Trade-offs accepted

- **A schema key now, a one-liner later.** The `WORKER_ONLY` env-schema key exists from day one; the `workerMode` wiring itself is deferred to the scaling trigger (a one-line config change). Acceptable; trivial. *(amended 2026-07-04 — was "~30 lines of code"; native workerMode makes it a one-liner)*
- **ESLint rule adds review friction.** Occasional legitimate `fs.writeFile` use (e.g., generating a temp file) triggers the rule; needs explicit allowlist comment. Acceptable; surface is small.
- **Module-level `$state` discipline narrows allowed patterns.** Some convenient cross-component sharing patterns are blocked; alternatives (Svelte context, prop drilling, store-with-explicit-tab-scope) are slightly heavier. Acceptable trade.
- **Single-instance deployment means single point of failure at app layer.** Counter-balanced by: Railway auto-restart, healthcheck-based traffic management, zero-downtime deploys (per ADR-027), NFR43 alert on health failure.
- **CI multi-instance smoke is optional.** If not built, we trust the discipline rules alone. Recommended; build when convenient.

## Alternatives (one line each)

- **Deploy multi-instance from day one** — wastes compute at launch traffic; over-engineering for NFR36 budget.
- **Single-instance code; defer all horizontal work** — accepts the retrofit cost when triggers fire; loses the agentic-cheap-discipline win.
- **Force all state through Redis from day one** — over-engineered; in-request memoization is fine for performance.
- **Stateful sticky sessions** — accepts session-affinity coupling; rules out per-PR previews via Railway's load-balance assumption.

## Fallback paths

*If horizontal triggers fire and worker extraction is needed:* per the "horizontal scale triggers" table above, follow the documented path.

*If single-instance proves insufficient before horizontal extraction is engineered:* Railway's instance-size dashboard upgrade is the immediate lever (no engineering). Buys time while worker extraction is built.

*If discipline rules prove over-strict and slow legitimate development:* relax the ESLint rule to warning-only; rely on code review for the rule enforcement. Reversal: hours.

*If the future MCP server changes the horizontal-readiness math:* the MCP-readiness ADR (ADR-012) already assumes workflows-not-handlers; MCP doesn't change the horizontal calculus.

## References

- `architecture.md` § Step 4 Category 5 — "Scaling — vertical-first single-instance deployment + horizontal-ready code from day one" (archived 2026-07-18; current planning canon: cremerius-project/specs/)
- NFR35 (concurrent session capacity)
- NFR36 (single-instance launch)
- NFR50 (always-on)
- ADR-002 (Redis on Railway — Redis-BullMQ queue multi-instance-safe)
- ADR-023 (state management — module-level `$state` discipline)
- ADR-027 (Railway hosting topology)
- ADR-036 (env schema — `WORKER_ONLY` flag)
- ADR-041 (rollback & migration compatibility — expand/contract rule; pre-deploy migrate step)
- ADR-040 (CI/CD pipeline — orchestrates the migrate step)
- [Medusa v2 workflow engine](https://docs.medusajs.com/learn/fundamentals/workflows)

## Step 7 reconciliation (2026-06-07)

**NFR48 attainment (not just measurement).** 99.5% monthly uptime ≈ a 3.6h/month downtime budget. The single-instance posture (mandated by NFR36) provides no app-layer redundancy, so *attaining* the target rests on MTTR mitigations — Railway auto-restart, the ~3.5-min Better Stack alert (ADR-033), zero-downtime deploys, and auto-rollback (ADR-041) — keeping any incident well inside the budget; measurement is fully covered by Better Stack (≥2 geo, ADR-033).

**Pre-emptive lever.** Rather than waiting only for the reactive Hetzner switch trigger (Railway <99.5% over two consecutive months, ADR-027), if early Better Stack data shows the uptime margin is thin we set replica count to 2 (Railway dashboard) as the first remediation — the storefront is stateless and Medusa is horizontal-ready per this ADR, so it is a no-code-change dashboard move.

**Accepted residual risk.** At launch a single-instance app-layer outage between auto-restarts can consume uptime budget; accepted given NFR36 and the low-volume launch.

## Amendment (2026-07-04) — pre-development review

Four corrections applied in place:

- Worker extraction now uses Medusa v2's native `workerMode` (`server`/`worker`/`shared` in `medusa-config.ts`) instead of the hand-rolled `WORKER_ONLY` boot branch that skipped the HTTP listener. The `WORKER_ONLY` env var name is retained as the switch that sets the mode.
- Migrations rule pointer fixed: the rule is codified in ADR-041 (expand/contract, pre-deploy migrate command, rollback semantics), not "in ADR-040" — ADR-040 only orchestrates it.
- NFR label drift fixed: always-on is NFR50; NFR47 is zero-downtime deploys.
- Load-balancing attribution fixed: the Railway proxy balances replicas; Cloudflare does not.

**2026-07-19:** workerMode wiring honestly future (the `WORKER_ONLY` schema key exists unused; `medusa-config.ts` has no workerMode key until the scaling trigger); Fly.io reference replaced with Hetzner per ADR-027.
