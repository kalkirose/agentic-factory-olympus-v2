# ADR-048: Behavior-driven test strategy + full-regression story gate

**Status:** Accepted (2026-06-11)
**Deciders:** Kalki (directive), Claude (drafting)
**Category:** Quality / Process (cross-cutting — constrains every unit of work)
**Related:** ADR-026 (CI performance gate suite — the pipeline this strategy rides), ADR-040 (CI/CD workflows), ADR-022 (build target, gated by the WebKit project), ADR-024 (visual regression), ADR-025 (font loading), `architecture.md` § Step 3 ("exactly one way to validate work") (archived 2026-07-18)

## Context

The planned work was reviewed by a multi-agent panel before the [C] gate. The developer-agent review surfaced that the test *infrastructure* was implicit: CI gates were specified (ADR-026) but nothing stood up the three test runners; vacuous-pass gates could rot unproven; the Canvas has no deterministic verification harness. Separately, the user issued a directive:

> Behaviour-driven testing built into the build process. Documented so that every time a user story is taken, the full suite of tests is taken into account — no regressions, whether unit, integration, UI, etc.

Existing commitments were scattered: Vitest unit tests in Stage 1 (ADR-026), Playwright e2e/visual in Stage 2, the a11y stack (vitest-axe + @axe-core/playwright), the dev agent's "all tests pass 100%" principle, and the architecture's one-way-to-validate rule. Nothing bound them into a single policy that spec creation and spec execution (dev cycle) must honor.

**The timing question — define now or at build time?** Resolved: **policy first, machinery with the scaffold.** Acceptance criteria were about to be written; if ACs are authored as behaviors against this policy, the test suite grows as a direct projection of the requirements. Deferring the policy to build time means retrofitting test discipline onto ~100 prose-AC specs.

## Decision

**Behavior-driven acceptance testing with a full-regression gate, implemented on the native test runners (no Gherkin layer), defined as policy first and stood up as scaffold infrastructure.**

### 1. Acceptance criteria are the test contract

- Acceptance criteria are written in **behavior form** (Given / When / Then — or an equivalent observable-behavior phrasing) when the spec is created.
- Every AC maps to **at least one automated test** at the appropriate level. Test names/annotations trace the AC ID (e.g., `test("AC-1.7.1: /health/ready depth probe returns 200 with dependency keys", …)`), so coverage is greppable per spec.
- An AC that cannot be expressed as an automatable behavior is flagged in the spec as a **manual verification item** with an explicit checklist owner — the exception is documented, never silent.

### 2. The test pyramid (four levels, all first-class)

| Level | Runner | Scope | Lives |
|---|---|---|---|
| Unit / component | Vitest (+ vitest-axe for component a11y) | contracts schemas, pure logic, Svelte components (folder-per-component, co-located) | `packages/*`, `apps/storefront` |
| Integration | Medusa test-utils against **real Postgres** + Redis, in a container the environment supplies: the local compose service, the disposable per-run stack instance, or CI's service container | workflows, custom routes, modules, state machines | `apps/medusa` |
| E2E / UI | Playwright (+ @axe-core/playwright; visual regression ≤1%; Stage-2 perf/memory probes). Project set includes a **WebKit project** (Stage 2 + local) per the ADR-022 amendment — the real gate behind the `es2022` build target. The **commerce project** is the buy-path gate and runs in Stage 1 against a backend CI stands up (ADR-026). Visual/screenshot specs **await `document.fonts.ready`** before capture so metric-adjusted fallback fonts (ADR-025) never pollute baselines. *(amended 2026-07-04)* Every capture and every judgement of a visual baseline renders in **one pinned linux Playwright image**, so `{platform}` resolves to `linux` and the committed linux baselines are the only ones (ADR-026). | journeys, configurator canvas, checkout, admin widgets | `apps/storefront/tests`, tagged per ADR-040 (`@smoke`, etc.) |
| Contract / seam | Vitest consumer-driven contract tests | cross-boundary seams: AssetManifest (catalog pipeline → configurator), config snapshot (configurator → checkout/order/admin surfaces), analytics event payloads validated **at emit time**, error envelope | `packages/contracts` |

### 2a. The acceptance lane is separable from the gate lane

The acceptance tests for a unit of work live in a dedicated `acceptance/`
subtree of each test root — `packages/contracts/src/contract-tests/acceptance`,
`apps/storefront/tests/acceptance`, `apps/medusa/integration-tests/acceptance`.
They ride the same runners as the pyramid above; they add no level and no
framework.

- **One runner reads those trees: `pnpm test:acceptance`.** No other suite
  reaches them: each main configuration either excludes the subtree or matches
  a root that does not contain it, and every Playwright project but the
  acceptance one ignores it.
