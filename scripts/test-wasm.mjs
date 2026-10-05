import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const {instance}=await WebAssembly.instantiate(readFileSync("public/wasm/letterpress_engine.wasm"),{});
const e=instance.exports;
const N=640,M=512,S=N*N;
const float=(ptr,len)=>new Float32Array(e.memory.buffer,ptr,len);
const sum=a=>a.reduce((x,y)=>x+y,0);
const ink=()=>float(e.wet_ptr(),S*3);
const coat=()=>float(e.coating_ptr(),M*M);
const pixels=()=>new Uint8Array(e.memory.buffer,e.image_ptr(),S*4).slice();
function print(p=.7,mode=0,rgb=0xbc3d32,ox=0) {e.print(p,.55,.4,.6,.55,mode,.1,0,0,ox,0,rgb);}
e.engine_init();float(e.mask_ptr(),M*M).fill(1);
const blank=pixels();print(0);assert.equal(sum(ink()),0);assert.deepEqual(pixels(),blank);
print();assert(sum(ink())>0);assert.equal(e.impression_count(),2);assert(ink().every(v=>Number.isFinite(v)&&v>=0));
const printed=pixels();e.dry_ink();assert.equal(sum(ink()),0);assert(sum(float(e.dry_ptr(),S*3))>0);assert.deepEqual(pixels(),printed);
print(.7,0,0x254b76,20);assert.notDeepEqual(pixels(),printed);assert.equal(e.impression_count(),3);
e.new_paper();e.clear_ink();print(.7,2);assert.equal(sum(ink()),0);
e.paint_ink(256,256,45,.55,0,0xbc3d32);assert(coat()[256*M+256]>0);const before=sum(coat());print(.7,2);assert(sum(coat())<before);assert(sum(ink())>0);
e.update_plate(1,.8,.1,0,0xbc3d32);let plate=new Uint8Array(e.memory.buffer,e.plate_ptr(),M*M*4);assert(plate[(256*M+511)*4]>plate[(256*M)*4]);
// Excess ink spreads beyond the plate, while zero-pressure remains unchanged.
e.engine_init();float(e.mask_ptr(),M*M).fill(0);float(e.mask_ptr(),M*M)[256*M+256]=1;
for(let n=0;n<40;n++)e.paint_ink(256,256,5,1,0,0xbc3d32);
e.print(1,0,.9,0,1,2,.1,0,0,0,0,0xbc3d32);
assert(ink()[(320*N+326)*3]>0,"heavy ink must spread beyond the one-pixel plate");
assert(ink().every(v=>Number.isFinite(v)&&v>=0));
// Different painted colors survive a picker change and print independently.
e.engine_init();float(e.mask_ptr(),M*M).fill(1);
e.paint_ink(150,256,20,1,0,0xff0000);e.paint_ink(350,256,20,1,0,0x0000ff);
e.print(1,0,0,1,1,2,.1,0,0,0,0,0x00ff00);
const left=(320*N+214)*3,right=(320*N+414)*3;
assert(ink()[left]<ink()[left+2]);assert(ink()[right]>ink()[right+2]);
// Full browser controller wiring against real WebAssembly, without a browser rasterizer.
const { initLab } = await import("../src/lib/init-lab.js");
class Element extends EventTarget {
  constructor(id){super();this.id=id;this.value=({threshold:150,offsetX:0,offsetY:0,gradientEnd:10,brushSize:45,direction:0,gradientAngle:0,inkMode:"paint",plateMode:"binary",separation:"luminance",color:"#bc3d32",ink:55,pressure:55,roughness:55,speed:40,viscosity:60})[id]??"";this.checked=false;this.hidden=false;this.classList={remove(){},add(){}};this.width=this.height=512;}
  getContext(){return raster;} getBoundingClientRect(){return {left:0,top:0,width:512,height:512};}setPointerCapture(){} click(){this.dispatchEvent(new Event("click"));}toDataURL(){return "data:";}
}
const raster={createLinearGradient(){return {addColorStop(){}};},beginPath(){},arc(){},stroke(){},fillRect(){},fillText(){},strokeRect(){},createImageData(w,h){return {data:new Uint8ClampedArray(w*h*4)};},getImageData(x,y,w,h){return {data:new Uint8ClampedArray(w*h*4)};},putImageData(){}};
const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,new Element(id));return elements.get(id);};
const root={querySelector:s=>get(s.slice(1)),querySelectorAll:()=>[]};
globalThis.document={createElement:()=>new Element("")};globalThis.ImageData=class{constructor(data,w,h){this.data=data;this.width=w;this.height=h;}};
const cleanup=initLab(root,e);assert.equal(get("print").disabled,false);assert.match(get("status").textContent,/ドラッグ/);
e.paint_ink(256,256,45,.8,0,0xbc3d32); get("print").click();await new Promise(r=>setTimeout(r,340));assert.equal(e.impression_count(),1);assert(sum(ink())>0);
get("dry").click();assert.equal(sum(ink()),0);get("clear").click();assert.equal(e.impression_count(),0);
get("inkMode").value="paint";get("inkMode").dispatchEvent(new Event("change"));assert.equal(get("paintControls").hidden,false);
get("clearInk").click();assert.equal(sum(coat()),0);
cleanup();get("dry").click();assert.equal(sum(float(e.dry_ptr(),S*3)),0);
console.log("PASS: actual Rust WASM transfer, zero pressure, drying, overprint, hand-coating depletion, mirror-gradient, DOM controller, listener cleanup");
