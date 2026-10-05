import { canPlace, findSpace, rasterizePlate } from "../../public/wasm/plate-tools.js";
export function initLab(root, engine) {
  const abort = new AbortController(), $ = id => root.querySelector("#" + id);
  const N=640,M=512,plate=$("plate"),paper=$("paper"),ctx=paper.getContext("2d");
  const blocks=[]; let selectedId=null, nextId=1, count=0, busy=false, plateImage=null, rollerDirty=true;
  const clamp=(v,lo=0,hi=1)=>Math.max(lo,Math.min(hi,v));
  const val=id=>Number($(id).value), rgb=()=>parseInt($("color").value.slice(1),16);
  const mode=()=>({uniform:0,gradient:1,paint:2})[$("inkMode").value];
  const selected=()=>blocks.find(b=>b.id===selectedId);
  const status=text=>{if(!abort.signal.aborted) $("status").textContent=text;};
  const notice=text=>{if(!abort.signal.aborted) {$("plateStatus").textContent=text;status(text);}};
  const failure=error=>notice("処理に失敗しました。"+(error.message??error));
  const listen=(element,event,callback)=>element.addEventListener(event,e=>{
    if(abort.signal.aborted)return;
    try {Promise.resolve(callback(e)).catch(error=>{if(!abort.signal.aborted)failure(error);});} catch(error){failure(error);}
  },{signal:abort.signal});
  const settingIds=["plateMode","separation","threshold","screen","tone","blockSize","invert","removeBlock"];
  function controls() {
    root.querySelectorAll("input,select,button").forEach(e=>{e.disabled=busy;});
    for(const id of settingIds) $(id).disabled=busy||!selected();
    $("print").disabled=busy||blocks.length===0;
  }
  async function action(callback) {
    if(busy)return; busy=true;controls();
    try {await callback();} finally {if(!abort.signal.aborted){busy=false;controls();}}
  }
  function outputs(){root.querySelectorAll("input[type=range]").forEach(e=>{const out=$(e.id+"Out");if(out)out.textContent=e.value;});}
  function syncSelection() {
    const list=$("blockList");list.replaceChildren();
    for(const b of blocks){const option=document.createElement("option");option.value=String(b.id);option.textContent=b.name;list.append(option);}
    const b=selected(); if(b){list.value=String(b.id);$("plateMode").value=b.kind;$("separation").value=b.separation;$("threshold").value=b.threshold;$("screen").value=b.screen;$("tone").value=b.tone;$("invert").checked=b.invert;$("blockSize").value=Math.round(b.w);}
    outputs();controls();
  }
  function grayBlock(b,copy=false) {
    if(!b.grayCache||b.grayChannel!==b.separation){
      const gray=new Uint8Array(b.iw*b.ih),channel=({red:0,green:1,blue:2})[b.separation];
      for(let i=0;i<gray.length;i++) {const k=i*4;gray[i]=channel===undefined?Math.round(.2126*b.rgba[k]+.7152*b.rgba[k+1]+.0722*b.rgba[k+2]):b.rgba[k+channel];}
      b.grayCache=gray;b.grayChannel=b.separation;
    }
    return {id:b.id,x:b.x,y:b.y,w:b.w,h:b.h,iw:b.iw,ih:b.ih,kind:b.kind,threshold:b.threshold,screen:b.screen,tone:b.tone,invert:b.invert,gray:copy?b.grayCache.slice():b.grayCache};
  }
  let previewFrame=0, cursor=null, rolling=false, drag=null;
  function drawPlate() {
    if(abort.signal.aborted)return;
    const context=plate.getContext("2d");context.fillStyle="#ada79a";context.fillRect(0,0,N,N);
    if($("plateTool").value==="compose") {
      const mask=rasterizePlate(blocks.map(b=>grayBlock(b)),M),bytes=new Uint8ClampedArray(M*M*4);
      for(let i=0;i<mask.length;i++){const shade=mask[i]===0?98:188,k=(Math.floor(i/M)*M+M-1-i%M)*4;bytes[k]=shade;bytes[k+1]=shade-3;bytes[k+2]=shade-8;bytes[k+3]=255;}
      context.putImageData(new ImageData(bytes,M,M),64,64);
    } else if(plateImage)context.putImageData(plateImage,64,64);
    for(const b of blocks){const x=64+M-b.x-b.w,y=64+b.y;context.strokeStyle=b.id===selectedId&&$("plateTool").value==="compose"?"#ad3e30":"#766e61";context.lineWidth=b.id===selectedId?2:1;context.strokeRect(x,y,b.w,b.h);if($("plateTool").value==="compose"){context.fillStyle="#302c26";context.font="12px system-ui";context.fillText(String(blocks.indexOf(b)+1),x+5,y+15);}}
    if(cursor&&$("plateTool").value==="ink"&&mode()===2){
      const x=64+M-cursor.x,y=64+cursor.y,a=cursor.angle??0,r=val("brushSize")/2;
      context.save();context.translate(x,y);context.rotate(-a);context.strokeStyle=$("eraseInk").checked?"#fff":"#ad3e30";context.lineWidth=2;context.strokeRect(-4,-r,8,r*2);context.restore();
    }
  }
  function schedulePreview(){if(previewFrame)return;previewFrame=requestAnimationFrame(()=>{previewFrame=0;drawPlate();});}
  let plateDirty=false,plateUpdating=false;
  async function showPlate(){
    if($("plateTool").value==="compose"){schedulePreview();return;}
    plateDirty=true;if(plateUpdating)return;plateUpdating=true;
    try{while(plateDirty&&!abort.signal.aborted){plateDirty=false;const bytes=await engine.call("plate",[mode(),val("ink")/100,val("gradientEnd")/100,val("gradientAngle"),rgb()]);if(!abort.signal.aborted){plateImage=new ImageData(bytes,M,M);drawPlate();}}}finally{plateUpdating=false;}
  }
  async function rebuild() {
    notice("版を組んでいます…");const data=blocks.map(b=>grayBlock(b,true));
    await engine.call("compose",[data],data.map(b=>b.gray.buffer));
    if(abort.signal.aborted)return;plateImage=null;await showPlate();notice("版を更新しました。インクを載せ直してください。");
  }
  async function render(){const bytes=await engine.call("preview");if(!abort.signal.aborted)ctx.putImageData(new ImageData(bytes,N,N),0,0);}
  function fitBlock(rgba,iw,ih,name,kind="halftone") {
    if(blocks.length>=16){notice("版は16個まで追加できます。");return false;}
    let longest=blocks.length===0?420:240,rect=null;
    while(longest>=32){const w=Math.max(8,Math.round(longest*Math.min(1,iw/ih))),h=Math.max(8,Math.round(longest*Math.min(1,ih/iw)));rect=findSpace(w,h,blocks);if(rect)break;longest*=.88;}
    if(!rect){notice("版を置く空きがありません。既存の版を小さくするか、外してください。");return false;}
    const b={...rect,id:nextId++,name,rgba,iw,ih,kind,separation:"luminance",threshold:150,screen:128,tone:125,invert:false};blocks.push(b);selectedId=b.id;return true;
  }
  listen($("upload"),"change",event=>action(async()=>{
    let added=0;
    for(const file of event.target.files){if(file.size>20*1024*1024){notice(file.name+"は20MB以下で選んでください。");continue;}
      const url=URL.createObjectURL(file),image=new Image();
      try{image.src=url;await image.decode();if(abort.signal.aborted)return;const scale=Math.min(1,2048/Math.max(image.width,image.height)),canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));const c=canvas.getContext("2d",{willReadFrequently:true});c.fillStyle="white";c.fillRect(0,0,canvas.width,canvas.height);c.drawImage(image,0,0,canvas.width,canvas.height);if(fitBlock(c.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height,file.name))added++;canvas.width=canvas.height=1;
      }catch(error){notice(file.name+"を読み込めませんでした。"+(error.message??""));}finally{URL.revokeObjectURL(url);}
    }
    $("upload").value="";syncSelection();if(added)await rebuild();
  }));
  listen($("sample"),"click",()=>action(async()=>{
    const canvas=document.createElement("canvas");canvas.width=1024;canvas.height=640;const c=canvas.getContext("2d");c.fillStyle="white";c.fillRect(0,0,1024,640);c.fillStyle="black";c.strokeStyle="black";c.lineWidth=6;c.strokeRect(25,25,974,590);c.font="bold 190px serif";c.textAlign="center";c.fillText("活版",512,280);c.font="bold 98px serif";c.fillText("実験室",512,425);c.font="32px serif";c.fillText("INK · PAPER · PRESS",512,530);
    if(fitBlock(c.getImageData(0,0,1024,640).data,1024,640,"活版実験室（文字）","binary")){syncSelection();await rebuild();}
  }));
  listen($("blockList"),"change",()=>{selectedId=Number($("blockList").value);syncSelection();schedulePreview();});
  listen($("removeBlock"),"click",()=>action(async()=>{const i=blocks.findIndex(b=>b.id===selectedId);if(i>=0)blocks.splice(i,1);selectedId=blocks.at(-1)?.id??null;syncSelection();await rebuild();}));
  for(const id of ["plateMode","separation","threshold","screen","tone","invert"])listen($(id),"change",()=>action(async()=>{
    const b=selected();if(!b)return;b.kind=$("plateMode").value;b.separation=$("separation").value;b.threshold=val("threshold");b.screen=val("screen");b.tone=val("tone");b.invert=$("invert").checked;await rebuild();
  }));
  listen($("blockSize"),"change",()=>action(async()=>{const b=selected();if(!b)return;const w=val("blockSize"),h=Math.max(8,Math.round(w*b.ih/b.iw));const rect={...b,w,h};rect.x=clamp(rect.x,0,M-w);rect.y=clamp(rect.y,0,M-h);if(canPlace(rect,blocks)){Object.assign(b,{x:rect.x,y:rect.y,w,h});await rebuild();}else notice("その大きさでは台座が重なるか、版面からはみ出します。");syncSelection();schedulePreview();}));
  function toolChanged(){cursor=null;$("plateCaption").textContent=$("plateTool").value==="compose"?"鏡像の版面 · 台座をドラッグして組版":"鏡像の版面 · ローラーをドラッグしてインクを載せる";plate.style.cursor=$("plateTool").value==="compose"?"grab":"crosshair";return showPlate();}
  listen($("plateTool"),"change",toolChanged);
  async function ensureRoller(){if(!rollerDirty)return;rollerDirty=false;await engine.call("rollerLoad",[val("brushSize"),val("ink")/100,$("eraseInk").checked?1:0,rgb()]);}
  listen($("reloadRoller"),"click",()=>action(async()=>{rollerDirty=true;await ensureRoller();notice("選んだ色のインクをローラーに補充しました。");}));
  for(const id of ["brushSize","ink","eraseInk","color"])listen($(id),"input",()=>{rollerDirty=true;});
  function point(event){const box=plate.getBoundingClientRect();return{x:M-((event.clientX-box.left)/box.width*N-64),y:(event.clientY-box.top)/box.height*N-64};}
  function inside(p){return p.x>=0&&p.y>=0&&p.x<M&&p.y<M;}
  let previous=null;
  listen(plate,"pointerdown",e=>{
    if(busy)return;const p=point(e);if(!inside(p))return;plate.setPointerCapture(e.pointerId);
    if($("plateTool").value==="compose"){const b=blocks.find(b=>p.x>=b.x&&p.x<b.x+b.w&&p.y>=b.y&&p.y<b.y+b.h);if(!b)return;selectedId=b.id;drag={point:p,x:b.x,y:b.y,moved:false};syncSelection();schedulePreview();}
    else if(mode()===2){rolling=true;previous=p;cursor={...p,angle:0};schedulePreview();return ensureRoller();}
  });
  listen(plate,"pointermove",e=>{
    if(busy)return;const p=point(e);
    if(drag){const b=selected(),x=Math.round(clamp(drag.x+p.x-drag.point.x,0,M-b.w)),y=Math.round(clamp(drag.y+p.y-drag.point.y,0,M-b.h));if(canPlace({...b,x,y},blocks)){b.x=x;b.y=y;drag.moved=x!==drag.x||y!==drag.y;notice("台座を移動しています。");}else notice("台座どうしは重ねられません。");schedulePreview();return;}
    if(!inside(p)){if(!rolling){cursor=null;schedulePreview();}return;}
    const angle=previous?Math.atan2(p.y-previous.y,p.x-previous.x):0;cursor={...p,angle};schedulePreview();
    if(rolling&&previous){const segment=[previous.x,previous.y,p.x,p.y];previous=p;return engine.call("roller",[[segment]]).then(showPlate);}
  });
  listen(plate,"pointerup",()=>{rolling=false;previous=null;if(drag){const moved=drag.moved;drag=null;if(moved)return action(rebuild);}});
  for(const event of ["pointercancel","lostpointercapture"])listen(plate,event,()=>{rolling=false;previous=null;if(drag){const b=selected();b.x=drag.x;b.y=drag.y;drag=null;schedulePreview();}});
  listen(plate,"pointerleave",()=>{if(!rolling&&!drag){cursor=null;schedulePreview();}});
  listen(plate,"keydown",e=>{
    if(busy||!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"," "].includes(e.key))return;e.preventDefault();
    const step=e.shiftKey?10:2,dx=e.key==="ArrowLeft"?step:e.key==="ArrowRight"?-step:0,dy=e.key==="ArrowUp"?-step:e.key==="ArrowDown"?step:0;
    if($("plateTool").value==="compose"){const b=selected();if(!b)return;const rect={...b,x:b.x+dx,y:b.y+dy};if(canPlace(rect,blocks)){b.x=rect.x;b.y=rect.y;return action(rebuild);}notice("台座どうしは重ねられません。");}
    else if(mode()===2){const p=cursor??{x:256,y:256,angle:0};const end={x:clamp(p.x+(dx||(!dy?12:0)),0,M-1),y:clamp(p.y+dy,0,M-1),angle:Math.atan2(dy,dx||12)};cursor=end;return ensureRoller().then(()=>engine.call("roller",[[[p.x,p.y,end.x,end.y]]])).then(showPlate);}
  });
  function inkModeChanged(){$("gradientControls").hidden=mode()!==1;$("paintControls").hidden=mode()!==2;$("plateTool").value="ink";return toolChanged();}
  listen($("inkMode"),"change",inkModeChanged);
  listen($("clearInk"),"click",()=>action(async()=>{await engine.call("clear");await showPlate();notice("版のインクを拭き取りました。ローラーのインクは残っています。");}));
  for(const id of ["ink","gradientEnd","gradientAngle","color"])listen($(id),"input",showPlate);
  root.querySelectorAll("input[type=range]").forEach(e=>listen(e,"input",outputs));
  async function newPaper(){await engine.call("new");count=0;if(abort.signal.aborted)return;$("empty").hidden=false;$("count").textContent="0回";await render();status("新しい紙をセットしました。");}
  listen($("clear"),"click",()=>action(newPaper));
  listen($("print"),"click",()=>action(async()=>{
    if($("dryBefore").checked)await engine.call("dry");
    await engine.call("materials",[val("elasticity")/100,val("dwell")/100]);
    paper.classList.remove("pressing");void paper.offsetWidth;paper.classList.add("pressing");
    count=await engine.call("print",[val("pressure")/100,val("roughness")/100,val("speed")/100,val("viscosity")/100,val("ink")/100,mode(),val("gradientEnd")/100,val("gradientAngle"),val("direction"),val("offsetX"),val("offsetY"),rgb()],[],percent=>status("刷っています… "+percent+"%"));
    if(abort.signal.aborted)return;$("empty").hidden=true;$("count").textContent=count+"回";await showPlate();await render();status(count+"回目の刷り。新しく刷ったインクは湿っています。");
  }));
  listen($("download"),"click",()=>action(async()=>{
    status("保存する画像を作っています…");const transparent=$("exportBackground").value==="transparent",bytes=await engine.call("export",[transparent]);if(abort.signal.aborted)return;
    const canvas=document.createElement("canvas");canvas.width=canvas.height=engine.sizes.output;canvas.getContext("2d").putImageData(new ImageData(bytes,canvas.width,canvas.height),0,0);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));canvas.width=canvas.height=1;if(!blob)throw new Error("PNGを作成できませんでした");if(abort.signal.aborted)return;
    const url=URL.createObjectURL(blob),a=document.createElement("a");a.download="letterpress-"+count+(transparent?"-ink":"")+"-4096.png";a.href=url;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status("画像を保存しました。");
  }));