- **The runner is full-spectrum.** After the contracts build, which is a
  compile prerequisite and aborts the run when it fails, every framework runs
  even when an earlier one is red, and any red exits non-zero. An
  implementation pass needs the complete red set, not the first red.
- **An empty tree is green.** The lane exists before any unit of work fills
  it.
- **The file name routes the framework**, so a directory needs no per-file
  configuration and each root's README states its slice's contract.

*Why the separation:* the acceptance tests and the implementation are written
by different authors, and the two verdicts answer different questions — "does
this unit of work do what was specified" against "is the repository still
sound". If one suite read both trees, a red acceptance test would read as a
gate failure, and an author could satisfy a gate by weakening an acceptance
test. Separate trees plus one runner keep the verdicts independent without a
second test framework.

CI runs each slice in the job that already owns that slice's infrastructure,
so the lane adds no required check and no second way to stand up a backend.

### 3. No Gherkin/Cucumber tooling

Behavior-structured specs are written directly in the native runners. Rejected: Cucumber/Gherkin feature files — a translation layer with real maintenance cost and no second audience to justify it (the developer and AI agents both read code natively; the business-readable layer already exists as the story's AC text).

### 4. The full-regression gate

- A unit of work is **done only when the entire suite is green at every level** — unit, integration, e2e/UI, contract, a11y, visual. "Tests related to my change pass" does not close it.
- **No skipped test without a waiver, and the waiver lives at the skip it excuses.** A skipped, `todo`, `fixme` or `failing` declaration carries a structured comment block directly above it, naming what is not running and why, the re-enable condition that closes it, and a tracking reference: *(amended 2026-08-11)*

  ```ts
  // WAIVER(<key>): <what is not running, and why>
  // re-enable: <the condition that closes it>
  // ref: <tracking reference — an issue id, an ADR, or the runbook step>
  test.skip(...)
  ```

- **The traceability gate enforces it.** `scripts/check-test-traceability.ts` already walks every test file for AC-IDs and tier tags; it fails the build on a skip whose waiver block is missing or incomplete. No second gate, and no second place to look. `pnpm waivers` prints the live set by reading the annotations themselves.
- **Why the waiver is co-located and not a register.** A record kept apart from the thing it describes drifts, because nothing forces the two to change together: deleting a register entry is a separate act that nobody is obliged to perform. An annotation cannot drift — removing the skip removes the waiver in the same edit, and a skip that outlives its reason is read by anyone who opens the file. The cost is that the live set is a command rather than a document; that command reads the one source of truth instead of copying it.
- **Retired coverage is recorded by the decision that retired it.** When a decision deletes the code a behavior lived in, there is no skip to annotate — the tests are gone, not disabled. That case belongs in the ADR carrying the decision, beside the sentence that removes the code: the amendment which restores the behavior is the same edit that restores its coverage, so the two cannot separate. It is not a waiver in the sense above and is not counted as one.
- **New behavior without a test is not done.** The dev cycle's code-review step rejects work whose ACs lack traced tests.
- **Negative-fixture discipline:** every CI gate (bundle budgets, layer sizes, asset completeness, OpenAPI coverage, CSRF assertion, CVE scan, visual regression, commerce e2e) ships with a planted-violation fixture proving the gate *fails* when it should — proven when the gate lands, and re-proven when a vacuous-pass gate is activated by the surface it guards.
- **A non-zero exit is proof only when the gate actually ran.** `scripts/negative-fixture-harness.ts` reads a gate's non-zero exit as the gate rejecting its fixture, so it recognizes the deaths that are visible from outside the command — a signal, no exit code at all, a shell that could not execute the command (126/127) — and reports those as UNPROVEN, which fails the harness. Every other way to die before reaching the fixture is invisible from outside: an exit 1 from a server that never booted looks exactly like an exit 1 from a rejected fixture. A gate command that can die that way therefore owns the distinction and exits `PROOF_UNAVAILABLE` (77) itself; the harness reads 77 as UNPROVEN, never as OK.
- **A gate whose proof needs an environment keeps its own registry.** The commerce gate needs a real, *seeded* Medusa: a non-zero exit caused by a missing, unreachable or unseeded backend says nothing about the planted flow. Its entry lives in `fixtures/negative/commerce/registry.json`, which the CI job that owns that backend passes to the harness explicitly, and its runner verifies the seeded catalog answers for the captured key and reads the run's report before it calls the run a rejection. The repo-wide registry stays backend-free and runnable everywhere.
- **The negative fixture runs through the real gate, not a stand-in.** The commerce fixture is a planted broken flow executed by the commerce Playwright project itself — same project, same browser, same seeded preview — selected by redirecting that project's test directory at the fixture for that one run.

### 5. One way to validate (binding ADR-026/ADR-040 to the policy)

- Identical commands locally and in CI: `pnpm -r test`, `pnpm -r test:integration`, `pnpm -r test:e2e`, `pnpm -r typecheck`, `pnpm -r lint` — from day one in every package (starter-scaffold requirement).
- A suite that needs a backend has **one** command that behaves the same in both places, and that command owns everything the suite needs: `pnpm --filter storefront run test:e2e:commerce` provisions the fixtures through the single seed entry point, captures the publishable key, and exports it before the storefront is built and served. CI runs that command and adds no second path to either, so CI cannot drift from the local flow.
- The acceptance trees obey the same rule with their own single command, `pnpm test:acceptance` (§2a). It behaves the same locally and in CI, and CI invokes its slices rather than reimplementing them.
- `pr.yml` runs, on every PR, every suite whose answer the diff can move: Stage 1 hard-fail carries unit + integration + contract + gates + commerce e2e. Stage 2 (e2e/perf/visual per ADR-026) runs for a diff in the deploy run class; the same measurements run once per candidate image otherwise, in the pre-production check (ADR-064). The split is by what a red result can name, never by what is expensive: a check that cannot name the change under test does not belong on the merge path, and every check that can name it stays there.
- **AGENTS.md** encodes this policy for the dev agent: which suites run after which change types, the full-suite-green DoD, the waiver rule. The agent-facing statement of this ADR lives there.

### 6. Where this lands

- **Policy:** this ADR — every AC is authored against it.
- **Machinery:** the test substrate — three runners + one passing example test per level + CI wiring + the first negative fixtures — is in place. Pinned-image deterministic rendering is in place too, and it carries the storefront's visual baselines (ADR-026). The rest of the **Canvas verification harness** — the canvas goldens themselves and the Playwright+CDP memory/latency probes — is not yet implemented; it is decided and authored before the configurator canvas is built.

## Why this is the right call

**ACs-as-behaviors makes the suite a projection of the requirements.** With the functional and non-functional requirements already written in measurable form, behavior ACs close the loop: requirement → AC → traced test. Regression coverage then grows with each unit of work instead of being a separate workstream that lags the build.

**The full suite per unit of work is affordable at this scale and priceless for an agent-driven build.** A single reviewer of AI-agent output cannot personally re-verify prior behavior on every merge; the regression gate is the mechanism that makes "no regressions" true rather than aspirational. The architecture's anti-hallucination rule ("exactly one way to validate work") only works if that one way actually runs everything.

**Native-runner BDD keeps the layer count flat.** The minimize-software-layers rule applies to test tooling too: Gherkin would add a parser, step-definition glue, and a second source of truth for behavior text — for zero additional readers.

## Trade-offs accepted

- **CI wall time grows with the suite.** Accepted at launch scale; mitigated by Playwright tagging and parallel CI topology (ADR-040). See fallback path.
- **Behavior-form ACs are more work up front.** Accepted — the cost moves from "retrofitting tests forever" to "writing better ACs once."
- **Manual-verification escape hatch can be abused.** Mitigated: waivers and manual items are spec-visible artifacts, checked at code review.

## Alternatives (one line each)

- **Cucumber/Gherkin BDD stack** — translation layer with no second audience; rejected per minimize-layers.
- **Test-after e2e generation, batched later** — leaves regression gaps in between and decouples tests from ACs; retained only as a supplemental sweep, not the strategy.
- **Affected-scope testing from day one** — premature optimization; sacrifices the regression guarantee before the suite is even slow.

## Fallback path

If full-suite wall time degrades the delivery cycle (**switch trigger:** suite p50 exceeds ~15 minutes on PR, or CI wait dominates throughput), split execution: affected-scope (changed packages + their dependents via `pnpm -r --filter ...`) on PR, full suite on merge-to-main + nightly with auto-filed issues on regression. The *policy* (behavior ACs, traced tests, no-skip rule) is unchanged — only the gate's execution point moves. **Reversal cost: low** — CI workflow config only.

## Amendment (2026-07-04) — pre-development review

Two notes recorded from decisions D9 and D15; the strategy itself is unchanged:

- The Playwright suite includes a **WebKit project**, run in Stage 2 and locally (D9 / ADR-022 amendment). This is what makes the `es2022` build target's Safari claim a tested fact rather than an assumption; the ADR-022 re-eval trigger now points forward (to `esnext`) only with this gate green.
- The visual-regression/screenshot harness (the substrate setup, and the canvas harness when it lands) **awaits `document.fonts.ready` before capture** (D15 / ADR-025 amendment) — otherwise screenshots race the webfont swap and baselines flap between fallback and brand fonts.
