import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { supabase } from "@/integrations/supabase/client";
import { MAPS, BOT_NAMES, pickColor, PLAYER_COLORS } from "@/game/constants";
import { Copy, X, Check } from "lucide-react";
import worldMap from "@/assets/map-world.jpg";

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
type LobbyPlayer = {
  id: string;
  player_id: string;
  name: string;
  color: string;
  is_bot: boolean;
};

interface LobbyScreenProps {
  lobby: Lobby;
  playerId: string;
  onLeave: () => void;
  onStart: () => void;
}

export function LobbyScreen({ lobby, playerId, onLeave, onStart }: LobbyScreenProps) {
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);
  const [mapId, setMapId] = useState(lobby.map_id);
  const [mode, setMode] = useState(lobby.mode);
  const [difficulty, setDifficulty] = useState(lobby.difficulty);
  const [bots, setBots] = useState(lobby.bots);
  const [copied, setCopied] = useState(false);

  const isHost = lobby.host_id === playerId;

  useEffect(() => {
    let active = true;
    async function load() {
      const { data } = await supabase
        .from("lobby_players")
        .select("id, player_id, name, color, is_bot")
        .eq("lobby_id", lobby.id);
      if (active && data) setPlayers(data);
    }
    load();

    const ch = supabase
      .channel(`lobby-${lobby.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lobby_players", filter: `lobby_id=eq.${lobby.id}` },
        () => load(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "lobbies", filter: `id=eq.${lobby.id}` },
        (payload) => {
          const updated = payload.new as Lobby;
          setMapId(updated.map_id);
          setMode(updated.mode);
          setDifficulty(updated.difficulty);
          setBots(updated.bots);
          if (updated.status === "playing") onStart();
        },
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(ch);
    };
  }, [lobby.id, onStart]);

  async function updateSetting(patch: Partial<Lobby>) {
    if (!isHost) return;
    await supabase.from("lobbies").update(patch).eq("id", lobby.id);
  }

  async function startGame() {
    if (!isHost) return;
    // Add bots
    const taken = players.map((p) => p.color);
    const botRows = [];
    for (let i = 0; i < bots; i++) {
      const color = pickColor([...taken, ...botRows.map((b) => b.color)]);
      botRows.push({
        lobby_id: lobby.id,
        player_id: `bot-${crypto.randomUUID()}`,
        name: BOT_NAMES[i % BOT_NAMES.length],
        color,
        is_bot: true,
      });
    }
    if (botRows.length > 0) {
      await supabase.from("lobby_players").insert(botRows);
    }
    await supabase
      .from("lobbies")
      .update({ status: "playing", started_at: new Date().toISOString() })
      .eq("id", lobby.id);
  }

  async function copyCode() {
    await navigator.clipboard.writeText(lobby.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-bold">{isHost ? "Create Lobby" : "Lobby"}</h2>
          <button
            onClick={onLeave}
            className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Leave lobby"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Code box */}
        <button
          onClick={copyCode}
          className="mb-6 flex w-full items-center justify-between rounded-xl border border-border bg-secondary/60 px-4 py-3 transition hover:bg-secondary"
        >
          <span className="text-xs uppercase tracking-wider text-muted-foreground">Code</span>
          <span className="font-mono text-2xl font-bold tracking-widest text-primary">
            {lobby.code}
          </span>
          {copied ? (
            <Check className="h-5 w-5 text-accent" />
          ) : (
            <Copy className="h-5 w-5 text-muted-foreground" />
          )}
        </button>

        {/* Map selection */}
        <div className="mb-6">
          <h3 className="mb-2 text-center text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Map
          </h3>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {MAPS.map((m) => {
              const selected = mapId === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => updateSetting({ map_id: m.id })}
                  disabled={!isHost}
                  className={`group relative overflow-hidden rounded-lg border-2 p-2 transition ${
                    selected ? "border-primary" : "border-border hover:border-primary/50"
                  } ${!isHost && "opacity-70"}`}
                >
                  <div
                    className="mb-1 aspect-video w-full rounded bg-cover bg-center"
                    style={{
                      backgroundImage: `url(${worldMap})`,
                      backgroundPosition: `${m.center[0] * 100}% ${m.center[1] * 100}%`,
                      backgroundSize: m.id === "world" ? "100%" : "300%",
                    }}
                  />
                  <div className="text-xs font-medium">{m.name}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Difficulty */}
        <div className="mb-4">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Difficulty
          </h3>
          <div className="grid grid-cols-3 gap-2">
            {["relaxed", "balanced", "intense"].map((d) => (
              <button
                key={d}
                onClick={() => updateSetting({ difficulty: d })}
                disabled={!isHost}
                className={`rounded-lg border-2 px-3 py-2 text-sm font-medium capitalize transition ${
                  difficulty === d
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:border-primary/50"
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        {/* Mode */}
        <div className="mb-4">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Mode
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {[
              { v: "ffa", l: "Free for All" },
              { v: "teams", l: "Teams" },
            ].map((m) => (
              <button
                key={m.v}
                onClick={() => updateSetting({ mode: m.v })}
                disabled={!isHost}
                className={`rounded-lg border-2 px-3 py-2 text-sm font-medium transition ${
                  mode === m.v
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:border-primary/50"
                }`}
              >
                {m.l}
              </button>
            ))}
          </div>
        </div>

        {/* Bots */}
        <div className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Bots
            </h3>
            <span className="text-sm font-bold text-primary">{bots}</span>
          </div>
          <Slider
            value={[bots]}
            onValueChange={(v) => updateSetting({ bots: v[0] })}
            min={0}
            max={11}
            step={1}
            disabled={!isHost}
          />
        </div>

        {/* Player list */}
        <div className="mb-6">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Players ({players.length})
          </h3>
          <div className="space-y-1.5 rounded-lg border border-border bg-background/40 p-2">
            {players.map((p) => (
              <div key={p.id} className="flex items-center gap-2 rounded px-2 py-1.5">
                <span
                  className="h-3 w-3 rounded-full ring-2 ring-background"
                  style={{ backgroundColor: p.color }}
                />
                <span className="flex-1 text-sm font-medium">{p.name}</span>
                {p.player_id === lobby.host_id && (
                  <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-bold uppercase text-primary">
                    Host
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {isHost ? (
          <Button
            onClick={startGame}
            className="h-12 w-full text-base font-bold"
            size="lg"
            disabled={players.length < 1}
          >
            Start Game
          </Button>
        ) : (
          <div className="rounded-lg border border-border bg-secondary/40 px-4 py-3 text-center text-sm text-muted-foreground">
            Waiting for host to start...
          </div>
        )}
      </div>
    </div>
  );
}

// Suppress unused PLAYER_COLORS import if tree-shaken
void PLAYER_COLORS;
