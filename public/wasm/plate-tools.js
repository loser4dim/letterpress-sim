// Shared pure geometry and plate rasterization used by UI, worker, and tests.
export const PLATE_SIZE = 512;
export function overlaps(a, b, gap = 2) {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}
export function canPlace(rect, blocks, exceptId = rect.id) {
  return rect.w >= 8 && rect.h >= 8 && rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= PLATE_SIZE && rect.y + rect.h <= PLATE_SIZE && blocks.every(b => b.id === exceptId || !overlaps(rect, b, rect.type === "glyph" && b.type === "glyph" ? 0 : 2));
}
export function findSpace(w, h, blocks) {
  for (let y = 0; y + h <= PLATE_SIZE; y += 4) for (let x = 0; x + w <= PLATE_SIZE; x += 4) {
    const rect = { x, y, w, h };
    if (canPlace(rect, blocks, null)) return rect;
  }
  return null;
}
function grayAt(block, x, y) {
  x = Math.max(0, Math.min(block.iw - 1, x)); y = Math.max(0, Math.min(block.ih - 1, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, block.iw - 1), y1 = Math.min(y0 + 1, block.ih - 1);
  const fx = x - x0, fy = y - y0, p = block.gray;
  return (p[y0*block.iw+x0]*(1-fx)+p[y0*block.iw+x1]*fx)*(1-fy)+(p[y1*block.iw+x0]*(1-fx)+p[y1*block.iw+x1]*fx)*fy;
}
const ranks = new Float32Array(2049);
for (let i=0;i<ranks.length;i++) {
  const r2=i/4096, r=Math.sqrt(r2);
  ranks[i]=r <= .5 ? Math.PI*r2 : Math.PI*r2-4*(r2*Math.acos(.5/r)-.5*Math.sqrt(r2-.25));
}
function diffusion(block, tones) {
  const w=Math.max(8,Math.round(block.w*2)),h=Math.max(8,Math.round(block.h*2));
  const result=new Uint8Array(w*h), current=new Float32Array(w+2), next=new Float32Array(w+2);
  for(let y=0;y<h;y++) {
    const dir=y%2===0?1:-1;
    for(let j=0;j<w;j++) {
      const x=dir===1?j:w-1-j;
      const g=Math.round(grayAt(block,(x+.5)/w*(block.iw-1),(y+.5)/h*(block.ih-1)));
      const v=tones[g]+current[x+1], ink=v>=.5?1:0, error=v-ink;
      result[y*w+x]=ink?0:255;
      current[x+1+dir]+=error*7/16;next[x+1-dir]+=error*3/16;next[x+1]+=error*5/16;next[x+1+dir]+=error/16;
    }
    current.set(next);next.fill(0);
  }
  return { pixels:result,w,h };
}
export function rasterizePlate(blocks, size) {
  const result=new Uint8Array(size*size).fill(255), scale=size/PLATE_SIZE;
  for(const block of blocks) {
    const bx=Math.round(block.x*scale),by=Math.round(block.y*scale),bw=Math.round((block.x+block.w)*scale)-bx,bh=Math.round((block.y+block.h)*scale)-by;
    const tones=new Float32Array(256);
    for(let g=0;g<256;g++) tones[g]=Math.pow(block.invert?g/255:1-g/255,block.tone/100)*.96;
    const fm=block.kind==='diffusion'?diffusion(block,tones):null;
    const cell=PLATE_SIZE/block.screen; const c=Math.SQRT1_2;
    for(let y=0;y<bh;y++) for(let x=0;x<bw;x++) {
      let ink;
      if(fm) ink=fm.pixels[Math.min(fm.h-1,Math.floor(y/bh*fm.h))*fm.w+Math.min(fm.w-1,Math.floor(x/bw*fm.w))]===0;
      else {
        const gray=Math.round(grayAt(block,(x+.5)/bw*(block.iw-1),(y+.5)/bh*(block.ih-1)));
        if(block.kind==='binary') ink=(gray<block.threshold)!==Boolean(block.invert);
        else {
          const lx=(x+.5)/scale,ly=(y+.5)/scale;
          const u=(lx*c+ly*c)/cell,v=(-lx*c+ly*c)/cell;
          const dx=u-Math.floor(u)-.5,dy=v-Math.floor(v)-.5;
          ink=ranks[Math.min(2048,Math.round((dx*dx+dy*dy)*4096))]<tones[gray];
        }
      }
      if(bx+x>=0 && bx+x<size && by+y>=0 && by+y<size) result[(by+y)*size+bx+x]=ink?0:255;
    }
  }
  return result;
}

export function snapValue(value, step=0) { return step>0 ? Math.round(value/step)*step : Math.round(value); }
