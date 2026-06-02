# Credit Banc Vault

Credit Banc Vault is the internal platform Credit Banc uses to take a business owner from "I need capital" to "funded." It is a document-collection vault, an onboarding funnel, a deal pipeline, and an underwriting workspace, all stitched together with the CRM (GoHighLevel), e-signatures (SignWell), team comms (Slack), and email.

This README is the onboarding doc for new developers. It covers what the app does, how it's built, the domain model you'll work in every day, and how to run it locally.

---

## 1. What the app does (by role)

There are **four user roles**. Role lives on the `users.role` column and decides which dashboard a person lands in.

| Role | Lives in | What they do |
|---|---|---|
| **client** | `/dashboard` | The business owner. Completes onboarding, uploads required documents into their vault, signs the contract, follows their funding progress, and uses the Finance Academy. |
| **advisor** | `/advisor` (and `/admin/advisor`) | The sales/relationship rep. Creates clients, manages their pipeline & prospects, chases missing documents, submits the vault for underwriting. Advisors can also **follow** clients they don't own to stay in the loop. |
| **underwriting** | `/underwriting` | Reviews submitted files, runs bank analysis, matches deals to lenders against lender guidelines, and submits to lenders. |
| **admin** | `/admin` | Full visibility. Superset of advisor + underwriting, plus seeding lenders, managing all clients, and the global dashboard/funnel. |

The core journey: **advisor creates a client → client gets a magic link → onboarding (business info + contract via SignWell) → client uploads docs → advisor submits vault → underwriting reviews & matches lenders → deal is submitted and funded.** Throughout, data is mirrored to GoHighLevel and deal activity is posted to Slack.

---

## 2. Tech stack

- **Next.js 16** (App Router, React Server Components, Server Actions) + **React 19**
- **TypeScript** (strict), path alias `@/* → ./src/*`
- **Supabase** — Postgres + Auth + Storage. SSR auth via `@supabase/ssr`.
- **Tailwind CSS 3** + **shadcn/ui** (Radix primitives in `src/components/ui`)
- **Framer Motion**, **Recharts**, **lucide-react**, **sonner** (toasts), **driver.js** (product tours)
- **@react-pdf/renderer** for generated PDFs
- **Deployed on Vercel** (cron jobs defined in `vercel.json`)

### Key integrations (all in `src/lib`)
| Lib | Integration | Purpose |
|---|---|---|
| `ghl-api.ts`, `ghl-document-sync.ts` | **GoHighLevel** CRM | Mirror client/business data and document status to GHL custom fields; trigger GHL workflows (SMS) via tags. |
| `signwell.ts` | **SignWell** | Generate and track the funding contract e-signature envelope. |
| `slack-api.ts` | **Slack** (Enterprise Grid) | Create a per-deal channel and post deal activity. |
| `email.ts` | **SMTP / Mailgun / nodemailer** | Welcome emails, credentials, password resets, document reminders. |
| `magic-link.ts` | — | Passwordless onboarding entry links. |

---

## 3. Project structure

```
src/
├── app/
│   ├── page.tsx                # Public landing page
│   ├── layout.tsx              # Root layout
│   ├── auth/                   # Login, sign-up, magic-link callbacks, password set/reset
│   ├── onboarding/             # Client onboarding funnel
│   ├── dashboard/              # CLIENT area (vault, business profile, finance academy)
│   ├── advisor/                # ADVISOR area (dashboard, pipeline, prospects, clients)
│   ├── underwriting/           # UNDERWRITING area (bank analysis, lender match, guidelines)
│   ├── admin/                  # ADMIN area (superset; clients, pipeline, uw, advisor views)
│   ├── support/
│   ├── actions/                # Server Actions (advisor, pipeline, notes, notifications)
│   └── api/                    # Route handlers (see below)
├── components/
│   ├── ui/                     # shadcn/ui primitives
│   ├── admin/ advisor/ onboarding/ notifications/ pdf/ tour/ layout/
├── lib/
│   ├── supabase/               # client.ts, server.ts, admin.ts, middleware.ts
│   ├── auth/                   # require-admin.ts, require-staff.ts (role gates for API routes)
│   ├── ghl-*.ts signwell.ts slack-api.ts email.ts magic-link.ts
│   ├── client-access.ts        # owner / follower / admin access checks
│   ├── document-scope.ts       # personal-identity vs business-scoped docs
│   └── outstanding-documents.ts followers.ts user-management.ts utils.ts
├── data/                       # Static reference data (loan-types, referral-partners)
├── hooks/  types/
supabase/migrations/            # SQL migrations (chronological)
docs/                           # Design / refactor planning docs
DB.sql                          # Full schema dump (handy reference)
```

### Notable API routes (`src/app/api`)
- `onboarding/*` — submit steps, generate/sync/download contract, complete onboarding
- `vault/*` — requirements, submit, mark-submitted
- `webhooks/*` — `signwell-contract` (signature events), `ghl-tags`, `contract-generated`
- `cron/*` — `send-document-reminders`, `resend-magic-link` (triggered by Vercel cron)
- `slack/create-channel`, `lender-assignments/[id]/submit`, `post-signup*`, `client-signup`

---

## 4. Domain model (read this before touching the DB)

The data model is a **three-level hierarchy**. This is the single most important thing to understand:

```
client_data_vault   (the human / customer)        — 1 per customer
  └─ business_profiles  (a business they own)      — N per client
       └─ funding_deals  (a specific loan/application) — N per business
```

A client can own multiple businesses; each business can have multiple funding deals over time (a renewal, a second SBA round, working capital two years later). Deal-specific tables — `user_documents`, `client_dynamic_documents`, `loan_status_history`, `submissions`, `document_category_approvals`, `client_lender_assignments`, `bank_analysis_results` — FK to **`funding_deals.id`** (and usually also carry `business_profile_id` for convenience). `client_open_positions` is the exception: it's business-scoped (existing debt of the business, not one of our deals).

