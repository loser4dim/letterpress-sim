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
  $("empty").hidden = false; $("count").textContent = "0回";
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
    const component = ({red: img.data[p], green: img.data[p+1], blue: img.data[p+2]})[$("separation").value] ?? gray;
    let density = clamp((255 - component) / 255 * val("threshold") / 128);
    if ($("invert").checked) density = 1 - density;
    const cell = 8;
    const dx = (x % cell + 0.5) / cell - 0.5, dy = (y % cell + 0.5) / cell - 0.5;
    // Area of circular dots encodes tone; highlights remain clear and shadows become solid.
    mask[i] = $("plateMode").value === "binary"
      ? (($("invert").checked ? component >= val("threshold") : component < val("threshold")) ? 1 : 0)
      : (density >= 0.98 || Math.PI * (dx * dx + dy * dy) < density ? 1 : 0);

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
  sx.fillRect(118, 415, 276, 5); engine.clear_ink(); makePlate();
}
const mode = () => ({uniform: 0, gradient: 1, paint: 2})[$("inkMode").value];
const rgb = () => parseInt($("color").value.slice(1), 16);
function imprint() {

  engine.print(val("pressure") / 100, val("roughness") / 100, val("speed") / 100, val("viscosity") / 100, val("ink") / 100, mode(), val("gradientEnd") / 100, val("gradientAngle"), val("direction"), val("offsetX"), val("offsetY"), rgb());

  count = engine.impression_count(); showPlate(); render();
  $("empty").hidden = true; $("count").textContent = count + "回";
  $("status").textContent = count + "回目の刷り。インクは湿っています。";

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
listen($("separation"), "change", makePlate); listen($("plateMode"), "change", makePlate);
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
    engine.clear_ink(); makePlate(); $("status").textContent = "画像を単色用の版に変換しました。版にインクを塗ってください。";
  } catch { $("status").textContent = "画像を読み込めませんでした。PNGやJPEGをお試しください。"; }
  finally { URL.revokeObjectURL(url); }
});
function showPlate() {
  engine.update_plate(mode(), val("ink") / 100, val("gradientEnd") / 100, val("gradientAngle"), rgb());
  const bytes = new Uint8ClampedArray(engine.memory.buffer, engine.plate_ptr(), M * M * 4).slice();
  const context = plate.getContext("2d");
  context.fillStyle = "#ada79a"; context.fillRect(0, 0, N, N);
  context.putImageData(new ImageData(bytes, M, M), 64, 64);
  $("colorOut").textContent = $("color").value.toUpperCase();
}
let saturation=0.734, brightness=0.737;
function hsv(h,s,v) {
  const f=n=>{const k=(n+h/60)%6;return Math.round((v-v*s*Math.max(0,Math.min(k,4-k,1)))*255);};
  return "#"+[f(5),f(3),f(1)].map(n=>n.toString(16).padStart(2,"0")).join("");
}
function drawPicker() {
  const canvas=$("colorPalette"), context=canvas.getContext("2d"), h=val("colorHue");
  context.fillStyle=hsv(h,1,1); context.fillRect(0,0,canvas.width,canvas.height);
  const white=context.createLinearGradient(0,0,canvas.width,0);white.addColorStop(0,"white");white.addColorStop(1,"transparent");
  context.fillStyle=white;context.fillRect(0,0,canvas.width,canvas.height);
  const black=context.createLinearGradient(0,0,0,canvas.height);black.addColorStop(0,"transparent");black.addColorStop(1,"black");
  context.fillStyle=black;context.fillRect(0,0,canvas.width,canvas.height);
  context.beginPath();context.arc(saturation*canvas.width,(1-brightness)*canvas.height,5,0,Math.PI*2);context.strokeStyle="white";context.lineWidth=2;context.stroke();
}
function pickColor() {$("color").value=hsv(val("colorHue"),saturation,brightness);drawPicker();showPlate();}
let picking=false;
function paletteEvent(e) {const box=$("colorPalette").getBoundingClientRect();saturation=clamp((e.clientX-box.left)/box.width);brightness=1-clamp((e.clientY-box.top)/box.height);pickColor();}
listen($("colorPalette"),"pointerdown",e=>{picking=true;$("colorPalette").setPointerCapture(e.pointerId);paletteEvent(e);});
listen($("colorPalette"),"pointermove",e=>{if(picking)paletteEvent(e);});
for(const event of ["pointerup","pointercancel","lostpointercapture"])listen($("colorPalette"),event,()=>{picking=false;});
listen($("colorPalette"),"keydown",e=>{if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key))return;e.preventDefault();saturation=clamp(saturation+(e.key==="ArrowRight"?.02:e.key==="ArrowLeft"?-.02:0));brightness=clamp(brightness+(e.key==="ArrowUp"?.02:e.key==="ArrowDown"?-.02:0));pickColor();});
listen($("colorHue"),"input",pickColor);
listen($("color"),"input",()=>{
  const hex=rgb(), r=(hex>>16&255)/255,g=(hex>>8&255)/255,b=(hex&255)/255;
  const max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
  brightness=max;saturation=max===0?0:delta/max;
  if(delta>0)$("colorHue").value=((max===r?(g-b)/delta:max===g?(b-r)/delta+2:(r-g)/delta+4)*60+360)%360;
  drawPicker();
});
drawPicker();
function paintAt(x, y) {
  engine.paint_ink(x, y, val("brushSize"), val("ink") / 100, $("eraseInk").checked ? 1 : 0, rgb());
}
let dragging=false, previous=null, cursor={x:256,y:256};
function paintEvent(e) {
  const box=plate.getBoundingClientRect();
  const displayX=(e.clientX-box.left)/box.width*N-64, displayY=(e.clientY-box.top)/box.height*N-64;
  if (displayX<0 || displayY<0 || displayX>=M || displayY>=M) {previous=null; return;}
  const pos={x:M-1-displayX,y:displayY};
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
engine.clear_ink(); outputs(); sample(); newPaper();
$("gradientControls").hidden=$("inkMode").value!=="gradient";
$("paintControls").hidden=$("inkMode").value!=="paint";
$("print").disabled = false;
$("status").textContent = "版をドラッグしてインクを塗ってください。";
return () => abort.abort();
}
