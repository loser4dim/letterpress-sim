import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { canPlace, findSpace, rasterizePlate, snapValue } from "../public/wasm/plate-tools.js";
import assert from "node:assert/strict";
import { alphaBounds,tightGlyphLayout } from "../src/lib/glyph-tools.js";
import {FONT_CATALOG} from "../src/lib/font-catalog.js";
import {resizeCorner,smoothRollerAngle,glyphLayout} from "../public/wasm/composition-tools.js";

const assetDir=process.argv.includes("--export") ? resolve("out/_letterpress_engine",JSON.parse(readFileSync("out/_letterpress_engine/current.json","utf8")).version) : resolve("public/wasm");
const { instance } = await WebAssembly.instantiate(readFileSync(resolve(assetDir,"letterpress_engine.wasm")), {});
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
assert(new Uint8Array(e.memory.buffer, e.image_ptr(), 640 ** 2 * 4).every((v,i)=>Math.abs(v-printed[i])<=1));
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
const ready = import(workerData.script);
parentPort.on("message", async data => { await ready; self.onmessage({ data }); });
`, { eval: true, workerData: { wasm: resolve(assetDir,"letterpress_engine.wasm"), script: pathToFileURL(resolve(assetDir,"engine-worker.js")).href } });
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
  assert.equal(init.result.apiVersion,3);assert.equal(init.result.simulation, 8192); assert.equal(init.result.output, 4096);
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
  const tinyBlock={id:1,x:220,y:220,w:48,h:48,iw:2,ih:2,gray:new Uint8Array([0,0,0,0]),kind:"binary",threshold:150,screen:128,tone:125,invert:false};
  await call("compose", [[tinyBlock]], [tinyBlock.gray.buffer]);
  await call("rollerLoad", [90,.8,0,0xbc3d32]);
  await call("roller", [[[210,240,290,240]]]);
  const coated=(await call("plate",[2,.8,0,0,0xbc3d32])).result;
  await call("saveCoating",[1]);
  await call("compose",[[]]);
  assert.notDeepEqual((await call("plate",[2,.8,0,0,0xbc3d32])).result,coated);
  const restoreBlock={...tinyBlock,gray:new Uint8Array([0,0,0,0])};
  await call("compose",[[restoreBlock]],[restoreBlock.gray.buffer]);
  await call("restoreCoating",[1]);
  assert.deepEqual((await call("plate",[2,.8,0,0,0xbc3d32])).result,coated);
  await call("materials", [.8,.7]);
  await call("print", [.7,.55,.4,.6,.55,2,.1,0,0,0,0,0xbc3d32]);
  const inkExport = (await call("export", [true])).result;
  assert.equal(inkExport[3],0); assert(inkExport.some((v,i)=>i%4===3&&v>0));
  await call("new");
  const clearExport = (await call("export", [true])).result;
  assert.equal(clearExport.length, 4096 ** 2 * 4); assert.equal(clearExport[3], 0);
  assert.equal((await call("preview")).result.length, 640 ** 2 * 4);
} finally { await worker.terminate(); }
// Mechanical bounds and screen-area regression: photograph tones must remain distinct.
assert.equal(snapValue(250,8),248); assert.equal(snapValue(251,0),251); assert.equal(snapValue(15,16),16);
const first={id:1,x:10,y:10,w:100,h:100};
assert(!canPlace({id:2,x:50,y:50,w:80,h:80},[first]));
assert(canPlace({id:2,x:112,y:10,w:80,h:80},[first]));
assert(findSpace(100,100,[first]));
function toneCoverage(gray,kind="halftone") {
  const block={id:1,x:0,y:0,w:512,h:512,iw:2,ih:2,gray:new Uint8Array(4).fill(gray),kind,threshold:150,screen:64,tone:100,invert:false};
  return rasterizePlate([block],512).reduce((sum,v)=>sum+(v===0?1:0),0)/512**2;
}
const tones=[240,192,128,64,16].map(v=>toneCoverage(v));
for(let i=1;i<tones.length;i++)assert(tones[i]>tones[i-1]+.1);
assert(Math.abs(tones[2]-(1-128/255)*.96)<.025);
assert(toneCoverage(128,"diffusion")>.4&&toneCoverage(128,"diffusion")<.6);
console.log("PASS: actual selectable 4096/8192-grid WASM, sparse allocation, 4096 export, pressure, drying, ink depletion, excess ink, and real worker messaging/progress");

const adjacentGlyphs=[{id:1,type:"glyph",x:0,y:0,w:40,h:40}];
assert(canPlace({id:2,type:"glyph",x:40,y:0,w:40,h:40},adjacentGlyphs));
assert(!canPlace({id:2,type:"glyph",x:39,y:0,w:40,h:40},adjacentGlyphs));
assert(!canPlace({id:2,type:"image",x:40,y:0,w:40,h:40},adjacentGlyphs));
const corner=resizeCorner({x:80,y:96,w:64,h:32},"nw",{x:48,y:80},8,true);
assert.equal(corner.x+corner.w,144);assert.equal(corner.y+corner.h,128);assert.equal(corner.w%8,0);assert.equal(corner.w/corner.h,2);
assert(Math.abs(smoothRollerAngle(0,Math.PI))<1e-6);
assert(Math.abs(smoothRollerAngle(Math.PI/2,-Math.PI/2)-Math.PI/2)<1e-6);
const glyphs=glyphLayout([["A","B"],["C"]],40,{left:0,right:0,top:0,bottom:0});
assert.equal(glyphs.cells[1].x,40);assert.equal(glyphs.cells[2].y,40);assert.equal(glyphs.w,80);assert.equal(glyphs.h,80);
const padded=glyphLayout([["A","B"]],40,{left:4,right:8,top:2,bottom:6});
assert.equal(padded.cells[1].x,52);assert.equal(padded.h,48);
console.log("PASS: per-plate coating restore, touching glyph cells, snapped anchored corner resizing, character padding, stable roller reversals");

assert(FONT_CATALOG.length>=100);assert.equal(new Set(FONT_CATALOG.map(f=>f.family)).size,FONT_CATALOG.length);
const dot={id:2,type:"glyph",x:0,y:0,w:2,h:3};assert(canPlace(dot,[]));
const pixels=new Uint8ClampedArray(10*10*4);pixels[(1*10+2)*4+3]=255;pixels[(8*10+7)*4+3]=1;
assert.deepEqual(alphaBounds(pixels,10,10),{x:2,y:1,w:6,h:8});assert.equal(alphaBounds(new Uint8Array(16),2,2),null);
const tight=tightGlyphLayout([[{char:"i",w:5,h:30,ascent:30,padding:{left:0,right:0,top:0,bottom:0}},{char:"W",w:32,h:28,ascent:28,padding:{left:0,right:0,top:0,bottom:0}},{char:"g",w:19,h:34,ascent:24,padding:{left:0,right:0,top:0,bottom:0}}]]);
assert.equal(tight.cells[1].x,5);assert.equal(tight.cells[2].x,37);assert.equal(tight.cells[0].y+tight.cells[0].ascent,tight.cells[2].y+tight.cells[2].ascent);assert.equal(tight.w,56);assert.equal(tight.h,40);
console.log("PASS: 100+ fonts, actual pixel-bound crop, tiny punctuation cells, proportional widths and shared baselines");
