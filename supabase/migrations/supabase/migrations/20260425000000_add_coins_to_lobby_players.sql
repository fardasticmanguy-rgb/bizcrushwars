ALTER TABLE public.lobby_players 
ADD COLUMN IF NOT EXISTS coins integer NOT NULL DEFAULT 0;
