
-- Territories: shared world map state
create table public.territories (
  id int primary key,
  owner_id text,
  units int not null default 0,
  color text,
  updated_at timestamptz not null default now()
);

-- Players in the game
create table public.players (
  id text primary key,
  name text not null,
  color text not null,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

-- Append-only attack log
create table public.attacks (
  id bigserial primary key,
  from_territory int not null,
  to_territory int not null,
  attacker_id text not null,
  units int not null,
  created_at timestamptz not null default now()
);

alter table public.territories enable row level security;
alter table public.players enable row level security;
alter table public.attacks enable row level security;

-- Open game: anyone can read and write (anonymous multiplayer game)
create policy "anyone read territories" on public.territories for select using (true);
create policy "anyone write territories" on public.territories for all using (true) with check (true);

create policy "anyone read players" on public.players for select using (true);
create policy "anyone write players" on public.players for all using (true) with check (true);

create policy "anyone read attacks" on public.attacks for select using (true);
create policy "anyone insert attacks" on public.attacks for insert with check (true);

-- Enable realtime
alter publication supabase_realtime add table public.territories;
alter publication supabase_realtime add table public.players;
alter publication supabase_realtime add table public.attacks;
alter table public.territories replica identity full;
alter table public.players replica identity full;
