-- Drop old game tables
DROP TABLE IF EXISTS public.attacks CASCADE;
DROP TABLE IF EXISTS public.territories CASCADE;
DROP TABLE IF EXISTS public.players CASCADE;

-- Lobbies
CREATE TABLE public.lobbies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  host_id text NOT NULL,
  map_id text NOT NULL DEFAULT 'world',
  mode text NOT NULL DEFAULT 'ffa',
  difficulty text NOT NULL DEFAULT 'balanced',
  bots integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'waiting',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz
);

ALTER TABLE public.lobbies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anyone read lobbies" ON public.lobbies FOR SELECT USING (true);
CREATE POLICY "anyone write lobbies" ON public.lobbies FOR ALL USING (true) WITH CHECK (true);

-- Lobby players
CREATE TABLE public.lobby_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lobby_id uuid NOT NULL REFERENCES public.lobbies(id) ON DELETE CASCADE,
  player_id text NOT NULL,
  name text NOT NULL,
  color text NOT NULL,
  team integer NOT NULL DEFAULT 0,
  is_bot boolean NOT NULL DEFAULT false,
  dot_x real NOT NULL DEFAULT 0.5,
  dot_y real NOT NULL DEFAULT 0.5,
  units integer NOT NULL DEFAULT 100,
  pixels integer NOT NULL DEFAULT 0,
  alive boolean NOT NULL DEFAULT true,
  joined_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lobby_id, player_id)
);

ALTER TABLE public.lobby_players ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anyone read lobby_players" ON public.lobby_players FOR SELECT USING (true);
CREATE POLICY "anyone write lobby_players" ON public.lobby_players FOR ALL USING (true) WITH CHECK (true);

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.lobbies;
ALTER PUBLICATION supabase_realtime ADD TABLE public.lobby_players;
