// Scan actual rendered pixels, including accents, dots and disconnected strokes.
export function alphaBounds(rgba,width,height) {
  let left=width,top=height,right=-1,bottom=-1;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){if(rgba[(y*width+x)*4+3]===0)continue;left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
  return right<left?null:{x:left,y:top,w:right-left+1,h:bottom-top+1};
}
export function glyphPixels(char,family,fontSize,padding,weight=400) {
  const source=document.createElement("canvas"),c=source.getContext("2d",{willReadFrequently:true});c.font=weight+" 128px "+family;
  const metrics=c.measureText(char),left=Math.ceil(metrics.actualBoundingBoxLeft),ascent=Math.ceil(metrics.actualBoundingBoxAscent);
  source.width=Math.max(8,Math.ceil(metrics.actualBoundingBoxLeft+metrics.actualBoundingBoxRight)+8);source.height=Math.max(8,Math.ceil(metrics.actualBoundingBoxAscent+metrics.actualBoundingBoxDescent)+8);
  const baseline=4+ascent;c.font=weight+" 128px "+family;c.textBaseline="alphabetic";c.fillStyle="black";c.fillText(char,4+left,baseline);
  const bounds=alphaBounds(c.getImageData(0,0,source.width,source.height).data,source.width,source.height);
  const scale=fontSize/128,inkW=bounds?bounds.w*scale:Math.max(1,metrics.width*scale),inkH=bounds?bounds.h*scale:fontSize;
  const canvas=document.createElement("canvas"),unit=1/scale;
  canvas.width=Math.max(1,(bounds?bounds.w:Math.ceil(inkW*unit))+Math.ceil((padding.left+padding.right)*unit));canvas.height=Math.max(1,(bounds?bounds.h:Math.ceil(inkH*unit))+Math.ceil((padding.top+padding.bottom)*unit));
  const out=canvas.getContext("2d");out.fillStyle="white";out.fillRect(0,0,canvas.width,canvas.height);if(bounds)out.drawImage(source,bounds.x,bounds.y,bounds.w,bounds.h,padding.left*unit,padding.top*unit,bounds.w,bounds.h);
  const result={rgba:out.getImageData(0,0,canvas.width,canvas.height).data,iw:canvas.width,ih:canvas.height,w:Math.max(1,inkW+padding.left+padding.right),h:Math.max(1,inkH+padding.top+padding.bottom),inkW,inkH,ascent:bounds?(baseline-bounds.y)*scale:fontSize*.8};
  source.width=source.height=canvas.width=canvas.height=1;return result;
}
export function tightGlyphLayout(lines,maximumWidth=512,emptyLineHeight=40) {
  const cells=[];let row=[],width=0,y=0;
  function finish() {
    if(!row.length){y+=emptyLineHeight;return;}
    const baseline=Math.max(...row.map(b=>b.ascent+b.padding.top)),depth=Math.max(...row.map(b=>b.h-b.ascent-b.padding.top));let x=0;
    for(const glyph of row){cells.push({...glyph,x,y:y+baseline-glyph.ascent-glyph.padding.top,type:"glyph"});x+=glyph.w;}
    y+=baseline+depth;row=[];width=0;
  }
  for(const line of lines){for(const glyph of line){if(width+glyph.w>maximumWidth&&row.length)finish();row.push(glyph);width+=glyph.w;}finish();}
  return{cells,w:Math.max(0,...cells.map(b=>b.x+b.w)),h:Math.max(0,...cells.map(b=>b.y+b.h))};
}
