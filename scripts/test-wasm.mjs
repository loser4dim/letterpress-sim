import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import assert from "node:assert/strict";

const { instance } = await WebAssembly.instantiate(readFileSync("public/wasm/letterpress_engine.wasm"), {});
const e = instance.exports;
e.engine_init();
assert.equal(e.simulation_size(), 8192);
assert.equal(e.output_size(), 4096);
const M = e.source_size();
assert.equal(M, 6552);
const source = () => new Uint8Array(e.memory.buffer, e.source_ptr(), M * M);
const coat = () => new Float32Array(e.memory.buffer, e.coating_ptr(), 512 * 512);
e.configure_plate(1, 150, 0);
for (let y = M / 2 - 10; y < M / 2 + 10; y++) source().fill(0, y * M + M / 2 - 10, y * M + M / 2 + 10);
function print(pressure, mode = 0, rgb = 0xbc3d32, viscosity = 0.6) {
  e.print_begin(pressure, .55, .4, viscosity, .55, mode, .1, 0, 0, 0, 0, rgb);
  e.print_rows(M / 2 - 16, 32); e.print_finish();
}
print(0); assert.equal(e.wet_total(), 0); assert.equal(e.allocated_tiles(), 0);
print(.7); assert(e.wet_total() > 0); assert(e.allocated_tiles() < 32);
e.render_preview(); const printed = new Uint8Array(e.memory.buffer, e.image_ptr(), 640 ** 2 * 4).slice();
e.dry_ink(); assert.equal(e.wet_total(), 0); e.render_preview();
assert.deepEqual(new Uint8Array(e.memory.buffer, e.image_ptr(), 640 ** 2 * 4), printed);
e.new_paper(); e.clear_ink(); print(.7, 2); assert.equal(e.wet_total(), 0);
e.paint_ink(256, 256, 45, .8, 0, 0xbc3d32);
const before = coat().reduce((a, b) => a + b, 0);
print(.7, 2, 0x0000ff); assert(e.wet_total() > 0); assert(coat().reduce((a, b) => a + b, 0) < before);
for (let i = 0; i < 40; i++) e.paint_ink(256, 256, 45, 1, 0, 0xbc3d32);
e.new_paper(); print(1, 2, 0xbc3d32, 0); assert(e.allocated_tiles() > 1);
e.render_export();
const exported = new Uint8Array(e.memory.buffer, e.export_ptr(), 4096 ** 2 * 4);
assert.equal(exported.length, 67108864); assert.equal(exported[3], 255); assert.equal(exported.at(-1), 255);

// 4K uses the actual 4096 grid, not an enlarged preview. Resetting must release paper tiles.
e.engine_init_resolution(4096);
assert.equal(e.simulation_size(), 4096); assert.equal(e.source_size(), 3272);
assert.equal(e.allocated_tiles(), 0);
const smallM = e.source_size();
e.configure_plate(1, 150, 0);
new Uint8Array(e.memory.buffer, e.source_ptr(), smallM ** 2).fill(0, smallM ** 2 / 2, smallM ** 2 / 2 + 16);
e.print_begin(.7, .55, .4, .6, .55, 0, .1, 0, 0, 0, 0, 0xbc3d32);
e.print_rows(smallM / 2, 1); e.print_finish(); assert(e.wet_total() > 0);
e.render_export(); assert.equal(new Uint8Array(e.memory.buffer, e.export_ptr(), 4096 ** 2 * 4).length, 67108864);
e.render_export_transparent();
const transparent = new Uint8Array(e.memory.buffer, e.export_ptr(), 4096 ** 2 * 4);
assert.equal(transparent[3], 0); assert.equal(transparent.at(-1), 0);
assert(transparent.some((v, i) => i % 4 === 3 && v > 0));
e.engine_init_resolution(123); assert.equal(e.simulation_size(), 8192);

// Run the actual browser worker code in a separate Node thread with its Web APIs adapted.
const worker = new Worker(`
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
globalThis.self = globalThis;
self.postMessage = (value, transfer) => parentPort.postMessage(value, transfer);
globalThis.fetch = async () => new Response(fs.readFileSync(workerData.wasm));
parentPort.on("message", data => self.onmessage({ data }));
require("node:vm").runInThisContext(fs.readFileSync(workerData.script, "utf8"));
`, { eval: true, workerData: { wasm: resolve("public/wasm/letterpress_engine.wasm"), script: resolve("public/wasm/engine-worker.js") } });
let sequence = 0;
const pending = new Map();
worker.on("message", message => {
  const request = pending.get(message.id); if (!request) return;
  if (message.progress !== undefined) { request.progress.push(message.progress); return; }
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error)); else request.resolve({ result: message.result, progress: request.progress });
});
worker.on("error", error => { for (const request of pending.values()) request.reject(error); pending.clear(); });
function call(method, args = [], transfer = []) {
  return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject, progress: [] }); worker.postMessage({ id, method, args }, transfer); });
}
try {
  const init = await call("initialize", ["test.wasm"]);
  assert.equal(init.result.simulation, 8192); assert.equal(init.result.output, 4096);
  await call("configure", [1, 150, 0]);
  const mask = new Uint8Array(M * M).fill(255);
  for (let y = M / 2 - 10; y < M / 2 + 10; y++) mask.fill(0, y * M + M / 2 - 10, y * M + M / 2 + 10);
  await call("source", [mask], [mask.buffer]); assert.equal(mask.byteLength, 0);
  await call("paint", [[[256, 256]], 45, .8, 0, 0xbc3d32]);
  const print = await call("print", [.7, .55, .4, .6, .55, 2, .1, 0, 0, 0, 0, 0xbc3d32]);
  assert.equal(print.result, 1); assert.equal(print.progress.at(-1), 100);
  assert.equal((await call("preview")).result.length, 640 ** 2 * 4);
  assert.equal((await call("plate", [2, .55, .1, 0, 0xbc3d32])).result.length, 512 ** 2 * 4);
  const fourK = await call("initialize", ["test.wasm", 4096]);
  assert.equal(fourK.result.simulation, 4096); assert.equal(fourK.result.source, 3272);
  assert.equal(fourK.result.output, 4096);
  const clearExport = (await call("export", [true])).result;
  assert.equal(clearExport.length, 4096 ** 2 * 4); assert.equal(clearExport[3], 0);
  assert.equal((await call("preview")).result.length, 640 ** 2 * 4);
} finally { await worker.terminate(); }
console.log("PASS: actual selectable 4096/8192-grid WASM, sparse allocation, 4096 export, pressure, drying, ink depletion, excess ink, and real worker messaging/progress");
