# ADR-020: Sanity CMS pattern + Cloudflare cache-purge integration

**Status:** Accepted
**Date:** 2026-07-18
**Deciders:** Kalki, Claude
**Category:** API & Communication
**Related:** ADR-007 (CSP `img-src` allows `cdn.sanity.io`), ADR-029 (R2 storage; the Sanity CDN carries editorial), ADR-030 (cache-purge Worker)

## Context

Editorial content (homepage hero copy, atelier story, journal posts, FAQ, legal pages, site settings like nav copy) needs:
- Operator-editable surface (Felix, Jenny, occasional outside content contributors)
- EN/DE bilingual content with per-locale routing
- Image asset hosting + transformation (variants per breakpoint, optimized formats)
- Storefront delivery latency of 5 minutes or less from publish
- EU residency posture
- Free-tier coverage at launch (cost-conscious)

The choice space narrows quickly:
- WordPress / Drupal: wrong paradigm; we're headless.
- Contentful: mature; account data US-based; pricing escalates fast.
- Strapi: self-hosted; ops burden conflicts with <1hr/week.
- Storyblok: visual editor; EU available; pricing reasonable but the per-seat model is awkward for our team shape.
- Sanity: TypeScript-native schemas; structured editor (no visual WYSIWYG); EU data storage; free tier that covers launch needs.
- Payload CMS: self-hosted; same ops trade-off as Strapi.

Sanity wins on stack alignment (TypeScript-native schemas in a TypeScript-everywhere project) and on free-tier coverage.

The integration design then needs to handle: GROQ query layer, document-level i18n, cache invalidation latency, image CDN, schema-to-types pipeline, Studio hosting.

## Decision

**Use Sanity as the CMS** with the following integration pattern:

