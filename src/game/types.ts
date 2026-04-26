export type Lobby = {
  id: string;
  code: string;
  host_id: string;
  map_id: string;
  difficulty: string;
};

export type LobbyPlayer = {
  id: string;
  player_id: string;
  name: string;
  color: string;
  is_bot: boolean;
  dot_x: number;
  dot_y: number;
  units: number;
  pixels: number;
  alive: boolean;
};

export type BuildingType = "fort" | "factory";
export type Building = { type: BuildingType; ownerIdx: number; gridIdx: number };

export type Claim = { i: number; o: number };

export type AttackResult = {
  spent: number;
  captured: number;
  repelled: boolean;
  reachedTarget?: boolean;
  unreachable?: boolean;
};