> See `docs/multi-business-refactor-plan-funding-deals-addendum.md` for the full rationale behind this model. Some areas may still be mid-migration (dual-writing legacy columns) — check the migration order in `supabase/migrations/` if a column seems duplicated.

### Document scoping
`src/lib/document-scope.ts` distinguishes **personal-identity docs** (one driver's license / credit report / PFS per human, shared across all their businesses) from **business-scoped docs** (bank statements, P&L, etc. collected per business). Don't ask a multi-business client to re-upload their license.

### Pipeline / status
A deal's status lives in `loan_status_history` (append-only). Helpers like `getBulkLatestStatus` roll these up for pipeline views.

### Other key tables
`advisors`, `client_followers` (advisors following clients they don't own), `lender_guidelines`, `required_documents` / `required_documents_for_type`, `academy_modules` / `academy_lessons` (Finance Academy), `in_app_notifications`.

---

## 5. Auth & access control

- **Session**: Supabase SSR. `src/lib/supabase/middleware.ts` refreshes the session on every request and redirects unauthenticated users (outside `/`, `/login`, `/auth/*`) to `/auth/login`. **Never put code between `createServerClient` and `auth.getUser()`** in middleware — it causes random logouts (the file is commented to this effect).
- **Three Supabase clients**: `client.ts` (browser, anon key), `server.ts` (RSC/route, anon key + cookies), `admin.ts` (service role, **server-only**, bypasses RLS — use carefully).
- **Role gates for API routes**: `requireAdmin()` (admin only) and `requireStaff()` (admin OR underwriting). They return `{ ok: true, user, role }` or `{ ok: false, response }`:
  ```ts
  const gate = await requireStaff();
  if (!gate.ok) return gate.response;
  const { user, role } = gate;
  ```
- **Client-record access**: `checkClientAccess` / `assertCanAccessClient` in `client-access.ts` — access = owner advisor OR follower OR admin.

---

## 6. Local development

### Prerequisites
- Node.js 20+
- A Supabase project (URL + keys)
- Credentials for the integrations you'll touch (GHL, SignWell, Slack, SMTP) — many features no-op gracefully if their env vars are missing, so you can run without all of them.

### Setup
```bash
npm install
cp .env.example .env.local   # if no example exists, ask a teammate for the env keys
npm run dev                  # http://localhost:3000
```

### Scripts
| Command | What |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run start` | Run the production build |
| `npm run lint` | ESLint (next lint) |

### Environment variables
The app reads ~100 env vars (see `.env` for the authoritative list). Grouped:

- **Supabase**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`
- **App**: `NEXT_PUBLIC_APP_URL`, `CRON_SECRET` (guards cron routes)
- **GoHighLevel**: `GHL_TOKEN`/`GHL_API_KEY`, `GHL_BASE`, `GHL_LOCATION_ID`, `GHL_WEBHOOK_SECRET`, and a large family of `GHL_CF_*` custom-field IDs (one per data point/document) plus tag fields (`MAGIC_LINK`, `RESET_PW_LINK`, `OUTSTANDING_DOCUMENTS`, …)
- **SignWell**: `SIGNWELL_API_KEY`, `SIGNWELL_TEMPLATE_ID`, `SIGNWELL_PTL_TEMPLATE_ID`, `SIGNWELL_WEBHOOK_SECRET`
- **Slack**: `SLACK_*` tokens + per-person `*_SLACK_ID`s
- **Email/SMTP**: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`

> `.env` is git-ignored and contains live secrets. Get a copy from a teammate; never commit it.

### Database
- `DB.sql` is a full schema dump — the fastest way to understand tables/columns.
- `supabase/migrations/` holds incremental migrations, named by date. Apply new schema changes as a migration here (don't hand-edit production).

### Cron jobs (Vercel)
Defined in `vercel.json`; they hit guarded API routes:
- `0 13 * * *` → `/api/cron/send-document-reminders`
- `0 14 * * *` → `/api/cron/resend-magic-link`

To run locally, call the route with the `CRON_SECRET` header (see the route handler for the exact check).

---

## 7. Conventions & gotchas

- **Path alias**: import from `@/...` (maps to `src/`), not relative `../../..`.
- **Server vs client**: default to Server Components; add `"use client"` only when you need interactivity. Mutations go through Server Actions (`src/app/actions`) or API route handlers.
- **Service-role client is dangerous**: `supabase/admin.ts` bypasses Row Level Security. Only use it server-side and only when you've already authorized the caller.
- **Integrations are best-effort**: email/Slack/GHL helpers are written to fail soft (e.g. `followers.ts` returns `[]` on error) so a CRM hiccup never blocks the core flow. Preserve that pattern.
- **Always scope by `funding_deal_id`** when querying deal-level tables — forgetting it is the easiest way to leak data across a client's multiple deals.
- **GHL custom fields are ID-driven**: the mapping from internal doc codes / fields to GHL field IDs lives in env (`GHL_CF_*`) and `ghl-document-sync.ts`. Add a new synced field in both places.

---

## 8. Where to start reading

1. `src/lib/supabase/middleware.ts` — how auth/session works on every request.
2. `src/lib/client-access.ts` + `src/lib/auth/*` — the authorization model.
3. `DB.sql` + the addendum in `docs/` — the data model.
4. `src/app/onboarding/` and `src/app/api/onboarding/` — the client funnel end to end.
5. `src/app/advisor/dashboard/pipeline/` — the advisor's daily workspace.

Welcome aboard. 🚀
