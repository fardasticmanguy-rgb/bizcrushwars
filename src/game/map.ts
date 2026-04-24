// Procedurally generate a "world map" of polygonal territories using a
// jittered hex grid. Adjacency is computed by shared edges (distance heuristic).

export type Territory = {
  id: number;
  polygon: [number, number][]; // points in map coordinate space
  centroid: [number, number];
  area: number;
  neighbors: number[];
};

export const MAP_W = 1600;
export const MAP_H = 900;

function hash(x: number, y: number) {
  const s = Math.sin(x * 374.31 + y * 91.7) * 43758.5453;
  return s - Math.floor(s);
}

export function generateMap(): Territory[] {
  const cols = 22;
  const rows = 12;
  const r = 42; // hex radius
  const w = Math.sqrt(3) * r;
  const h = 1.5 * r;
  const territories: Territory[] = [];

  // Generate hex polygons with slight jitter for organic feel
  let id = 0;
  const grid: (number | null)[][] = Array.from({ length: rows }, () =>
    Array(cols).fill(null),
  );

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cx = col * w + (row % 2 === 1 ? w / 2 : 0) + 60;
      const cy = row * h + 60;

      // Carve out an irregular coastline using noise — skip cells outside
      const nx = col / cols - 0.5;
      const ny = row / rows - 0.5;
      const dist = Math.sqrt(nx * nx + ny * ny);
      const noise = hash(col, row) * 0.25;
      if (dist + noise > 0.55) continue;

      const jx = (hash(col + 1, row) - 0.5) * 8;
      const jy = (hash(col, row + 1) - 0.5) * 8;

      const polygon: [number, number][] = [];
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i + Math.PI / 6;
        polygon.push([
          cx + jx + Math.cos(a) * r,
          cy + jy + Math.sin(a) * r,
        ]);
      }
      const area = (3 * Math.sqrt(3) * r * r) / 2;
      territories.push({
        id,
        polygon,
        centroid: [cx + jx, cy + jy],
        area,
        neighbors: [],
      });
      grid[row][col] = id;
      id++;
    }
  }

  // Compute neighbors using axial hex offsets
  const evenOffsets = [
    [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1],
  ];
  const oddOffsets = [
    [-1, 0], [1, 0], [0, -1], [0, 1], [1, -1], [1, 1],
  ];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tid = grid[row][col];
      if (tid === null) continue;
      const offs = row % 2 === 0 ? evenOffsets : oddOffsets;
      for (const [dc, dr] of offs) {
        const nr = row + dr;
        const nc = col + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const nid = grid[nr][nc];
        if (nid !== null) territories[tid].neighbors.push(nid);
      }
    }
  }

  return territories;
}
