import { rasterizePlate } from "./plate-tools.js";
let engine;
let composition=null,sourceDirty=false;
const coatings=new Map();
let queue = Promise.resolve();
function pixels(pointer, length) {
  return new Uint8ClampedArray(engine.memory.buffer, pointer, length).slice();
}
async function handle(method, args, id) {
  switch (method) {
    case "initialize": {
      const response = await fetch(args[0]);
      if (!response.ok) throw new Error(`WASM: HTTP ${response.status}`);
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      engine = instance.exports;
      coatings.clear();composition=null;sourceDirty=false;
      engine.engine_init_resolution(args[1] === 4096 ? 4096 : 8192);
      return { apiVersion:3, simulation: engine.simulation_size(), source: engine.source_size(), output: engine.output_size() };
    }
    case "source":
      composition=null;sourceDirty=false;
      new Uint8Array(engine.memory.buffer, engine.source_ptr(), args[0].length).set(args[0]);
      return null;
    case "compose": {
      composition=args[0];sourceDirty=true;
      // Only prepare the 512² coating-contact field while editing.
      // The full-resolution binary plate is generated once, immediately before print.
      const coarse=rasterizePlate(composition,2048),surface=new Float32Array(engine.memory.buffer,engine.surface_ptr(),512**2);
      for(let y=0;y<512;y++)for(let x=0;x<512;x++){let covered=0;for(let dy=0;dy<4;dy++)for(let dx=0;dx<4;dx++)covered+=coarse[(y*4+dy)*2048+x*4+dx]===0;surface[y*512+x]=covered/16;}
      engine.configure_plate(1,150,0);
      engine.clear_ink();
      return null;
    }
    case "saveCoating":
      coatings.set(args[0], {coat:new Float32Array(engine.memory.buffer,engine.coating_ptr(),512**2).slice(),pigment:new Float32Array(engine.memory.buffer,engine.pigment_ptr(),512**2*3).slice()}); return null;
    case "restoreCoating": {
      const saved=coatings.get(args[0]); if(saved) {new Float32Array(engine.memory.buffer,engine.coating_ptr(),512**2).set(saved.coat);new Float32Array(engine.memory.buffer,engine.pigment_ptr(),512**2*3).set(saved.pigment);} return null;
    }
    case "forgetCoating": coatings.delete(args[0]); return null;
    case "configure": engine.configure_plate(...args); engine.refresh_plate(); return null;
    case "rollerLoad": engine.roller_load(...args); return null;
    case "roller":
      for (const segment of args[0]) engine.roller_move(...segment);
      return null;
    case "materials": engine.configure_materials(args[0],args[1],args[2] ?? 0.6); return null;
    case "paint":
      for (const [x, y] of args[0]) engine.paint_ink(x, y, ...args.slice(1));
      return null;
    case "clear": engine.clear_ink(); return null;
    case "new": engine.new_paper(); return null;
    case "dry": engine.dry_ink(); return null;
    case "plate":
      engine.update_plate(...args);
      return pixels(engine.plate_ptr(), 512 * 512 * 4);
    case "preview":
      engine.render_preview();
      return pixels(engine.image_ptr(), 640 * 640 * 4);
    case "print": {
      if(sourceDirty){
        self.postMessage({id,progress:0});
        const mask=rasterizePlate(composition,engine.source_size());new Uint8Array(engine.memory.buffer,engine.source_ptr(),mask.length).set(mask);sourceDirty=false;
      }
      engine.print_begin(...args);
      const rows = engine.source_size();
      for (let y = 0; y < rows; y += 64) {
        engine.print_rows(y, 64);
        self.postMessage({ id, progress: Math.round(Math.min(y + 64, rows) / rows * 100) });
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      engine.print_finish();
      return engine.impression_count();
    }
    case "export":
      if (args[0]) engine.render_export_transparent(); else engine.render_export();
      return pixels(engine.export_ptr(), engine.output_size() ** 2 * 4);
    default: throw new Error(`Unknown command: ${method}`);
  }
}
self.onmessage = event => {
  const { id, method, args } = event.data;
  queue = queue.then(async () => {
    try {
      const result = await handle(method, args, id);
      self.postMessage({ id, result }, ArrayBuffer.isView(result) ? [result.buffer] : []);
    } catch (error) {
      self.postMessage({ id, error: String(error.message ?? error) });
    }
  });
};
