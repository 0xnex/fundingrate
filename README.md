# Fundingrate

A public dashboard for Binance US-company stock perpetual funding and matching bStock spot prices. A local command imports hourly history to Supabase. The site reads that history directly. Stock detail pages request current public Binance quotes and 500-level books from the visitor's browser, with a cached Vercel route as fallback; the route also serves other live quote requests.

## Setup

1. Install dependencies with `bun install`.
2. Apply the Supabase migrations in filename order: [dashboard tables](supabase/migrations/202609290001_funding_dashboard.sql), then [hourly open interest](supabase/migrations/202609290002_open_interest.sql). Use the SQL Editor or Supabase CLI.
3. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in your local `.env` and in Vercel. Set `SUPABASE_SECRET_KEY` **only on your local computer**. Never add the secret key to a `NEXT_PUBLIC_` variable or to Vercel for this app.
4. Run `bun run sync` to import the first 90 days. Run it again whenever you want new data; it catches up missed hours. The computer must reach Binance and Supabase while the command runs.
5. Run `bun run dev` locally or deploy the repository to Vercel. The hosted site needs only the two public Supabase variables. A visitor's network must reach Binance for direct detail-page depth; [Vercel's region setting](vercel.json) places the fallback live quote route outside the US because Binance futures requests failed from Vercel's default US region. After deployment, check `/api/market?tickers=SNDK`: a usable fallback response has both `perpBook` and `spotBook`. An `HTTP 451` error means Binance restricts that network's region.

The first sync may take a few minutes. Later runs are shorter. Failed symbols appear in the command output and in the latest sync status; rerun the command to retry them. Open interest can initially backfill about one month from Binance and accumulates in hourly buckets on later syncs. The simulator withholds recommendations when the historical sync is over 24 hours old. Its fees, reserve, and price-shock values are editable assumptions, and its modeled margin buffer is not an account liquidation price. Historical data is public and read-only in the browser; the local secret key writes through Supabase's service role.

## Checks

Run `bun test`, `bun run lint`, and `bun run build` before deployment.

The eligible US-company list and spot pair aliases live in [market.ts](src/lib/market.ts). Review new Binance listings before adding them; Binance's contract metadata does not establish company domicile.