- **Free tier** at launch. Binding seat and quota entitlements are captured against the live Sanity dashboard when the project is provisioned, and recorded here then; see "Entitlement facts" below.
- **EU residency:** Sanity's Content Lake stores all project data in Belgium (Google Cloud, St. Ghislain) by default; region selection exists only as an Enterprise-negotiated option, so the Belgium default is what non-Enterprise plans get. The global piece is the delivery CDN (`cdn.sanity.io`), which is content distribution, not data residency.
- **Dataset ACL, two postures.** The `production` dataset is PUBLIC read while the project is on the free tier (owner approval 2026-08-30): the free tier carries public datasets only, so a private ACL is not available to buy at this stage. Every build-time and SSR read therefore succeeds without a token today. The launch posture is a PRIVATE ACL with token-only server reads, and it is flipped just before launch together with the paid-plan upgrade that makes a private dataset possible. Until that flip the read token is exercised by CI and by the server client, but it is not the access boundary: anyone who knows the project id can read the dataset. Nothing editorial in the dataset may assume secrecy before the flip.
- **GROQ queries** (Sanity's native query language) over their GraphQL: smaller queries, no schema-introspection overhead.
- **Schemas** in `apps/studio/schemas/` as TypeScript code, version-controlled. The Studio, its plugins and the schema list are one workspace package of their own, `apps/studio`; the storefront never carries them.
- **Complete launch schema set at birth.** The Sanity foundation ships every routed document type when it lands, including the LL drop-narrative type, `legalPage`, and `accessibilityStatement`, with document-level EN/DE i18n and codegen into the storefront's generated types file behind the drift gate. No routed type is added later. The purge map's build-time drift guard checks against this same schema registry, which is what makes the complete-purge-map-at-birth guarantee (ADR-030) checkable. The schema set is not yet implemented; the rule holds for the build that creates it.
- **TS types** generated from schemas via Sanity's first-party `sanity typegen` (GA and the recommended pipeline; the third-party `ricokahler/sanity-codegen` it supersedes is not used) into `apps/storefront/src/lib/sanity.types.ts`, with a drift gate keeping the committed file equal to the generator's output.
- **i18n via `@sanity/document-internationalization`**: document-level (separate documents per EN/DE locale, not field-level translations).
- **Sanity Client SDK** consumed server-side only (the server-only import discipline).
- **Editorial images** served from `cdn.sanity.io` (Path A): no custom upload handler.
- **`useCdn: false` on SSR load paths that feed edge-cached pages** (see How it works).
- **Publish reflected live in 5 minutes or less** via Sanity publish webhook → Cloudflare Worker cache-purge (ADR-030). The purge worker proves that publish-to-live path end to end.
- **Sanity Studio** hosted on the Sanity-managed URL at launch (`<project>.sanity.studio`), deployed from `apps/studio` by that package's `deploy` script; self-hosting under `studio.cremeriusequestrian.com` deferred until branding pressure justifies it.

### Entitlement facts

Recorded free-tier seat and quota figures varied between documentation checks. The 2026-07-19 primary-source check reads: **20 user seats** (earlier checks recorded 3), 2 public datasets, 10k documents, 1M API CDN requests/mo, 250k API requests/mo, 100 GB bandwidth and 100 GB assets. Per the standing verification rule (vendor entitlements are checked against the live dashboard at provisioning, never doc-vs-doc), the binding numbers, including seat roles and API-request quota, are still captured when the project is provisioned and recorded here then. Until then, the seat and quota figures above are not current and nothing may cite them as such.

### What is implemented today

The Sanity project exists and the credential seam is live: `PUBLIC_SANITY_PROJECT_ID`, `PUBLIC_SANITY_DATASET` and the server-only `SANITY_API_TOKEN` are declared in the env schema, reach the storefront service, and reach preview hosts as a read-scoped trio (ADR-054). The CSP allows `cdn.sanity.io` as an image source (ADR-007).

The substrate under the schema set is in place:

- `apps/studio` is a workspace package holding `sanity`, `@sanity/document-internationalization`, `sanity.config.ts`, `sanity.cli.ts` and the schema list. It reads the same project and dataset pair the storefront reads, and it deploys to the managed Studio address by its own `deploy` script. Nothing imports it: the React peers it needs are its own, and no other package resolves them.
- The schema list at `apps/studio/schemas/index.ts` is empty. The internationalization plugin covers that list rather than a hand-kept copy of it, and it stands down while the list is empty because the plugin refuses an empty type set.
- `apps/storefront` depends on `@sanity/client` and `@sanity/image-url` and on nothing else from Sanity. The medusa application depends on none of them.
- `apps/storefront/src/lib/sanity.types.ts` is the generated types file, committed, and `pnpm gate:sanity-typegen` holds it equal to a fresh run of `pnpm --filter studio typegen`. The gate reads the tree alone: it needs no project, no token and no network, and it restores the committed bytes before it reports, so a red gate leaves the tree as it found it. A planted fixture carries a recorded drifted pair and proves the gate is not vacuous.
- A `no-restricted-imports` ban keeps `@sanity/client` and `@sanity/image-url` out of every module that can reach the browser bundle. The two allowed surfaces are `apps/storefront/src/lib/server/**` and the SvelteKit server-only route files (`+page.server.ts`, `+layout.server.ts`, `+server.ts`). Subpath specifiers are banned with the bare ones. A planted fixture proves that ban too.

Where the drift gate runs: the pull-request workflow runs it in the storefront build job. It is not on the local Stage-1 aggregate, and not because it fails that list's rule of reading the tree alone. It regenerates the types through the studio package, which costs about fifty seconds, and the substrate pin that runs the aggregate caps that command at 240 seconds. It is not a named layer of the dev harness either, because the harness reaches gate layers through a settings file that no implementation lane may edit. Two consequences follow, and both are worth stating plainly. A local Stage-1 run does not answer for type drift, so the author runs `pnpm gate:sanity-typegen` beside it. And the pull-request path filter that decides whether the storefront build job runs at all does not name `apps/studio`, so a change confined to the schema list, with no regenerated types beside it, does not reach the gate on that pull request.

**Not yet implemented:** the launch document types themselves, the routed-type registry the purge map checks against, the content client module and its GROQ queries, the draft preview, the publish webhook, and the Studio deployment. Each is decided above and built when the editorial content work lands. Until then the storefront renders no Sanity-sourced document, and the read token is wiring rather than a live read path.

## Why this is the right call

**TypeScript-native schemas match the rest of the stack.** Sanity schemas are TS files in our repo: type-checked, version-controlled, PR-reviewable. Compared to "schema in a SaaS UI" CMSes (Contentful, Storyblok), changes flow through the same git workflow as code, with no schema drift between environments.

**Document-level i18n matches the editorial workflow.** Field-level translations (one document with `title.en` and `title.de`) look cleaner but break when documents need structurally different content per locale (different page sections, different image arrangements). Document-level (two documents linked by a `translation` reference) is more flexible and matches how the partners will author bilingual content.

**GROQ over GraphQL fits our access patterns.** GROQ is Sanity's native query language; queries are smaller and faster. We have no third-party consumers needing GraphQL.

**The complete schema set at birth removes a whole class of drift.** Every routed type existing from the first Sanity build means the purge map (ADR-030), the sitemap rules, and the contracts types are all generated against one registry that never grows mid-launch. A new page that needed a new routed type would be a scope change, not a schema patch.

**Image CDN bundled is a feature of an already-locked vendor.** Sanity's `cdn.sanity.io` plus their image transformation API (`?w=800&fit=crop&fm=webp`) removes the need for a custom upload handler. Per the project rule "separate each sub-service and justify independently": the Sanity image CDN is the same vendor, accepted as a sub-feature, with the upgrade path (Path B: migrate editorial to R2) documented in ADR-029.

**Webhook → CF Worker → cache purge meets the 5-minute target.** Sanity publishes fire a webhook; the Worker authenticates it and maps the published document type to storefront URLs to purge from the Cloudflare cache. Typical end-to-end latency is under a minute, well inside the 5-minute target. ADR-030 covers the Worker design.

**Server-side-only import discipline keeps editorial logic out of the client bundle.** All `@sanity/client` and `@sanity/image-url` imports live in `+page.server.ts` / `+layout.server.ts` / `src/lib/server/**` only. The client receives pre-resolved image URLs and text content as strings. A lint rule enforces this.

**No Medusa ↔ Sanity coupling.** Editorial in Sanity; commerce/product in Medusa; the storefront joins. This separation respects domain boundaries (editorial workflow is not catalog workflow) and avoids cross-vendor data integrity coordination.

**Sanity Studio on the Sanity URL is good enough at launch.** The partners are the only Studio users; their experience is feature-driven, not chrome-driven.

**The shop never carries an editing application it does not run.** The Studio is React, styled-components and a plugin set; the storefront is Svelte and serves customers. Holding the two in one package would put the whole editing surface in the shop's dependency tree, its lint scope, its typecheck and its build, for code the shop never loads. Splitting them means the storefront's Sanity surface is two packages wide, the read client and the image helper, and a reader can see that from its manifest. The generated types file is the one thing that crosses, and it crosses as generated output under a gate rather than as an import.

## How it works

**Schema authoring (`apps/studio/schemas/`):**

```ts
// homepage.ts
import { defineType, defineField } from "sanity"

export const homepage = defineType({
  name: "homepage",
  type: "document",
  fields: [
    defineField({ name: "heroHeading", type: "string", validation: r => r.required() }),
    defineField({ name: "heroBody", type: "blockContent" }),
    defineField({ name: "heroImage", type: "image", options: { hotspot: true } }),
    // ... etc
  ],
  // Restricting document actions, if wanted, is done via `document.actions`
  // in defineConfig. Document-level i18n comes from the
  // documentInternationalization plugin (see config below).
})
```

**Studio configuration (`apps/studio/sanity.config.ts`), illustrative:**

```ts
export default defineConfig({
  name: "cremerius",
  title: "Cremerius CMS",
  projectId: process.env.PUBLIC_SANITY_PROJECT_ID!,
  dataset: process.env.PUBLIC_SANITY_DATASET!,
  plugins: [
    deskStructure(),
    documentInternationalization({
      supportedLanguages: [{ id: "en", title: "English" }, { id: "de", title: "Deutsch" }],
      schemaTypes: [/* every routed type in the registry */]
    }),
    visionTool()  // for ad-hoc GROQ queries during development
  ],
  schema: { types: [/* the complete launch schema set */] }
})
```

The authoritative type list is the schema registry: every routed launch document type (homepage, journal post and index, category/coming-soon content, FAQ, Impressum/legal pages, accessibility statement, the LL drop-narrative type, site settings, and the editorial page types), all with document-level EN/DE i18n.

**Client (`apps/storefront/src/lib/server/sanity.ts`, server-only):**

```ts
import { createClient } from "@sanity/client"

export const sanity = createClient({
  projectId: process.env.PUBLIC_SANITY_PROJECT_ID!,
  dataset: process.env.PUBLIC_SANITY_DATASET!,
  apiVersion: "2026-01-01",  // pin
  // useCdn FALSE on SSR load paths that feed edge-cached pages. Cloudflare
  // purge-on-publish clears OUR edge cache, but Sanity's API CDN is
  // stale-while-revalidate with no fixed staleness bound: a purged page could
  // re-render and re-cache stale HTML. Fresh reads from the origin API keep
  // the purge meaningful; Cloudflare remains the caching layer.
  useCdn: false,
  token: process.env.SANITY_API_TOKEN  // server-only; not exposed to client
})

import imageUrlBuilder from "@sanity/image-url"
const builder = imageUrlBuilder(sanity)
export function urlFor(source: SanityImageSource) {
  return builder.image(source).format("webp").auto("format")
}
```

**Query in a load function (`+page.server.ts`):**

```ts
import { sanity, urlFor } from "$lib/server/sanity"

export const load: PageServerLoad = async ({ params, locals }) => {
  const locale = locals.locale  // "en" | "de"
  const homepage = await sanity.fetch(
    `*[_type == "homepage" && language == $locale][0]`,
    { locale }
  )
  return {
    homepage: {
      ...homepage,
      heroImageUrl: urlFor(homepage.heroImage).width(1600).url()  // server-resolved
    }
  }
}
```

**Type generation (`apps/storefront/src/lib/sanity.types.ts`, generated):**

- `pnpm --filter studio typegen` extracts the schema from `apps/studio` and then runs `sanity typegen generate` (first-party Sanity CLI) into the storefront file.
- Output: TS types like `HomepageDocument`, `JournalPostDocument`, etc.
- The storefront imports types from this generated file and from nowhere else in Sanity.
- `pnpm gate:sanity-typegen` regenerates and compares. A committed file that differs from the studio package's output fails the build, and the gate restores the committed bytes so the author regenerates on purpose.
- The generator writes its own layout, unformatted by the repository's prettier, because prettier would be resolved from the studio package against the storefront's configuration, which names plugins that package does not carry. The storefront's prettier ignores the file for that reason.
- Client-method overloading stays off. It would augment `@sanity/client` from inside the generated file, and that import is banned outside the storefront's server modules.

**Webhook → CF Worker (ADR-030):**

- Sanity publish/unpublish → webhook to `https://purge.cremeriusequestrian.com/sanity`.
- Worker authenticates via `SANITY_WEBHOOK_SECRET` HMAC.
- Maps document `_type` to a URL list generated from the schema registry, then calls the Cloudflare Cache Purge API.
- Webhook payload projections that include the slug must flatten it (`"slug": slug.current`), because `slug` is an object (`{ _type, current }`) and an unflattened projection turns purge URLs into `/journal/[object Object]`.
- Returns 200; Sanity retries on non-2xx.
- ADR-030 covers the full design, including the complete-purge-map-at-birth guarantee.

**Image delivery:**

- Editorial images served from `cdn.sanity.io` (Path A).
- CSP `img-src` allows `cdn.sanity.io` (ADR-007).
- Image URLs constructed server-side via `urlFor()` (above).
- Client `<picture>` with `srcset` from Sanity URL variants (400 / 800 / 1200 / 1600w).
- AVIF → WebP → JPEG fallback chain via `<source type="...">`.

## Trade-offs accepted

- **No visual WYSIWYG editor.** Sanity's structured editor is form-based; partners author by filling fields and pasting pre-drafted prose from Notion/Docs. Acceptable: partners are not designers; structured editing is faster and reduces formatting bugs.
- **Schemas live in this repository.** Coupling: a schema change is a pull request here, and it drags the regenerated types with it or the drift gate stops it. Acceptable for a small, Sanity-aware team. A separate `sanity-schemas` repository would be over-engineering.
- **The Studio's dependency tree is heavy.** `apps/studio` pulls Sanity, React, React DOM and styled-components into the workspace install, and every install pays for them. Accepted: they are confined to one package that no other package imports, no shipped image installs it, and the alternative is the editing application inside the shop.
- **`useCdn: false` on SSR loads trades Sanity-CDN read speed for purge correctness.** With `true`, a Cloudflare purge could re-cache stale HTML rendered from Sanity's still-stale API CDN, silently defeating the 5-minute mechanism. Origin-API reads are slower per request, but those reads happen only on cache MISS after a purge; Cloudflare serves everything else. Quota headroom is confirmed against the live figures captured at provisioning.
- **Two image CDNs in production** (`assets.cremeriusequestrian.com` for R2 + `cdn.sanity.io` for editorial). One extra CSP `img-src` entry vs zero custom upload code. The "minimize layers" rule is judged satisfied because the Sanity image CDN is a sub-feature of an already-locked vendor.
- **Sanity Studio hosted on the Sanity URL.** Branding inconsistency; acceptable at launch.
- **A publicly readable production dataset before the launch flip.** The free tier offers no private dataset, so pre-launch editorial content is readable by anyone who knows the project id. Accepted because the dataset holds only marketing copy and imagery destined for a public site. The mitigation is the flip itself: the private ACL and the paid plan land together, before any content that is not already public goes in. The token/server-only pattern below is written for the post-flip posture and does not change at the flip.

## Alternatives (one line each)

- **Contentful**: mature; account data US; pricing scales fast; field-level i18n is the standard pattern; more polished than Sanity but less stack-aligned.
- **Storyblok**: visual editor strength; per-seat pricing awkward; EU available.
- **Strapi (self-hosted)**: ops burden conflicts with the <1hr/week budget.
- **Payload CMS**: TypeScript-native like Sanity; self-hosted; ops trade-off.
- **Tina CMS**: git-backed; visual editor; smaller ecosystem; unclear staying power.
- **Sanity paid tier from day one**: overkill at launch volume; re-evaluated against the live entitlement figures at provisioning.
- **No CMS, editorial in storefront markdown files**: kills partner-authoring autonomy; rejected on UX.

## Fallback path

If Sanity proves problematic (data residency tightens, pricing changes, free-tier limits hit prematurely, or the partner workflow rejects the structured editor), switch to **Storyblok EU**.

**Switch triggers:**
1. Sanity moves primary storage out of the EU or makes EU residency a paid feature
2. Free-tier API request limit (per the quota recorded at provisioning) hit consistently, with upgrade cost exceeding Storyblok's equivalent
3. Partner workflow rejects structured editing; visual WYSIWYG demanded
4. Sanity policy change affects content-modeling flexibility

**What we lose:** TypeScript-native schemas (Storyblok schemas are JSON in their UI); GROQ queries.

**Reversal cost:** Storyblok schemas re-authored from the current Sanity schemas (1:1 mapping for most types). Content re-imported via Storyblok's import API. Storefront load functions rewritten for the Storyblok client. Image URLs migrate to Storyblok's image CDN. The CF Worker (ADR-030) gets a Storyblok-specific publish-webhook handler; the purge map and drift guard carry over against the same route set.

## References

- ADR-007 (CSP `img-src` includes `cdn.sanity.io`)
- ADR-029 (Object storage + image CDN; Path A keeps editorial on the Sanity CDN, this ADR is the editorial half of that decision)
- ADR-030 (Sanity webhook → Cloudflare Worker cache-purge, the mechanism behind the 5-minute target)
- [Sanity documentation](https://www.sanity.io/docs)
- [`@sanity/document-internationalization`](https://www.sanity.io/plugins/document-internationalization)
- [`sanity typegen`](https://www.sanity.io/docs/sanity-typegen)
- [GROQ language](https://www.sanity.io/docs/groq)
