// Builds a low-res land mask from the world map image. Pixels with high
// brightness (land) are passable; near-black (ocean) is not.
import { GRID_W, GRID_H } from "./constants";
import worldMap from "@/assets/map-world.jpg";

let cached: Uint8Array | null = null;
let loading: Promise<Uint8Array> | null = null;

export function loadLandMask(): Promise<Uint8Array> {
  if (cached) return Promise.resolve(cached);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = worldMap;
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = GRID_W;
      cv.height = GRID_H;
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(img, 0, 0, GRID_W, GRID_H);
      const data = ctx.getImageData(0, 0, GRID_W, GRID_H).data;
      const mask = new Uint8Array(GRID_W * GRID_H);
      for (let i = 0; i < GRID_W * GRID_H; i++) {
        const r = data[i * 4];
        const g = data[i * 4 + 1];
        const b = data[i * 4 + 2];
        // ocean is very dark navy; land is brighter
        const lum = (r + g + b) / 3;
        mask[i] = lum > 45 ? 1 : 0;
      }
      cached = mask;
      resolve(mask);
    };
    img.onerror = reject;
  });
  return loading;
}

export function getCachedMask() {
  return cached;
}
