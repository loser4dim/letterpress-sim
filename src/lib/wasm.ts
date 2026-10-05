export type PrintEngine = {
  memory: WebAssembly.Memory;
  engine_init(): void;
  mask_ptr(): number;
  coating_ptr(): number;
  image_ptr(): number;
  plate_ptr(): number;
  wet_ptr(): number;
  dry_ptr(): number;
  new_paper(): void;
  dry_ink(): void;
  clear_ink(): void;
  paint_ink(x: number, y: number, radius: number, strength: number, erase: number, rgb: number): void;
  update_plate(mode: number, amount: number, end: number, angle: number, rgb: number): void;
  print(pressure: number, roughness: number, speed: number, viscosity: number, amount: number, mode: number, end: number, gradientAngle: number, peelAngle: number, offsetX: number, offsetY: number, rgb: number): void;
  impression_count(): number;
};
export async function loadEngine(): Promise<PrintEngine> {
  const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/wasm/letterpress_engine.wasm`);
  if (!response.ok) throw new Error(`Rust engine: HTTP ${response.status}`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
  const engine = instance.exports as unknown as PrintEngine;
  engine.engine_init();
  return engine;
}
