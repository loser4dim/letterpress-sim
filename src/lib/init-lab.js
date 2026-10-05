export function initLab(root, engine) {
const abort = new AbortController();
const listen = (el, event, callback) => el.addEventListener(event, callback, { signal: abort.signal });
const $ = (id) => root.querySelector("#" + id);
const N = 640, M = 512;
const paper = $("paper"), ctx = paper.getContext("2d"), plate = $("plate");
const source = document.createElement("canvas"); source.width = source.height = M;
const sx = source.getContext("2d", {willReadFrequently: true});
const config = [
  ["ink", "インクの量", 55], ["pressure", "押す圧", 55],
  ["roughness", "紙の粗さ", 55], ["speed", "剥がす速度", 40],
  ["viscosity", "インクの粘度", 60]
];
let mask = new Float32Array(M * M), count = 0, printing = false;
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
function val(id) { return Number($(id).value); }
function outputs() { for (const id of ["threshold", "offsetX", "offsetY", "gradientEnd", "brushSize", ...config.map(c => c[0])]) $(id + "Out").textContent = $(id).value; }
function newPaper() {
  engine.new_paper(); count = 0;
  $("empty").hidden = false; $("count").textContent = "0 IMPRESSIONS";
  $("status").textContent = "新しい紙をセットしました"; render();
}
function render() {
  const bytes = new Uint8ClampedArray(engine.memory.buffer, engine.image_ptr(), N * N * 4).slice();
  ctx.putImageData(new ImageData(bytes, N, N), 0, 0);
}
function makePlate() {
  const img = sx.getImageData(0, 0, M, M);
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    const i = y * M + x, p = i * 4;
    const gray = .2126 * img.data[p] + .7152 * img.data[p+1] + .0722 * img.data[p+2];
    const black = gray < val("threshold"); mask[i] = ($("invert").checked ? !black : black) ? 1 : 0;

  }
  new Float32Array(engine.memory.buffer, engine.mask_ptr(), M * M).set(mask);
  showPlate();
}
function sample() {
  sx.fillStyle = "white"; sx.fillRect(0, 0, M, M); sx.fillStyle = "black";
  sx.strokeStyle = "black"; sx.lineWidth = 3; sx.strokeRect(38, 38, 436, 436);
  sx.font = "bold 118px serif"; sx.textAlign = "center"; sx.fillText("活版", 256, 225);
  sx.font = "bold 62px serif"; sx.fillText("実験室", 256, 320);
  sx.font = "18px serif"; sx.fillText("INK · PAPER · PRESS", 256, 384);
  sx.fillRect(118, 415, 276, 5); makePlate();
}
const mode = () => ({uniform: 0, gradient: 1, paint: 2})[$("inkMode").value];
const rgb = () => parseInt($("color").value.slice(1), 16);
function imprint() {
  const start = performance.now();
  engine.print(val("pressure") / 100, val("roughness") / 100, val("speed") / 100, val("viscosity") / 100, val("ink") / 100, mode(), val("gradientEnd") / 100, val("gradientAngle"), val("direction"), val("offsetX"), val("offsetY"), rgb());
  const ms = (performance.now() - start).toFixed(1);
  count = engine.impression_count(); showPlate(); render();
  $("empty").hidden = true; $("count").textContent = count + " IMPRESSIONS";
  $("status").textContent = count + "回目の刷り。インクは湿っています。";
  $("timing").textContent = "Rust計算: " + ms + " ms";
}
listen($("print"), "click", async () => {
  if (printing) return; printing = true; $("print").disabled = true;
  paper.classList.remove("pressing"); void paper.offsetWidth; paper.classList.add("pressing");
  $("status").textContent = "版を押し、紙を剥がしています…";
  await new Promise(resolve => setTimeout(resolve, 300));
  try { if (!abort.signal.aborted) imprint(); } finally { printing = false; $("print").disabled = false; }
});
listen($("clear"), "click", () => { if (!printing) newPaper(); });
listen($("dry"), "click", () => {
  if (printing) return;
  engine.dry_ink();
  $("status").textContent = "インクを乾かしました。次の色は独立した層として重なります。"; render();
});
listen($("download"), "click", () => { const a = document.createElement("a"); a.download = "letterpress-" + count + ".png"; a.href = paper.toDataURL("image/png"); a.click(); });
listen($("threshold"), "input", makePlate); listen($("invert"), "change", makePlate);
listen($("sample"), "click", () => { $("invert").checked = false; $("threshold").value = 150; outputs(); sample(); });
root.querySelectorAll("input[type=range]").forEach(el => listen(el, "input", outputs));
root.querySelectorAll("[data-color]").forEach(el => listen(el, "click", () => { $("color").value = el.dataset.color; }));
listen($("upload"), "change", async event => {
  const f = event.target.files[0]; if (!f) return;
  if (f.size > 20 * 1024 * 1024) { $("status").textContent = "画像は20MB以下で選んでください。"; return; }
  const url = URL.createObjectURL(f), img = new Image();
  try {
    img.src = url; await img.decode();
    if (abort.signal.aborted) return;
    const scale = Math.min((M - 32) / img.width, (M - 32) / img.height);
    sx.fillStyle = "white"; sx.fillRect(0, 0, M, M);
    sx.drawImage(img, (M-img.width*scale)/2, (M-img.height*scale)/2, img.width*scale, img.height*scale);
    makePlate(); $("status").textContent = "画像から版を作りました。黒い部分が印刷されます。";
  } catch { $("status").textContent = "画像を読み込めませんでした。PNGやJPEGをお試しください。"; }
  finally { URL.revokeObjectURL(url); }
});
function showPlate() {
  engine.update_plate(mode(), val("ink") / 100, val("gradientEnd") / 100, val("gradientAngle"), rgb());
  const bytes = new Uint8ClampedArray(engine.memory.buffer, engine.plate_ptr(), M * M * 4).slice();
  plate.getContext("2d").putImageData(new ImageData(bytes, M, M), 0, 0);
}
function paintAt(x, y) {
  engine.paint_ink(x, y, val("brushSize"), val("ink") / 100, $("eraseInk").checked ? 1 : 0);
}
let dragging=false, previous=null, cursor={x:256,y:256};
function paintEvent(e) {
  const box=plate.getBoundingClientRect();
  const pos={x:clamp(M-1-(e.clientX-box.left)/box.width*M,0,M-1),y:clamp((e.clientY-box.top)/box.height*M,0,M-1)};
  if(previous){const steps=Math.ceil(Math.hypot(pos.x-previous.x,pos.y-previous.y)/Math.max(4,val("brushSize")/3));for(let k=1;k<=steps;k++)paintAt(previous.x+(pos.x-previous.x)*k/steps,previous.y+(pos.y-previous.y)*k/steps);}else paintAt(pos.x,pos.y);
  previous=pos;cursor=pos;showPlate();
}
listen(plate, "pointerdown",e=>{if($("inkMode").value!=="paint"||printing)return;dragging=true;previous=null;plate.setPointerCapture(e.pointerId);paintEvent(e);});
listen(plate, "pointermove",e=>{if(dragging)paintEvent(e);});
for(const ev of ["pointerup","pointercancel","lostpointercapture"])listen(plate, ev,()=>{dragging=false;previous=null;});
listen(plate, "keydown",e=>{if($("inkMode").value!=="paint")return;if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"," "].includes(e.key)){e.preventDefault();if(e.key==="ArrowLeft")cursor.x+=12;if(e.key==="ArrowRight")cursor.x-=12;if(e.key==="ArrowUp")cursor.y-=12;if(e.key==="ArrowDown")cursor.y+=12;cursor.x=clamp(cursor.x,0,M-1);cursor.y=clamp(cursor.y,0,M-1);paintAt(cursor.x,cursor.y);showPlate();}});
listen($("inkMode"), "change",()=>{$("gradientControls").hidden=$("inkMode").value!=="gradient";$("paintControls").hidden=$("inkMode").value!=="paint";showPlate();});
listen($("clearInk"), "click",()=>{engine.clear_ink();showPlate();});
for(const id of ["ink","gradientEnd","gradientAngle","color"])listen($(id), "input", showPlate);
root.querySelectorAll("[data-color]").forEach(el=>listen(el, "click",showPlate));
outputs(); sample(); newPaper();
$("print").disabled = false;
$("engineStatus").textContent = "Rust / WebAssembly · READY";
return () => abort.abort();
}
