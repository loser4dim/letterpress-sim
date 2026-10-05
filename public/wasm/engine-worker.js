let engine;
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
      engine.engine_init();
      return { simulation: engine.simulation_size(), source: engine.source_size(), output: engine.output_size() };
    }
    case "source":
      new Uint8Array(engine.memory.buffer, engine.source_ptr(), args[0].length).set(args[0]);
      return null;
    case "configure": engine.configure_plate(...args); return null;
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
      engine.render_export();
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
