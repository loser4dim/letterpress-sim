import { snapValue } from "./plate-tools.js";
// Corner names and coordinates refer to the unmirrored printed layout.
export function resizeCorner(original, corner, point, step=0, keepAspect=true) {
  const east=corner.includes("e"), south=corner.includes("s");
  const ax=east?original.x:original.x+original.w, ay=south?original.y:original.y+original.h;
  let w=Math.max(8,east?point.x-ax:ax-point.x),h=Math.max(8,south?point.y-ay:ay-point.y);
  if(keepAspect) {
    const scale=(w*original.w+h*original.h)/(original.w**2+original.h**2);
    w=Math.max(8,snapValue(original.w*scale,step));h=Math.max(8,Math.round(w*original.h/original.w));
  } else {w=Math.max(8,snapValue(w,step));h=Math.max(8,snapValue(h,step));}
  return {...original,x:east?ax:ax-w,y:south?ay:ay-h,w,h};
}
export function smoothRollerAngle(previous, angle, strength=.25) {
  // A roller's axis is unchanged by a 180-degree reversal.
  const delta=Math.atan2(Math.sin(2*(angle-previous)),Math.cos(2*(angle-previous)))/2;
  return previous+delta*strength;
}
export function glyphLayout(lines, size, padding, maximumWidth=512) {
  const cells=[];let x,y=0;
  const w=size+padding.left+padding.right,h=size+padding.top+padding.bottom;
  for(const line of lines) {
    x=0;
    for(const char of line) {
      if(x+w>maximumWidth){x=0;y+=h;}
      cells.push({char,x,y,w,h,type:"glyph"});x+=w;
    }
    y+=h;
  }
  return {cells,w:Math.max(0,...cells.map(c=>c.x+c.w)),h:Math.max(0,...cells.map(c=>c.y+c.h))};
}
