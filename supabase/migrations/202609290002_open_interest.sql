create table if not exists public.hourly_open_interest (
  ticker text not null,
  perp_symbol text not null,
  bucket_start timestamptz not null,
  open_interest numeric not null check (open_interest >= 0),
  open_interest_value numeric not null check (open_interest_value >= 0),
  primary key (ticker, bucket_start)
);

create index if not exists hourly_open_interest_bucket_idx on public.hourly_open_interest (bucket_start desc);
alter table public.hourly_open_interest enable row level security;
revoke all on public.hourly_open_interest from anon, authenticated;
grant select on public.hourly_open_interest to anon, authenticated;
grant all on public.hourly_open_interest to service_role;
create policy "Public can read hourly open interest" on public.hourly_open_interest for select to anon, authenticated using (true);