let saturation=0.734, brightness=0.737;
function hsv(h,s,v) {
  const f=n=>{const k=(n+h/60)%6;return Math.round((v-v*s*Math.max(0,Math.min(k,4-k,1)))*255);};
  return "#"+[f(5),f(3),f(1)].map(n=>n.toString(16).padStart(2,"0")).join("");
}
function drawPicker() {
  $("colorOut").textContent=$("color").value.toUpperCase();
  const canvas=$("colorPalette"), context=canvas.getContext("2d"), h=val("colorHue");
  context.fillStyle=hsv(h,1,1); context.fillRect(0,0,canvas.width,canvas.height);
  const white=context.createLinearGradient(0,0,canvas.width,0);white.addColorStop(0,"white");white.addColorStop(1,"transparent");
  context.fillStyle=white;context.fillRect(0,0,canvas.width,canvas.height);
  const black=context.createLinearGradient(0,0,0,canvas.height);black.addColorStop(0,"transparent");black.addColorStop(1,"black");
  context.fillStyle=black;context.fillRect(0,0,canvas.width,canvas.height);
  context.beginPath();context.arc(saturation*canvas.width,(1-brightness)*canvas.height,5,0,Math.PI*2);context.strokeStyle="white";context.lineWidth=2;context.stroke();
}
function pickColor() {if(busy)return;rollerDirty=true;$("color").value=hsv(val("colorHue"),saturation,brightness);drawPicker();return showPlate();}
let picking=false;
function paletteEvent(e) {const box=$("colorPalette").getBoundingClientRect();saturation=clamp((e.clientX-box.left)/box.width);brightness=1-clamp((e.clientY-box.top)/box.height);return pickColor();}
listen($("colorPalette"),"pointerdown",e=>{if(busy)return;picking=true;$("colorPalette").setPointerCapture(e.pointerId);return paletteEvent(e);});
listen($("colorPalette"),"pointermove",e=>{if(picking&&!busy)return paletteEvent(e);});
for(const event of ["pointerup","pointercancel","lostpointercapture"])listen($("colorPalette"),event,()=>{picking=false;});
listen($("colorPalette"),"keydown",e=>{if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key))return;e.preventDefault();saturation=clamp(saturation+(e.key==="ArrowRight"?.02:e.key==="ArrowLeft"?-.02:0));brightness=clamp(brightness+(e.key==="ArrowUp"?.02:e.key==="ArrowDown"?-.02:0));return pickColor();});
listen($("colorHue"),"input",pickColor);
listen($("color"),"input",()=>{
  rollerDirty=true;
  const hex=rgb(), r=(hex>>16&255)/255,g=(hex>>8&255)/255,b=(hex&255)/255;
  const max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
  brightness=max;saturation=max===0?0:delta/max;
  if(delta>0)$("colorHue").value=((max===r?(g-b)/delta:max===g?(b-r)/delta+2:(r-g)/delta+4)*60+360)%360;
  drawPicker();
});
drawPicker();

  syncSelection();outputs();drawPlate();
  busy=true;controls();
  (async()=>{try{await engine.call("compose",[[]]);await newPaper();notice("画像を追加するか、サンプルの文字版を選んでください。");}catch(error){if(!abort.signal.aborted)failure(error);}finally{if(!abort.signal.aborted){busy=false;controls();}}})();
  return()=>{abort.abort();if(previewFrame)cancelAnimationFrame(previewFrame);engine.dispose();blocks.length=0;};
}
