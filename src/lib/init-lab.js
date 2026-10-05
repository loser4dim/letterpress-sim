import { canPlace, findSpace, rasterizePlate, snapValue } from "../../public/wasm/plate-tools.js";
import { resizeCorner, smoothRollerAngle } from "../../public/wasm/composition-tools.js";
import { glyphPixels, tightGlyphLayout } from "./glyph-tools.js";
import { fontInfo } from "./font-catalog.js";
import { initFontPicker } from "./font-picker.js";
export function initLab(root, engine) {
  const abort=new AbortController(),$=id=>root.querySelector("#"+id);
  const N=640,M=512,plate=$("plate"),inkPlate=$("inkPlate"),paper=$("paper"),ctx=paper.getContext("2d");
  const assemblies=[{id:1,name:"版1",blocks:[],selectedId:null,mask:null}],references=new Set();
  let active=assemblies[0],blocks=active.blocks,nextAssembly=2,selectedId=null,nextId=1,count=0,busy=false,plateImage=null,rollerDirty=true;
  const clamp=(v,lo=0,hi=1)=>Math.max(lo,Math.min(hi,v)),val=id=>Number($(id).value),rgb=()=>parseInt($("color").value.slice(1),16);
  const mode=()=>2,selected=()=>blocks.find(b=>b.id===selectedId),imageBlock=()=>blocks.find(b=>b.type==="image");
  const status=text=>{if(!abort.signal.aborted)$("status").textContent=text;};
  const notice=text=>{if(!abort.signal.aborted){$("plateStatus").textContent=text;status(text);}};
  const failure=error=>notice("処理に失敗しました。"+(error.message??error));
  const listen=(element,event,callback)=>element.addEventListener(event,e=>{if(abort.signal.aborted)return;try{Promise.resolve(callback(e)).catch(error=>{if(!abort.signal.aborted)failure(error);});}catch(error){failure(error);}},{signal:abort.signal});
  let previewFrame=0,cursor=null,rolling=false,drag=null,compositionDirty=true,previous=null,paintFrame=0,paintFlush=null;
  const paintSegments=[];
  function controls() {
    root.querySelectorAll("input,select,textarea,button").forEach(e=>{e.disabled=busy;});
    for(const id of ["blockSize","blockLocked","removeBlock"])$(id).disabled=busy||!selected();
    $("blockSize").disabled=busy||!selected()||selected().locked;
    for(const id of ["glyphFont","glyphFontBrowse","glyphLeft","glyphRight","glyphTop","glyphBottom"])$(id).disabled=busy||selected()?.type!=="glyph"||selected()?.locked;
    $("print").disabled=busy||!blocks.length;
    $("removeAssembly").disabled=busy||assemblies.length===1;
    $("newAssembly").disabled=busy||assemblies.length>=8;
  }
  async function action(callback) {
    if(busy)return;busy=true;controls();
    try{await flushPaint();await callback();}finally{if(!abort.signal.aborted){busy=false;controls();}}
  }
  function outputs(){root.querySelectorAll("input[type=range]").forEach(e=>{const out=$(e.id+"Out");if(out)out.textContent=e.value;});}
  function fillSelect(list,items,value) {
    list.replaceChildren();for(const item of items){const option=document.createElement("option");option.value=String(item.id);option.textContent=item.name;list.append(option);}if(value!==null)list.value=String(value);
  }
  function syncAssemblies() {
    fillSelect($("assemblyList"),assemblies,active.id);$("assemblyName").value=active.name;
    const list=$("referenceList");list.replaceChildren();
    for(const item of assemblies.filter(a=>a!==active)){
      const label=document.createElement("label"),check=document.createElement("input");label.className="check";check.type="checkbox";check.checked=references.has(item.id);check.dataset.assembly=String(item.id);label.append(check,document.createTextNode(item.name));list.append(label);
    }
    if(assemblies.length===1)list.textContent="別の版を作ると選べます。";
    const b=imageBlock();if(b){$("plateMode").value=b.kind;$("separation").value=b.separation;$("threshold").value=b.threshold;$("screen").value=b.screen;$("tone").value=b.tone;$("invert").checked=b.invert;}
    syncSelection();
  }
  function syncSelection() {
    fillSelect($("blockList"),blocks,selectedId);const b=selected();
    $("glyphControls").hidden=b?.type!=="glyph";
    if(b){$("blockSize").min=b.type==="glyph"?1:8;$("blockSize").value=Math.round(b.w);$("blockLocked").checked=!!b.locked;if(b.type==="glyph"){$("glyphFont").value=b.fontChoice;for(const side of ["Left","Right","Top","Bottom"]){const field=$("glyph"+side),value=Math.round(b.padding[side.toLowerCase()]);field.max=Math.max(32,value);field.value=value;}}}
    active.selectedId=selectedId;outputs();controls();if(b?.type==="glyph")fontPicker?.preview("glyphFont");
  }
  function imageSettings(){return{kind:$("plateMode").value,separation:$("separation").value,threshold:val("threshold"),screen:val("screen"),tone:val("tone"),invert:$("invert").checked};}
  function grayBlock(b,copy=false) {
    if(!b.grayCache||b.grayChannel!==b.separation){const gray=new Uint8Array(b.iw*b.ih),channel=({red:0,green:1,blue:2})[b.separation];for(let i=0;i<gray.length;i++){const k=i*4;gray[i]=channel===undefined?Math.round(.2126*b.rgba[k]+.7152*b.rgba[k+1]+.0722*b.rgba[k+2]):b.rgba[k+channel];}b.grayCache=gray;b.grayChannel=b.separation;}
    return{id:b.id,x:b.x,y:b.y,w:b.w,h:b.h,iw:b.iw,ih:b.ih,kind:b.kind,threshold:b.threshold,screen:b.screen,tone:b.tone,invert:b.invert,gray:copy?b.grayCache.slice():b.grayCache};
  }
  function dirtyComposition(){compositionDirty=true;active.mask=null;}
  function maskOf(assembly){return assembly.mask??=rasterizePlate(assembly.blocks.map(b=>grayBlock(b)),M);}
  function corners(b){return[{corner:"nw",x:b.x,y:b.y},{corner:"ne",x:b.x+b.w,y:b.y},{corner:"sw",x:b.x,y:b.y+b.h},{corner:"se",x:b.x+b.w,y:b.y+b.h}];}
  function drawPlate() {
    if(abort.signal.aborted||!compositionDirty)return;
    const context=plate.getContext("2d");context.fillStyle="#ada79a";context.fillRect(0,0,N,N);context.fillStyle="#bcb9b4";context.fillRect(64,64,M,M);
    const layer=document.createElement("canvas");layer.width=layer.height=M;const lc=layer.getContext("2d");
    for(const a of assemblies.filter(a=>a!==active&&references.has(a.id))){const mask=maskOf(a),bytes=new Uint8ClampedArray(M*M*4);for(let i=0;i<mask.length;i++){if(mask[i]!==0)continue;const k=(Math.floor(i/M)*M+M-1-i%M)*4;bytes[k]=45;bytes[k+1]=105;bytes[k+2]=158;bytes[k+3]=Math.round(val("referenceOpacity")/100*255);}lc.putImageData(new ImageData(bytes,M,M),0,0);context.drawImage(layer,64,64);}
    const mask=maskOf(active),bytes=new Uint8ClampedArray(M*M*4);
    for(let i=0;i<mask.length;i++){if(mask[i]!==0)continue;const k=(Math.floor(i/M)*M+M-1-i%M)*4;bytes[k]=98;bytes[k+1]=95;bytes[k+2]=90;bytes[k+3]=255;}
    lc.putImageData(new ImageData(bytes,M,M),0,0);context.drawImage(layer,64,64);
    for(const b of blocks){const x=64+M-b.x-b.w,y=64+b.y;context.strokeStyle=b.id===selectedId?"#ad3e30":"#766e6155";context.lineWidth=b.id===selectedId?2:1;context.strokeRect(x,y,b.w,b.h);}
    const b=selected();
    if(b){if(b.type==="glyph"){context.save();context.strokeStyle="#ad3e3090";context.setLineDash([3,3]);context.strokeRect(64+M-b.x-b.padding.left-b.inkW,64+b.y+b.padding.top,b.inkW,b.inkH);context.restore();}
      if(!b.locked)for(const h of corners(b)){const x=64+M-h.x,y=64+h.y;context.fillStyle="#fffaf0";context.fillRect(x-5,y-5,10,10);context.strokeStyle="#ad3e30";context.strokeRect(x-5,y-5,10,10);}}
    compositionDirty=false;
  }
  function drawInk(){if(abort.signal.aborted)return;const c=inkPlate.getContext("2d");c.fillStyle="#ada79a";c.fillRect(0,0,N,N);if(plateImage)c.putImageData(plateImage,64,64);}
  function drawCursor(){const el=$("inkCursor");el.hidden=!cursor||busy;if(!cursor)return;el.style.left=(64+M-cursor.x)/N*100+"%";el.style.top=(64+cursor.y)/N*100+"%";el.style.width=8/N*100+"%";el.style.height=val("brushSize")/N*100+"%";el.style.transform="translate(-50%, -50%) rotate("+(-cursor.angle)+"rad)";el.classList.toggle("wiping",$("eraseInk").checked);}
  function schedulePreview(){if(previewFrame)return;previewFrame=requestAnimationFrame(()=>{previewFrame=0;drawPlate();drawCursor();});}
  let plateDirty=false,plateUpdating=false;
  async function showPlate(){plateDirty=true;if(plateUpdating)return;plateUpdating=true;try{while(plateDirty&&!abort.signal.aborted){plateDirty=false;const bytes=await engine.call("plate",[2,val("ink")/100,0,0,rgb()]);if(!abort.signal.aborted){plateImage=new ImageData(bytes,M,M);drawInk();schedulePreview();}}}finally{plateUpdating=false;}}
  async function rebuild(restore=false) {
    dirtyComposition();notice("版を組んでいます…");const data=blocks.map(b=>grayBlock(b,true));await engine.call("compose",[data],data.map(b=>b.gray.buffer));
    if(restore)await engine.call("restoreCoating",[active.id]);else await engine.call("forgetCoating",[active.id]);
    if(abort.signal.aborted)return;plateImage=null;await showPlate();notice(restore?active.name+"に切り替えました。紙と塗布インクはそのままです。":"版を更新しました。インクを載せ直してください。");schedulePreview();
  }
  async function switchAssembly(next) {
    if(next===active)return;await engine.call("saveCoating",[active.id]);active.selectedId=selectedId;active=next;blocks=active.blocks;selectedId=active.selectedId;cursor=null;previous=null;rolling=false;syncAssemblies();await rebuild(true);
  }
  listen($("assemblyList"),"change",()=>action(()=>switchAssembly(assemblies.find(a=>a.id===val("assemblyList")))));
  listen($("newAssembly"),"click",()=>action(async()=>{if(assemblies.length>=8)return;const a={id:nextAssembly++,name:"版"+(nextAssembly-1),blocks:[],selectedId:null,mask:null};assemblies.push(a);await switchAssembly(a);}));
  listen($("removeAssembly"),"click",()=>action(async()=>{if(assemblies.length<=1)return;const old=active;await switchAssembly(assemblies.find(a=>a!==old));assemblies.splice(assemblies.indexOf(old),1);references.delete(old.id);await engine.call("forgetCoating",[old.id]);syncAssemblies();compositionDirty=true;schedulePreview();}));
  listen($("assemblyName"),"change",()=>{active.name=$("assemblyName").value.trim()||"版"+active.id;syncAssemblies();});
  listen($("referenceList"),"change",e=>{const id=Number(e.target.dataset.assembly);if(!id)return;if(e.target.checked)references.add(id);else references.delete(id);compositionDirty=true;schedulePreview();});
  listen($("referenceOpacity"),"input",()=>{compositionDirty=true;schedulePreview();});
  async function render(){const bytes=await engine.call("preview");if(!abort.signal.aborted)ctx.putImageData(new ImageData(bytes,N,N),0,0);}
  function fitImage(rgba,iw,ih,name,settings=imageSettings()) {
    const old=imageBlock(),others=blocks.filter(b=>b!==old);let rect=null;
    if(old){const candidate={...old,h:Math.max(8,Math.round(old.w*ih/iw))};if(canPlace(candidate,others))rect=candidate;}
    let longest=others.length===0?320:192;
    while(!rect&&longest>=32){const w=Math.max(8,Math.round(longest*Math.min(1,iw/ih))),h=Math.max(8,Math.round(longest*Math.min(1,ih/iw)));rect=findSpace(w,h,others);longest*=.88;}
    if(!rect){notice("画像を置く空きがありません。台座を小さくするか、外してください。");return false;}
    const b={...rect,...settings,id:old?.id??nextId++,name,rgba,iw,ih,type:"image",locked:old?.locked??false};if(old)blocks.splice(blocks.indexOf(old),1,b);else blocks.push(b);selectedId=b.id;return true;
  }
  listen($("upload"),"change",event=>action(async()=>{const file=event.target.files[0];if(!file)return;if(file.size>20*1024*1024)throw new Error("画像は20MB以下で選んでください。");const url=URL.createObjectURL(file),image=new Image();try{image.src=url;await image.decode();if(abort.signal.aborted)return;const scale=Math.min(1,2048/Math.max(image.width,image.height)),canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));const c=canvas.getContext("2d",{willReadFrequently:true});c.fillStyle="white";c.fillRect(0,0,canvas.width,canvas.height);c.drawImage(image,0,0,canvas.width,canvas.height);const added=fitImage(c.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height,file.name);canvas.width=canvas.height=1;syncAssemblies();if(added)await rebuild();}finally{URL.revokeObjectURL(url);$("upload").value="";}}));
  listen($("sample"),"click",()=>action(async()=>{const canvas=document.createElement("canvas");canvas.width=1024;canvas.height=640;const c=canvas.getContext("2d");c.fillStyle="white";c.fillRect(0,0,1024,640);c.fillStyle="black";c.strokeStyle="black";c.lineWidth=6;c.strokeRect(25,25,974,590);c.font="bold 190px serif";c.textAlign="center";c.fillText("活版",512,280);c.font="bold 98px serif";c.fillText("実験室",512,425);c.font="32px serif";c.fillText("INK · PAPER · PRESS",512,530);if(fitImage(c.getImageData(0,0,1024,640).data,1024,640,"サンプル画像",{...imageSettings(),kind:"binary"})){syncAssemblies();await rebuild();}}));
  const fontStyles=[],fontLoads=new Map();let fontNumber=0;
  async function textFamily(text,choice) {
    const info=fontInfo(choice);if(info.css)return info.css;
    const glyphs=[...new Set(text)].sort().join(""),key=choice+"|"+glyphs;
    if(fontLoads.has(key))return fontLoads.get(key);
    const loading=(async()=>{
      const url="https://fonts.googleapis.com/css2?family="+encodeURIComponent(info.family).replace(/%20/g,"+")+":wght@"+info.weight+"&display=block&text="+encodeURIComponent(glyphs);
      const response=await fetch(url,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(15000)])});if(!response.ok)throw new Error("Google Fontsの読み込みに失敗しました。");
      const css=await response.text();if(abort.signal.aborted)throw new Error("読み込みを中断しました。");
      const alias="LetterpressFont"+(++fontNumber),style=document.createElement("style");style.textContent=css.replace(/font-family\s*:[^;]+;/g,"font-family: '"+alias+"';");document.head.append(style);fontStyles.push(style);
      const family='"'+alias+'"';
      const loaded=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("書体の読み込みがタイムアウトしました。")),15000);document.fonts.load(info.weight+' 128px '+family,text).then(result=>{clearTimeout(timer);resolve(result);},error=>{clearTimeout(timer);reject(error);});});
      if(!loaded.length)throw new Error("選んだ書体を読み込めませんでした。");return family;
    })();fontLoads.set(key,loading);try{return await loading;}catch(error){fontLoads.delete(key);throw error;}
  }
  const fontPicker=initFontPicker(root,{loadFamily:textFamily,isBusy:()=>busy,signal:abort.signal,onChoose:(target,choice)=>{$(target).value=choice;$(target).dispatchEvent(new Event("change",{bubbles:true}));}});
  listen($("addText"),"click",()=>action(async()=>{
    const text=$("textInput").value;if(!text.trim()){notice("文字を入力してください。");return;}
    const segmenter=new Intl.Segmenter("ja",{granularity:"grapheme"}),lines=text.replace(/\r/g,"").split("\n").map(line=>[...segmenter.segment(line)].map(s=>s.segment)),total=lines.reduce((n,l)=>n+l.length,0);
    if(total>128||blocks.filter(b=>b.type==="glyph").length+total>256){notice("追加は128文字まで、1つの版には256文字までです。");return;}
    notice("文字の書体を読み込んでいます…");const choice=$("textFont").value,family=await textFamily(text,choice);if(abort.signal.aborted)return;
    const size=val("textSize"),pad=val("textPadding"),padding={left:pad,right:pad,top:pad,bottom:pad},weight=fontInfo(choice).weight,rendered=lines.map(line=>line.map(char=>({char,...glyphPixels(char,family,size,padding,weight),padding:{...padding}}))),layout=tightGlyphLayout(rendered,M,size);
    const spot=findSpace(Math.max(8,layout.w),Math.max(8,layout.h),blocks);if(!spot){notice("文字列を置く空きがありません。文字を小さくするか、短く分けて追加してください。");return;}
    for(const cell of layout.cells){const b={...cell,x:spot.x+cell.x,y:spot.y+cell.y,id:nextId++,name:(cell.char===" "?"空白":cell.char)+" · "+fontInfo(choice).label,fontChoice:choice,family,fontSize:size,padding:{...padding},kind:"binary",separation:"luminance",threshold:150,screen:128,tone:100,invert:false,locked:false};blocks.push(b);selectedId=b.id;}
    syncSelection();await rebuild();
  }));
  listen($("blockList"),"change",()=>{selectedId=val("blockList");syncSelection();compositionDirty=true;schedulePreview();});
  listen($("removeBlock"),"click",()=>action(async()=>{const i=blocks.findIndex(b=>b.id===selectedId);if(i>=0)blocks.splice(i,1);selectedId=blocks.at(-1)?.id??null;syncSelection();await rebuild();}));
  for(const id of ["plateMode","separation","threshold","screen","tone","invert"])listen($(id),"change",()=>action(async()=>{const b=imageBlock();if(!b)return;Object.assign(b,imageSettings());await rebuild();}));
  async function editGlyph(){const b=selected();if(b?.type!=="glyph"||b.locked)return;
    const padding={left:val("glyphLeft"),right:val("glyphRight"),top:val("glyphTop"),bottom:val("glyphBottom")},choice=$("glyphFont").value,family=choice===b.fontChoice?b.family:await textFamily(b.char,choice);if(abort.signal.aborted)return;
    const pixels=glyphPixels(b.char,family,b.fontSize,padding,fontInfo(choice).weight);
    const x=b.x+b.padding.left-padding.left,y=b.y+b.padding.top+b.ascent-pixels.ascent-padding.top,rect={...b,...pixels,x,y};
    if(!canPlace(rect,blocks)){notice("この書体や余白では台座が重なるか、版面からはみ出します。先に台座を移動してください。");syncSelection();return;}
    Object.assign(b,pixels,{x,y,padding,fontChoice:choice,family,name:(b.char===" "?"空白":b.char)+" · "+fontInfo(choice).label,grayCache:null});syncSelection();await rebuild();
  }
  for(const id of ["glyphFont","glyphLeft","glyphRight","glyphTop","glyphBottom"])listen($(id),"change",()=>action(editGlyph));
  function scaleGlyph(b,oldWidth){if(b.type!=="glyph")return;const factor=b.w/oldWidth;b.fontSize*=factor;b.inkW*=factor;b.inkH*=factor;b.ascent*=factor;for(const side of ["left","right","top","bottom"])b.padding[side]*=factor;}
  listen($("blockSize"),"change",()=>action(async()=>{const b=selected();if(!b||b.locked){syncSelection();return;}const oldWidth=b.w,minimum=b.type==="glyph"?1:8,w=Math.max(minimum,snapValue(val("blockSize"),val("snap"))),h=Math.max(minimum,Math.round(w*b.h/b.w)),rect={...b,w,h};if(canPlace(rect,blocks)){Object.assign(b,{w,h});scaleGlyph(b,oldWidth);await rebuild();}else notice("その大きさでは台座が重なるか、版面からはみ出します。");syncSelection();schedulePreview();}));
  listen($("blockLocked"),"change",()=>{const b=selected();if(!b)return;b.locked=$("blockLocked").checked;controls();compositionDirty=true;schedulePreview();});
  plate.style.cursor="grab";inkPlate.style.cursor="crosshair";
  async function ensureRoller(){if(!rollerDirty)return;rollerDirty=false;await engine.call("rollerLoad",[val("brushSize"),val("ink")/100,$("eraseInk").checked?1:0,rgb()]);}
  listen($("reloadRoller"),"click",()=>action(async()=>{rollerDirty=true;await ensureRoller();notice("選んだ色のインクをローラーに補充しました。");}));
  for(const id of ["brushSize","ink","eraseInk","color"])listen($(id),"input",()=>{rollerDirty=true;schedulePreview();});
  function point(event){const box=event.currentTarget.getBoundingClientRect();return{x:M-((event.clientX-box.left)/box.width*N-64),y:(event.clientY-box.top)/box.height*N-64};}
  function inside(p){return p.x>=0&&p.y>=0&&p.x<M&&p.y<M;}
  listen(plate,"pointerdown",e=>{if(busy)return;const p=point(e),current=selected();let handle=current&&!current.locked?corners(current).find(h=>Math.hypot(h.x-p.x,h.y-p.y)<11):null;
    const b=handle?current:blocks.find(b=>p.x>=b.x&&p.x<b.x+b.w&&p.y>=b.y&&p.y<b.y+b.h);if(!b)return;selectedId=b.id;syncSelection();compositionDirty=true;schedulePreview();if(b.locked){notice("この台座は固定されています。");return;}plate.setPointerCapture(e.pointerId);drag={point:p,original:{x:b.x,y:b.y,w:b.w,h:b.h},corner:handle?.corner,moved:false};
  });
  listen(plate,"pointermove",e=>{if(busy||!drag)return;const p=point(e),b=selected(),o=drag.original;
    const rect=drag.corner?{...b,...resizeCorner(o,drag.corner,p,val("snap"),b.type==="glyph"||$("keepAspect").checked,b.type==="glyph"?1:8)}:{...b,x:clamp(snapValue(o.x+p.x-drag.point.x,val("snap")),0,M-b.w),y:clamp(snapValue(o.y+p.y-drag.point.y,val("snap")),0,M-b.h)};
    if(canPlace(rect,blocks)){Object.assign(b,{x:rect.x,y:rect.y,w:rect.w,h:rect.h});drag.moved=b.x!==o.x||b.y!==o.y||b.w!==o.w||b.h!==o.h;dirtyComposition();}else notice("台座どうしは重ねられず、版面の外には置けません。");schedulePreview();
  });
  listen(plate,"pointerup",()=>{if(!drag)return;const d=drag;drag=null;if(d.moved){scaleGlyph(selected(),d.original.w);syncSelection();return action(rebuild);}});
  for(const event of ["pointercancel","lostpointercapture"])listen(plate,event,()=>{if(drag){Object.assign(selected(),drag.original);drag=null;dirtyComposition();syncSelection();schedulePreview();}});
  listen(plate,"keydown",e=>{if(busy||!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key))return;e.preventDefault();const b=selected();if(!b||b.locked)return;const step=(val("snap")||2)*(e.shiftKey?4:1),dx=e.key==="ArrowLeft"?step:e.key==="ArrowRight"?-step:0,dy=e.key==="ArrowUp"?-step:e.key==="ArrowDown"?step:0,rect={...b,x:snapValue(b.x+dx,val("snap")),y:snapValue(b.y+dy,val("snap"))};if(canPlace(rect,blocks)){b.x=rect.x;b.y=rect.y;return action(rebuild);}notice("台座どうしは重ねられません。");});
  async function flushPaint(){if(paintFrame){cancelAnimationFrame(paintFrame);paintFrame=0;}if(paintFlush)return paintFlush;if(!paintSegments.length)return;
    paintFlush=(async()=>{try{while(paintSegments.length&&!abort.signal.aborted){const segments=paintSegments.splice(0);await ensureRoller();await engine.call("roller",[segments]);await showPlate();}}finally{paintFlush=null;}})();return paintFlush;
  }
  function schedulePaint(){if(!paintFrame)paintFrame=requestAnimationFrame(()=>{paintFrame=0;flushPaint().catch(failure);});}
  listen(inkPlate,"pointerdown",e=>{if(busy)return;const p=point(e);if(!inside(p))return;inkPlate.setPointerCapture(e.pointerId);rolling=true;previous=p;cursor={...p,angle:cursor?.angle??0};schedulePreview();});
  listen(inkPlate,"pointermove",e=>{if(busy)return;const p=point(e);if(!inside(p)){previous=null;cursor=null;schedulePreview();return;}const angle=cursor?.angle??0;cursor={...p,angle};if(rolling&&previous){const distance=Math.hypot(p.x-previous.x,p.y-previous.y);if(distance>=2){cursor.angle=smoothRollerAngle(angle,Math.atan2(p.y-previous.y,p.x-previous.x));paintSegments.push([previous.x,previous.y,p.x,p.y]);previous=p;schedulePaint();}}else if(rolling)previous=p;schedulePreview();});
  for(const event of ["pointerup","pointercancel","lostpointercapture"])listen(inkPlate,event,()=>{rolling=false;previous=null;return flushPaint();});
  listen(inkPlate,"pointerleave",()=>{if(!rolling){cursor=null;schedulePreview();}});
  listen(inkPlate,"keydown",e=>{if(busy||!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"," "].includes(e.key))return;e.preventDefault();const step=e.shiftKey?10:2,dx=e.key==="ArrowLeft"?step:e.key==="ArrowRight"?-step:0,dy=e.key==="ArrowUp"?-step:e.key==="ArrowDown"?step:0,p=cursor??{x:256,y:256,angle:0},end={x:clamp(p.x+(dx||(!dy?12:0)),0,M-1),y:clamp(p.y+dy,0,M-1),angle:smoothRollerAngle(p.angle,Math.atan2(dy,dx||12))};cursor=end;paintSegments.push([p.x,p.y,end.x,end.y]);schedulePreview();return flushPaint();});
  listen($("clearInk"),"click",()=>action(async()=>{await engine.call("clear");await showPlate();notice("現在の版のインクを拭き取りました。ローラーのインクは残っています。");}));
  for(const id of ["ink","color"])listen($(id),"input",showPlate);
  root.querySelectorAll("input[type=range]").forEach(e=>listen(e,"input",outputs));
  async function newPaper(){await engine.call("new");count=0;if(abort.signal.aborted)return;$("empty").hidden=false;$("count").textContent="0回";await render();status("新しい紙をセットしました。");}
  listen($("clear"),"click",()=>action(newPaper));
  listen($("print"),"click",()=>action(async()=>{
    if($("dryBefore").checked)await engine.call("dry");
    await engine.call("materials",[val("elasticity")/100,val("dwell")/100,val("heightStrength")/100]);
    paper.classList.remove("pressing");void paper.offsetWidth;paper.classList.add("pressing");
    count=await engine.call("print",[val("pressure")/100,val("roughness")/100,val("speed")/100,val("viscosity")/100,val("ink")/100,mode(),0,0,val("direction"),val("offsetX"),val("offsetY"),rgb()],[],percent=>status("刷っています… "+percent+"%"));
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

  syncAssemblies();outputs();drawPlate();drawInk();
  busy=true;controls();
  (async()=>{try{await engine.call("compose",[[]]);await newPaper();await showPlate();notice("文字や画像を入れて、版を組んでください。");}catch(error){if(!abort.signal.aborted)failure(error);}finally{if(!abort.signal.aborted){busy=false;controls();}}})();
  return()=>{abort.abort();fontPicker.dispose();fontStyles.forEach(style=>style.remove());fontLoads.clear();if(previewFrame)cancelAnimationFrame(previewFrame);if(paintFrame)cancelAnimationFrame(paintFrame);engine.dispose();assemblies.length=0;paintSegments.length=0;};
}
