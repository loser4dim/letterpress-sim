"use client";
import { useEffect, useRef, useState } from "react";
import { loadEngine } from "../lib/wasm";
import { initLab } from "../lib/init-lab";
function Range({ id, label, value, max = 100, min = 0 }: { id: string; label: string; value: number; max?: number; min?: number }) {
  return <label>{label}<output id={id + "Out"}>{value}</output><input disabled id={id} type="range" min={min} max={max} defaultValue={value} /></label>;
}
export default function LetterpressLab() {
  const root = useRef<HTMLDivElement>(null);
  const [resolution, setResolution] = useState<number | null>(null);
  const [choice, setChoice] = useState(8192);
  useEffect(() => {
    if (resolution === null) return;
    let stopped = false;
    let cleanup: (() => void) | undefined;
    loadEngine(resolution).then(engine => {
      if (!stopped && root.current) cleanup = initLab(root.current, engine);
      else engine.dispose();
    }).catch(error => {
      if (stopped || !root.current) return;
      const status = root.current.querySelector("#status");
      if (status) status.textContent = "読み込みに失敗しました。最初からやり直してください。";
      console.error(error);
    });
    return () => { stopped = true; cleanup?.(); };
  }, [resolution]);
  return <div ref={root}>
    <header><a className="brand" href="#">活版実験室</a></header>
    <main>
      {resolution === null ? <section className="start-panel">
        <h1>計算解像度を選んで始める</h1>
        <label>計算解像度<select id="resolution" value={choice} onChange={e => setChoice(Number(e.target.value))}><option value="8192">8K（細かい計算）</option><option value="4096">4K（軽い計算）</option></select></label>
        <p className="hint">保存する画像はどちらも4Kです。開始後に解像度を変える場合は、版・インク・紙をリセットします。</p>
        <button id="startLab" className="primary" onClick={() => setResolution(choice)}>実験を始める</button>
      </section> : <>
        <div className="session-bar"><span>{resolution === 8192 ? "8K" : "4K"}で実験中</span><button className="quiet" id="restartLab" onClick={() => setResolution(null)}>版・紙をリセットして最初に戻る</button></div>
        <section className="stage" aria-labelledby="plate-title">
          <div className="stage-heading"><h1 id="plate-title">版を組む・インクを載せる</h1><span>01</span></div>
          <div className="stage-content"><aside>
            <h3>画像を選ぶ</h3>
            <label className="upload">版にする画像を追加<input disabled id="upload" type="file" multiple accept="image/png,image/jpeg,image/webp,image/svg+xml" /></label>
            <button disabled id="sample" className="quiet">サンプルの文字版を追加</button>
            <label>選択中の版<select disabled id="blockList" /></label>
            <div className="button-row"><button disabled id="removeBlock" className="quiet">この版を外す</button><button disabled id="clearInk" className="quiet">版のインクを全部拭く</button></div>
            <h3>金型を選ぶ・組む</h3>
            <label>操作<select disabled id="plateTool" defaultValue="compose"><option value="compose">組版（版をドラッグして移動）</option><option value="ink">インクを載せる</option></select></label>
            <label>版の作り方<select disabled id="plateMode" defaultValue="halftone"><option value="halftone">写真：網点（AM）</option><option value="diffusion">写真：細かい点（誤差拡散）</option><option value="binary">文字・線画：二値化</option></select></label>
            <label>カラー画像の変換<select disabled id="separation" defaultValue="luminance"><option value="luminance">明るさ</option><option value="red">赤成分</option><option value="green">緑成分</option><option value="blue">青成分</option></select></label>
            <Range id="threshold" label="二値化のしきい値" value={150} max={255} />
            <Range id="screen" label="網点の細かさ" value={128} min={32} max={192} />
            <Range id="tone" label="写真の明るさ（濃い ← → 薄い）" value={125} min={50} max={220} />
            <Range id="blockSize" label="版の幅" value={320} min={32} max={512} />
            <label className="check"><input disabled id="invert" type="checkbox" /> 白黒を反転</label>
            <p className="hint">台座どうしは重ねられません。選択した版は矢印キーでも移動できます。版の変更後はインクを載せ直してください。</p>
            <h3>塗り方を選ぶ</h3>
            <label>塗り方<select disabled id="inkMode" defaultValue="paint"><option value="paint">手塗り（ローラー）</option><option value="uniform">全面に一定量</option><option value="gradient">量のグラデーション</option></select></label>
            <div id="paintControls"><Range id="brushSize" label="ローラーの幅" value={90} min={16} max={256} /><label className="check"><input disabled id="eraseInk" type="checkbox" /> 布で拭き取る</label><button disabled id="reloadRoller" className="quiet">同じ色のインクをローラーに補充</button><p className="hint">「インクを載せる」に切り替えてドラッグ。ローラーのインクは減り、版からの回収でも混ざります。停止中はインクが増えません。</p></div>
            <div id="gradientControls" hidden><Range id="gradientEnd" label="グラデーションの終点量" value={10} /><label>向き<select disabled id="gradientAngle"><option value="0">左 → 右（刷り上がり）</option><option value="90">上 → 下</option><option value="45">左上 → 右下</option></select></label></div>
            <h3>色を選ぶ</h3>
            <div className="color-picker"><label htmlFor="color">インクの色</label><canvas id="colorPalette" width="280" height="180" tabIndex={0} aria-label="色の明るさと鮮やかさ。矢印キーでも調整できます" /><label className="hue-label">色相<input disabled id="colorHue" type="range" min="0" max="360" defaultValue="5" /></label><input disabled type="color" id="color" defaultValue="#bc3d32" /><output id="colorOut">#BC3D32</output></div>
            <Range id="ink" label="ローラーに補充するインク量" value={35} />
          </aside><div className="canvas-area"><div className="board plate-board"><canvas id="plate" tabIndex={0} aria-label="版を組む・ローラーでインクを載せる" width="640" height="640" /></div><p className="canvas-caption" id="plateCaption">鏡像の版面 · 台座をドラッグして組版</p><p id="plateStatus" className="status" role="status" /></div></div>
        </section>
        <section className="stage" aria-labelledby="print-title">
          <div className="stage-heading"><h2 id="print-title">刷る</h2><span id="count">0回</span></div>
          <div className="stage-content"><aside>
            <Range id="pressure" label="押す圧" value={55} /><Range id="roughness" label="紙の粗さ" value={55} /><Range id="dwell" label="押している時間" value={40} />
            <Range id="speed" label="剥がす速度" value={40} /><Range id="viscosity" label="インクの粘度" value={60} /><Range id="elasticity" label="インクの糸引き" value={55} />
            <label>剥がす方向<select disabled id="direction"><option value="0">左から右</option><option value="90">上から下</option><option value="45">左上から右下</option></select></label>
            <Range id="offsetX" label="横の位置" value={0} min={-100} max={100} /><Range id="offsetY" label="縦の位置" value={0} min={-100} max={100} />
            <label className="check"><input disabled id="dryBefore" type="checkbox" defaultChecked /> 紙のインクを乾かしてから次を刷る</label>
            <p className="hint">乾かすと色が重なり、湿ったまま刷ると前のインクが動きます。</p>
            <button disabled id="print" className="primary">版を押して、刷る</button>
            <p id="status" className="status" role="status">読み込み中…</p>
            <div className="save-controls"><h3>結果を保存する</h3><label>PNGの背景<select disabled id="exportBackground" defaultValue="transparent"><option value="transparent">透過（インクだけ）</option><option value="paper">紙を含める</option></select></label><button disabled id="download" className="primary">4K PNGを保存</button></div>
            <div className="paper-controls"><button disabled id="clear" className="quiet">新しい紙に交換</button></div>
          </aside><div className="canvas-area"><div className="board"><canvas id="paper" width="640" height="640" aria-label="試し刷り結果" /><div id="empty">版にインクを載せ、「刷る」を押してください</div></div><p className="canvas-caption">刷り上がり</p></div></div>
        </section>
      </>}
      <footer>参考文献：<a href="https://www.jstage.jst.go.jp/article/nig1958/24/1/24_1_41/_article/-char/en" target="_blank" rel="noopener">Ink Transfer (1986)</a> · <a href="https://www.jstage.jst.go.jp/article/photogrst1964/68/4/68_4_309/_article" target="_blank" rel="noopener">印刷における階調表現 (2005)</a> · <a href="https://bioresources.cnr.ncsu.edu/wp-content/uploads/2020/02/1989.2.951.pdf" target="_blank" rel="noopener">Paper Compressibility (1989)</a> · <a href="https://arxiv.org/abs/2001.10209" target="_blank" rel="noopener">Liquid Bridge Breakup (2020)</a></footer>
    </main>
  </div>;
}
