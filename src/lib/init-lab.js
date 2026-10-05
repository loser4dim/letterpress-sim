export function initLab(root, engine) {
  const abort = new AbortController();
  const $ = id => root.querySelector("#" + id);
  const N = 640, M = 512, SOURCE = engine.sizes.source;
  $("resolution").value = String(engine.sizes.simulation);
  const paper = $("paper"), plate = $("plate");
  const ctx = paper.getContext("2d");
  const source = document.createElement("canvas");
  source.width = source.height = SOURCE;
  const sx = source.getContext("2d", { willReadFrequently: true });
  let count = 0, busy = false;
  const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
  const val = id => Number($(id).value);
  const rgb = () => parseInt($("color").value.slice(1), 16);
  const mode = () => ({ uniform: 0, gradient: 1, paint: 2 })[$("inkMode").value];
  const status = text => { if (!abort.signal.aborted) $("status").textContent = text; };
  const failure = error => status("処理に失敗しました。ページを再読み込みしてください。" + (error.message ?? ""));
  const listen = (element, event, callback) => element.addEventListener(event, e => {
    if (abort.signal.aborted) return;
    try { Promise.resolve(callback(e)).catch(error => { if (!abort.signal.aborted) failure(error); }); }
    catch (error) { failure(error); }
  }, { signal: abort.signal });
  listen($("restartResolution"), "click", () => {
    if (busy) return;
    const url = new URL(location.href);
    url.searchParams.set("resolution", $("resolution").value);
    location.assign(url.href);
  });
  function lock(value) {
    busy = value;
    root.querySelectorAll("input, select, button").forEach(element => { element.disabled = value; });
  }
  async function action(callback) {
    if (busy) return;
    lock(true);
    try { await callback(); } finally { if (!abort.signal.aborted) lock(false); }
  }
  function outputs() {
    for (const id of ["threshold", "offsetX", "offsetY", "gradientEnd", "brushSize", "ink", "pressure", "roughness", "speed", "viscosity"]) $(id + "Out").textContent = $(id).value;
  }
  async function render() {
    const bytes = await engine.call("preview");
    if (!abort.signal.aborted) ctx.putImageData(new ImageData(bytes, N, N), 0, 0);
  }
  let plateDirty = false, plateUpdating = false;
  async function showPlate() {
    plateDirty = true;
    if (plateUpdating) return;
    plateUpdating = true;
    try {
      while (plateDirty && !abort.signal.aborted) {
        plateDirty = false;
        const bytes = await engine.call("plate", [mode(), val("ink") / 100, val("gradientEnd") / 100, val("gradientAngle"), rgb()]);
        if (abort.signal.aborted) break;
        const context = plate.getContext("2d");
        context.fillStyle = "#ada79a"; context.fillRect(0, 0, N, N);
        context.putImageData(new ImageData(bytes, M, M), 64, 64);
        $("colorOut").textContent = $("color").value.toUpperCase();
      }
    } finally { plateUpdating = false; }
  }
  async function makePlate() {
    await engine.call("configure", [$("plateMode").value === "binary" ? 1 : 0, val("threshold"), $("invert").checked ? 1 : 0]);
    await showPlate();
  }
  async function uploadSource() {
    const gray = new Uint8Array(SOURCE * SOURCE);
    const separation = $("separation").value;
    const channel = ({ red: 0, green: 1, blue: 2 })[separation];
    for (let y = 0; y < SOURCE; y += 64) {
      if (abort.signal.aborted) return;
      const rows = Math.min(64, SOURCE - y);
      const pixels = sx.getImageData(0, y, SOURCE, rows).data;
      for (let i = 0; i < SOURCE * rows; i++) {
        const p = i * 4;
        gray[y * SOURCE + i] = channel === undefined
          ? Math.round(.2126 * pixels[p] + .7152 * pixels[p + 1] + .0722 * pixels[p + 2])
          : pixels[p + channel];
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    await engine.call("source", [gray], [gray.buffer]);
    await makePlate();
  }
  function drawSample() {
    sx.setTransform(SOURCE / M, 0, 0, SOURCE / M, 0, 0);
    sx.fillStyle = "white"; sx.fillRect(0, 0, M, M); sx.fillStyle = "black";
    sx.strokeStyle = "black"; sx.lineWidth = 3; sx.strokeRect(38, 38, 436, 436);
    sx.font = "bold 118px serif"; sx.textAlign = "center"; sx.fillText("活版", 256, 225);
    sx.font = "bold 62px serif"; sx.fillText("実験室", 256, 320);
    sx.font = "18px serif"; sx.fillText("INK · PAPER · PRESS", 256, 384);
    sx.fillRect(118, 415, 276, 5);
    sx.resetTransform();
  }
  async function newPaper() {
    await engine.call("new"); count = 0;
    if (abort.signal.aborted) return;
    $("empty").hidden = false; $("count").textContent = "0回";
    status("新しい紙をセットしました"); await render();
  }
  listen($("print"), "click", () => action(async () => {
    paper.classList.remove("pressing"); void paper.offsetWidth; paper.classList.add("pressing");
    count = await engine.call("print", [val("pressure") / 100, val("roughness") / 100, val("speed") / 100, val("viscosity") / 100, val("ink") / 100, mode(), val("gradientEnd") / 100, val("gradientAngle"), val("direction"), val("offsetX"), val("offsetY"), rgb()], [], percent => status("刷っています… " + percent + "%"));
    if (abort.signal.aborted) return;
    $("empty").hidden = true; $("count").textContent = count + "回";
    await showPlate(); await render(); status(count + "回目の刷り。インクは湿っています。");
  }));
  listen($("clear"), "click", () => action(newPaper));
  listen($("dry"), "click", () => action(async () => {
    status("インクを乾かしています…"); await engine.call("dry"); await render();
    status("インクを乾かしました。次の色は独立した層として重なります。");
  }));
  listen($("download"), "click", () => action(async () => {
    status("保存する画像を作っています…");
    const transparent = $("transparentExport").checked;
    const bytes = await engine.call("export", [transparent]);
    if (abort.signal.aborted) return;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = engine.sizes.output;
    canvas.getContext("2d").putImageData(new ImageData(bytes, canvas.width, canvas.height), 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    canvas.width = canvas.height = 1;
    if (!blob) throw new Error("PNGを作成できませんでした");
    if (abort.signal.aborted) return;
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.download = "letterpress-" + count + (transparent ? "-ink" : "") + "-4096.png"; a.href = url; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); status("画像を保存しました。");
  }));
  listen($("separation"), "change", () => action(async () => { status("画像から版を作っています…"); await uploadSource(); status("版を更新しました。"); }));
  listen($("plateMode"), "change", makePlate);
  listen($("threshold"), "input", makePlate); listen($("invert"), "change", makePlate);
  listen($("sample"), "click", () => action(async () => {
    $("invert").checked = false; $("threshold").value = 150; outputs(); drawSample();
    await engine.call("clear"); await uploadSource(); status("版をドラッグしてインクを塗ってください。");
  }));
  root.querySelectorAll("input[type=range]").forEach(element => listen(element, "input", outputs));
  listen($("upload"), "change", event => action(async () => {
    const file = event.target.files[0]; if (!file) return;
    if (file.size > 20 * 1024 * 1024) { status("画像は20MB以下で選んでください。"); return; }
    const url = URL.createObjectURL(file), image = new Image();
    try {
      status("画像から版を作っています…"); image.src = url; await image.decode();
      if (abort.signal.aborted) return;
      const margin = SOURCE * 32 / M;
      const scale = Math.min((SOURCE - margin) / image.width, (SOURCE - margin) / image.height);
      sx.fillStyle = "white"; sx.fillRect(0, 0, SOURCE, SOURCE);
      sx.drawImage(image, (SOURCE - image.width * scale) / 2, (SOURCE - image.height * scale) / 2, image.width * scale, image.height * scale);
      await engine.call("clear"); await uploadSource(); status("画像を単色用の版に変換しました。版にインクを塗ってください。");
    } finally { URL.revokeObjectURL(url); }
  }));
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
function pickColor() {if(busy)return;$("color").value=hsv(val("colorHue"),saturation,brightness);drawPicker();return showPlate();}
let picking=false;
function paletteEvent(e) {const box=$("colorPalette").getBoundingClientRect();saturation=clamp((e.clientX-box.left)/box.width);brightness=1-clamp((e.clientY-box.top)/box.height);return pickColor();}
listen($("colorPalette"),"pointerdown",e=>{if(busy)return;picking=true;$("colorPalette").setPointerCapture(e.pointerId);return paletteEvent(e);});
listen($("colorPalette"),"pointermove",e=>{if(picking&&!busy)return paletteEvent(e);});
for(const event of ["pointerup","pointercancel","lostpointercapture"])listen($("colorPalette"),event,()=>{picking=false;});
listen($("colorPalette"),"keydown",e=>{if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key))return;e.preventDefault();saturation=clamp(saturation+(e.key==="ArrowRight"?.02:e.key==="ArrowLeft"?-.02:0));brightness=clamp(brightness+(e.key==="ArrowUp"?.02:e.key==="ArrowDown"?-.02:0));return pickColor();});
listen($("colorHue"),"input",pickColor);
listen($("color"),"input",()=>{
  const hex=rgb(), r=(hex>>16&255)/255,g=(hex>>8&255)/255,b=(hex&255)/255;
  const max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
  brightness=max;saturation=max===0?0:delta/max;
  if(delta>0)$("colorHue").value=((max===r?(g-b)/delta:max===g?(b-r)/delta+2:(r-g)/delta+4)*60+360)%360;
  drawPicker();
});
drawPicker();
  let dragging = false, previous = null, cursor = { x: 256, y: 256 };
  function paintPositions(positions) {
    const promise = engine.call("paint", [positions, val("brushSize"), val("ink") / 100, $("eraseInk").checked ? 1 : 0, rgb()]);
    return promise.then(showPlate);
  }
  function paintEvent(event) {
    const box = plate.getBoundingClientRect();
    const displayX = (event.clientX - box.left) / box.width * N - 64;
    const displayY = (event.clientY - box.top) / box.height * N - 64;
    if (displayX < 0 || displayY < 0 || displayX >= M || displayY >= M) { previous = null; return; }
    const pos = { x: M - 1 - displayX, y: displayY }, positions = [];
    if (previous) {
      const steps = Math.ceil(Math.hypot(pos.x - previous.x, pos.y - previous.y) / Math.max(4, val("brushSize") / 3));
      for (let k = 1; k <= steps; k++) positions.push([previous.x + (pos.x - previous.x) * k / steps, previous.y + (pos.y - previous.y) * k / steps]);
    } else positions.push([pos.x, pos.y]);
    previous = pos; cursor = pos;
    return paintPositions(positions);
  }
  listen(plate, "pointerdown", event => { if (busy || $("inkMode").value !== "paint") return; dragging = true; previous = null; plate.setPointerCapture(event.pointerId); return paintEvent(event); });
  listen(plate, "pointermove", event => { if (dragging && !busy) return paintEvent(event); });
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) listen(plate, event, () => { dragging = false; previous = null; });
  listen(plate, "keydown", event => {
    if (busy || $("inkMode").value !== "paint" || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "ArrowLeft") cursor.x += 12; if (event.key === "ArrowRight") cursor.x -= 12;
    if (event.key === "ArrowUp") cursor.y -= 12; if (event.key === "ArrowDown") cursor.y += 12;
    cursor.x = clamp(cursor.x, 0, M - 1); cursor.y = clamp(cursor.y, 0, M - 1);
    return paintPositions([[cursor.x, cursor.y]]);
  });
  listen($("inkMode"), "change", () => { $("gradientControls").hidden = $("inkMode").value !== "gradient"; $("paintControls").hidden = $("inkMode").value !== "paint"; return showPlate(); });
  listen($("clearInk"), "click", () => action(async () => { await engine.call("clear"); await showPlate(); }));
  for (const id of ["ink", "gradientEnd", "gradientAngle", "color"]) listen($(id), "input", showPlate);
  outputs();
  $("gradientControls").hidden = $("inkMode").value !== "gradient";
  $("paintControls").hidden = $("inkMode").value !== "paint";
  lock(true);
  (async () => {
    try {
      drawSample(); await engine.call("clear"); await uploadSource(); await newPaper();
      status("版をドラッグしてインクを塗ってください。");
    } catch (error) { if (!abort.signal.aborted) failure(error); }
    finally { if (!abort.signal.aborted) lock(false); }
  })();
  return () => { abort.abort(); engine.dispose(); source.width = source.height = 1; };
}
