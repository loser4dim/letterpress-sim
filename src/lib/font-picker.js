import { FONT_CATALOG, fontInfo } from "./font-catalog.js";
export function initFontPicker(root,{loadFamily,onChoose,isBusy,signal}) {
  const $=id=>root.querySelector("#"+id),dialog=$("fontDialog"),grid=$("fontGrid");let target="textFont",observer,generation=0,timer;
  const on=(el,event,fn)=>el.addEventListener(event,fn,{signal});
  async function preview(id) {
    const output=$(id+"Preview"),choice=$(id).value;output.textContent="読み込み中…";
    try{const family=await loadFamily("Letterpress Aa 0123",choice);if(signal.aborted||$(id).value!==choice)return;output.style.fontFamily=family;output.style.fontWeight=String(fontInfo(choice).weight);output.textContent="Letterpress Aa 0123";}catch{if(!signal.aborted&&$(id).value===choice)output.textContent="書体を読み込めませんでした";}
  }
  function render() {
    const version=++generation;observer?.disconnect();grid.replaceChildren();
    const query=$("fontSearch").value.toLowerCase(),category=$("fontCategory").value,sample=$("fontSample").value||"Letterpress Aa 0123";
    const fonts=FONT_CATALOG.filter(f=>(!category||f.category===category)&&f.label.toLowerCase().includes(query));$("fontCount").textContent=fonts.length+" / "+FONT_CATALOG.length+" 書体";
    let running=0;const queue=[];
    async function next(){if(running>=4||!queue.length||version!==generation)return;running++;const {card,font,example,label}=queue.shift();try{const family=await loadFamily(sample,font.family);if(version===generation&&!signal.aborted){example.style.fontFamily=family;example.style.fontWeight=String(font.weight);example.textContent=sample;label.textContent=font.category;card.dataset.loaded="true";}}catch{if(version===generation){example.textContent="読み込み失敗";label.textContent="通信を確認してください";}}finally{running--;next();}}
    observer=new IntersectionObserver(entries=>{for(const entry of entries){if(!entry.isIntersecting)continue;observer.unobserve(entry.target);queue.push(entry.target._fontPreview);next();}},{root:grid,rootMargin:"100px"});
    for(const font of fonts){const card=document.createElement("button"),name=document.createElement("strong"),example=document.createElement("span"),label=document.createElement("small");card.type="button";card.className="font-card";card.dataset.family=font.family;card.setAttribute("aria-pressed",String($(target).value===font.family));name.textContent=font.label;example.className="font-card-example";example.textContent="読み込み中…";label.textContent=font.category;card.append(name,example,label);card._fontPreview={card,font,example,label};card.addEventListener("click",()=>{if(isBusy())return;dialog.close();onChoose(target,font.family);},{once:true,signal});grid.append(card);observer.observe(card);}
    if(!fonts.length)grid.textContent="該当する書体がありません。";
  }
  for(const id of ["textFont","glyphFont"]){on($(id),"change",()=>preview(id));on($(id+"Browse"),"click",()=>{if(isBusy())return;target=id;dialog.showModal();render();});}
  on($("fontClose"),"click",()=>dialog.close());on($("fontSearch"),"input",render);on($("fontCategory"),"change",render);
  on($("fontSample"),"input",()=>{clearTimeout(timer);timer=setTimeout(render,300);});on(dialog,"close",()=>{generation++;observer?.disconnect();clearTimeout(timer);});
  preview("textFont");preview("glyphFont");
  return{preview,dispose(){generation++;clearTimeout(timer);observer?.disconnect();if(dialog.open)dialog.close();}};
}
