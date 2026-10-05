export type PrintEngine = {
  sizes: { simulation: number; source: number; output: number };
  call(method: string, args?: unknown[], transfer?: Transferable[], progress?: (percent: number) => void): Promise<unknown>;
  dispose(): void;
};
export async function loadEngine(): Promise<PrintEngine> {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const worker = new Worker(`${base}/wasm/engine-worker.js`);
  let sequence = 0;
  const pending = new Map<number, {
    resolve(value: unknown): void;
    reject(reason: Error): void;
    progress?: (percent: number) => void;
  }>();
  let disposed = false;
  function fail(error: Error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  worker.onmessage = event => {
    const { id, result, error, progress } = event.data;
    const request = pending.get(id);
    if (!request) return;
    if (progress !== undefined) { request.progress?.(progress); return; }
    pending.delete(id);
    if (error) request.reject(new Error(error)); else request.resolve(result);
  };
  worker.onerror = event => { disposed = true; worker.terminate(); fail(new Error(event.message || "計算処理が停止しました")); };
  function call(method: string, args: unknown[] = [], transfer: Transferable[] = [], progress?: (percent: number) => void): Promise<unknown> {
    if (disposed) return Promise.reject(new Error("計算処理は終了しています"));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject, progress });
      worker.postMessage({ id, method, args }, transfer);
    });
  }
  const dispose = () => { disposed = true; worker.terminate(); fail(new Error("処理を終了しました")); };
  try {
    const sizes = await call("initialize", [`${base}/wasm/letterpress_engine.wasm`]) as PrintEngine["sizes"];
    return { sizes, call, dispose };
  } catch (error) { dispose(); throw error; }
}
