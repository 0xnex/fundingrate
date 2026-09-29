create table if not exists public.tracked_stocks (
  ticker text primary key,
  perp_symbol text not null,
  spot_symbol text,
  rank integer not null check (rank between 1 and 20),
  quote_volume_24h numeric not null check (quote_volume_24h >= 0),
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.hourly_prices (
  ticker text not null,
  market text not null check (market in ('perp', 'spot')),
  symbol text not null,
  bucket_start timestamptz not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null check (close > 0),
  volume numeric not null,
  primary key (ticker, market, bucket_start)
);

create table if not exists public.funding_events (
  ticker text not null,
  perp_symbol text not null,
  funding_time timestamptz not null,
  funding_rate numeric not null,
  rate_type text not null,
  mark_price numeric,
  primary key (ticker, funding_time, rate_type)
);

create table if not exists public.sync_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  data_through timestamptz not null,
  status text not null check (status in ('running', 'success', 'partial', 'failed')),
  error_message text
);

create index if not exists hourly_prices_bucket_idx on public.hourly_prices (bucket_start desc);
create index if not exists funding_events_time_idx on public.funding_events (funding_time desc);
create index if not exists sync_runs_started_idx on public.sync_runs (started_at desc);

alter table public.tracked_stocks enable row level security;
alter table public.hourly_prices enable row level security;
alter table public.funding_events enable row level security;
alter table public.sync_runs enable row level security;

revoke all on public.tracked_stocks, public.hourly_prices, public.funding_events, public.sync_runs from anon, authenticated;
grant select on public.tracked_stocks, public.hourly_prices, public.funding_events, public.sync_runs to anon, authenticated;
grant all on public.tracked_stocks, public.hourly_prices, public.funding_events, public.sync_runs to service_role;
grant usage, select on sequence public.sync_runs_id_seq to service_role;

create policy "Public can read tracked stocks" on public.tracked_stocks for select to anon, authenticated using (true);
create policy "Public can read hourly prices" on public.hourly_prices for select to anon, authenticated using (true);
create policy "Public can read funding events" on public.funding_events for select to anon, authenticated using (true);
create policy "Public can read sync status" on public.sync_runs for select to anon, authenticated using (true);
