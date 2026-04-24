import { useEffect, useState } from "react";
import { Menu } from "./Menu";
import { LobbyScreen } from "./LobbyScreen";
import { GameScreen } from "./GameScreen";
import { supabase } from "@/integrations/supabase/client";
import { genCode, getOrCreatePlayerId, pickColor } from "@/game/constants";
import { toast } from "sonner";

const NAME_KEY = "frontwars_username";

type Lobby = {
  id: string;
  code: string;
  host_id: string;
  map_id: string;
  mode: string;
  difficulty: string;
  bots: number;
  status: string;
};

type Phase = "menu" | "lobby" | "game";

export function App() {
  const [playerId] = useState(() => getOrCreatePlayerId());
  const [username, setUsername] = useState(
    () => localStorage.getItem(NAME_KEY) ?? "",
  );
  const [phase, setPhase] = useState<Phase>("menu");
  const [lobby, setLobby] = useState<Lobby | null>(null);

  useEffect(() => {
    if (username) localStorage.setItem(NAME_KEY, username);
  }, [username]);

  async function joinLobbyAsPlayer(lob: Lobby) {
    const { data: existing } = await supabase
      .from("lobby_players")
      .select("color")
      .eq("lobby_id", lob.id);
    const taken = (existing ?? []).map((p) => p.color);
    const color = pickColor(taken);
    const { error } = await supabase.from("lobby_players").upsert(
      {
        lobby_id: lob.id,
        player_id: playerId,
        name: username || "Player",
        color,
        is_bot: false,
      },
      { onConflict: "lobby_id,player_id" },
    );
    if (error) {
      toast.error(error.message);
      return false;
    }
    return true;
  }

  async function handleCreateLobby() {
    const code = genCode();
    const { data, error } = await supabase
      .from("lobbies")
      .insert({ code, host_id: playerId })
      .select()
      .single();
    if (error || !data) {
      toast.error(error?.message ?? "Failed to create lobby");
      return;
    }
    const ok = await joinLobbyAsPlayer(data as Lobby);
    if (!ok) return;
    setLobby(data as Lobby);
    setPhase("lobby");
  }

  async function handleJoinLobby(code: string) {
    const { data, error } = await supabase
      .from("lobbies")
      .select("*")
      .eq("code", code.toUpperCase())
      .maybeSingle();
    if (error || !data) {
      toast.error("Lobby not found");
      return;
    }
    if (data.status === "playing") {
      toast.error("Game already started");
      return;
    }
    const ok = await joinLobbyAsPlayer(data as Lobby);
    if (!ok) return;
    setLobby(data as Lobby);
    setPhase("lobby");
  }

  async function handleSinglePlayer() {
    const code = genCode();
    const { data, error } = await supabase
      .from("lobbies")
      .insert({ code, host_id: playerId, bots: 5 })
      .select()
      .single();
    if (error || !data) {
      toast.error(error?.message ?? "Failed");
      return;
    }
    const ok = await joinLobbyAsPlayer(data as Lobby);
    if (!ok) return;
    // Start immediately with bots
    const { BOT_NAMES, pickColor: pc } = await import("@/game/constants");
    const taken = [(await supabase.from("lobby_players").select("color").eq("lobby_id", data.id)).data?.[0]?.color ?? ""];
    const botRows = [];
    for (let i = 0; i < 5; i++) {
      const c = pc([...taken, ...botRows.map((b) => b.color)]);
      botRows.push({
        lobby_id: data.id,
        player_id: `bot-${crypto.randomUUID()}`,
        name: BOT_NAMES[i % BOT_NAMES.length],
        color: c,
        is_bot: true,
      });
    }
    await supabase.from("lobby_players").insert(botRows);
    await supabase
      .from("lobbies")
      .update({ status: "playing", started_at: new Date().toISOString() })
      .eq("id", data.id);
    setLobby({ ...(data as Lobby), status: "playing" });
    setPhase("game");
  }

  async function handleLeave() {
    if (lobby) {
      await supabase
        .from("lobby_players")
        .delete()
        .eq("lobby_id", lobby.id)
        .eq("player_id", playerId);
    }
    setLobby(null);
    setPhase("menu");
  }

  if (phase === "menu" || !lobby) {
    return (
      <Menu
        username={username}
        onUsernameChange={setUsername}
        onCreateLobby={handleCreateLobby}
        onJoinLobby={handleJoinLobby}
        onSinglePlayer={handleSinglePlayer}
      />
    );
  }

  if (phase === "lobby") {
    return (
      <LobbyScreen
        lobby={lobby}
        playerId={playerId}
        onLeave={handleLeave}
        onStart={() => setPhase("game")}
      />
    );
  }

  return <GameScreen lobby={lobby} playerId={playerId} onLeave={handleLeave} />;
}
