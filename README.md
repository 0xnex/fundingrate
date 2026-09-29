# Fundingrate

A public dashboard for Binance US-company stock perpetual funding and matching bStock spot prices. The site reads Supabase directly; a local command imports Binance data.

## Setup

1. Install dependencies with `bun install`.
2. Apply [the Supabase migration](supabase/migrations/202609290001_funding_dashboard.sql) to your Supabase project using the SQL Editor or Supabase CLI.
3. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in your local `.env` and in Vercel. Set `SUPABASE_SECRET_KEY` **only on your local computer**. Never add the secret key to a `NEXT_PUBLIC_` variable or to Vercel for this app.
4. Run `bun run sync` to import the first 90 days. Run it again whenever you want new data; it catches up missed hours. The computer must reach Binance and Supabase while the command runs.
5. Run `bun run dev` locally or deploy the repository to Vercel. The hosted site needs only the two public Supabase variables.

The first sync may take a few minutes. Later runs are shorter. Failed symbols appear in the command output and in the latest sync status; rerun the command to retry them. The dashboard shows the data timestamp so readers can spot an old import. The data is public and read-only in the browser; the local secret key writes through Supabase's service role.

## Checks

Run `bun test`, `bun run lint`, and `bun run build` before deployment.

The eligible US-company list and spot pair aliases live in [market.ts](src/lib/market.ts). Review new Binance listings before adding them; Binance's contract metadata does not establish company domicile.
