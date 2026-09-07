# ADR-058: Launch gate: env-armed coming-soon takeover; go-live = unset `LAUNCH_GATE`

**Status:** Accepted
**Date:** 2026-07-18
**Deciders:** Kalki, Claude
**Category:** Infrastructure & Deployment
**Related:** ADR-036 (env schema; `LAUNCH_GATE` is a typed optional), ADR-040 (`workflow_dispatch` production deploys), ADR-041 (post-cutover smoke + rollback), ADR-045 (checkout legal-compliance; records the Impressum's §5 DDG grounding as legal-page content), ADR-059 (per-product availability; the OTHER gate, see boundary below)

## Context

The production storefront has served a coming-soon takeover since the E1 launch sprint: with `LAUNCH_GATE=coming-soon` set on the storefront service, public routes other than `/` 302 to `/`, and `/` serves the coming-soon page with HTTP 200 (one canonical URL; deep links never render content). The one exception is the Impressum (`/impressum` and `/{locale}/impressum`): the German statutory imprint (§5 DDG, Impressumspflicht) is an always-on legal duty, so it stays reachable at HTTP 200 even while armed. A `__Host-` preview-bypass cookie (set via `PREVIEW_BYPASS_TOKEN`) lets the team browse the whole real site behind the gate. The mechanism is in `hooks.server.ts`, typed in the contracts env schema, and covered by gate tests, but no decision record carries it, and gated-mode obligations key off armed mode. Recording it stops the go-live mechanics from living only in code and one person's memory.

## Decision

- **The launch gate is the env contract `LAUNCH_GATE=coming-soon`** on the production storefront service. Armed, the public surface is exactly two routes: `/` serves the coming-soon takeover (HTTP 200), and the Impressum (`/impressum` and `/{locale}/impressum`) serves its content (HTTP 200); every other non-`/` public route 302s to `/`. The bypass cookie exempts the team for the whole site. The gate is presentation-level only: backend, admin, and deploy pipelines run normally behind it, which is what lets E3-E9 ship to production continuously before launch.
  - *Amended 2026-07-20 (Impressum carve-out):* the original decision served only `/` while armed. It was amended to carve out the Impressum as a second always-on public route, because the §5 DDG statutory imprint (Impressumspflicht) must be reachable at all times, including behind the coming-soon takeover; every other deep link still funnels to `/`. The route ships `<meta name="robots" content="noindex">`, so it is reachable but deliberately outside the indexable SEO surface. ADR-045 records the same imprint's §5 DDG grounding (as legal-page content).
- **Gated-mode obligations while armed:**
  - the takeover page mounts VisitorEmailCapture wired to double opt-in;
  - SEO surfaces are gated-mode-ACCURATE, never aspirational: sitemap, robots, and llms.txt describe the intended indexable surface, not merely what returns HTTP 200 — the Impressum is reachable but `noindex`, so it stays out of them;
  - test transactions only until E9 closes (no real payment keys behind the gate).
- **Go-live is a configuration cutover, not a deploy:** at the go-live step, after every checklist item carries evidence, the operator unsets `LAUNCH_GATE` on the production storefront service (the manual `workflow_dispatch` posture per ADR-040 governs any accompanying deploy). Post-cutover smoke runs immediately with rollback armed (ADR-041 launch-surface list); partner sign-off closes.
- **Boundary against ADR-059:** `LAUNCH_GATE` is the whole-site takeover and is unset exactly once at go-live. Per-product gating (which products are purchasable after launch) is the ADR-059 availability map and never reuses this flag.

## Why this is the right call

**Un-gating must be cheaper and safer than deploying.** A go-live that requires a code deploy couples the highest-stakes moment to the largest failure surface. An env unset changes one value, takes effect on restart, and reverses identically.

**Accuracy over aspiration in gated mode.** A sitemap or llms.txt describing pages the gate hides is an indexing lie that outlives the gate; binding the SEO surface to gated-mode accuracy keeps the pre-launch surface honest and makes the go-live flip a content change search engines can follow.

**The imprint is legally always-on.** A coming-soon site still fronts a trading company, and §5 DDG (Impressumspflicht) requires the statutory imprint to be reachable at all times. So the armed takeover carves out the Impressum rather than 302-funnelling it to `/`; it is the one content page the gate lets through. The route carries `noindex`, keeping the imprint reachable without adding an indexable page to the pre-launch surface. ADR-045 records the same §5 DDG duty from the checkout-compliance side (as legal-page content).

**The gate is already field-proven.** It has served production since the E1 sprint; this ADR adds the decision record and the go-live procedure, not new machinery.

## Trade-offs accepted

- **One env var is load-bearing at the highest-stakes moment.** Mitigated: typed in the env schema, covered by gate tests in both armed states, and the unset is rehearsed as a go-live checklist step.
- **The bypass token is a shared secret.** Rotated per the ADR-037 cadence; scope is presentation-only (no data access beyond what launch will make public anyway).

## Alternatives (one line each)

- **DNS/edge-level splash page**: puts the gate outside the app where the bypass, tests, and SEO accuracy cannot be exercised by CI; rejected.
- **Deploy-to-launch (gate compiled in)**: couples go-live to a build; rejected.
- **Feature-flag service**: a vendor for one boolean; rejected on minimize-layers.

## Fallback path

Re-arm the gate: set `LAUNCH_GATE=coming-soon` on the production storefront service. The site returns to the takeover within one restart; commerce state is untouched.

**Switch triggers:** post-cutover smoke failure that image rollback (ADR-041) does not cure; a legal or compliance stop order at or after go-live.

**What we lose:** public availability, temporarily. Orders already placed are unaffected (the backend keeps running).

**Reversal cost:** low. One env change plus the post-change smoke run.

## References

- `apps/storefront/src/hooks.server.ts` (gate implementation, incl. the Impressum carve-out `isImpressumPath`), `apps/storefront/src/routes/[lang=lang]/(legal)/impressum/+page.svelte` (imprint content; `noindex`), `packages/contracts/src/env.ts` (`LAUNCH_GATE`)
- ADR-036, ADR-040, ADR-041, ADR-045, ADR-059
