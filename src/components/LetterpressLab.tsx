"use client";
import { useEffect, useRef } from "react";
import { loadEngine } from "../lib/wasm";
import { initLab } from "../lib/init-lab";

function Range({ id, label, value, max = 100, min = 0 }: { id: string; label: string; value: number; max?: number; min?: number }) {
  return <label>{label}<output id={id + "Out"}>{value}</output><input id={id} type="range" min={min} max={max} defaultValue={value} /></label>;
}
export default function LetterpressLab() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let stopped = false;
    let cleanup: (() => void) | undefined;
    loadEngine().then(engine => {
      if (!stopped && root.current) cleanup = initLab(root.current, engine);
      else engine.dispose();
    }).catch(error => {
      if (stopped || !root.current) return;
      const status = root.current.querySelector("#status");
      if (status) status.textContent = "読み込みに失敗しました。ページを再読み込みしてください。";
      console.error(error);
    });
    return () => { stopped = true; cleanup?.(); };
  }, []);
  return <div ref={root}>
    <header><a className="brand" href="#">活版実験室</a></header>
    <main>
      <section className="stage" aria-labelledby="plate-title">
        <div className="stage-heading"><h1 id="plate-title">版をつくる・インクを塗る</h1><span>01</span></div>
        <div className="stage-content">
          <aside>
            <label className="upload">画像を選ぶ<input id="upload" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" /></label>
            <label>カラー画像の変換<select id="separation" defaultValue="luminance"><option value="luminance">明るさから版を作る</option><option value="red">赤成分から版を作る</option><option value="green">緑成分から版を作る</option><option value="blue">青成分から版を作る</option></select></label>
            <label>版の作り方<select id="plateMode" defaultValue="halftone"><option value="halftone">網点（写真・グラデーション）</option><option value="binary">二値化（文字・線画）</option></select></label>
            <Range id="threshold" label="版の濃さ・二値化のしきい値" value={150} max={255} />
            <label className="check"><input id="invert" type="checkbox" /> 白黒を反転</label>
            <button id="sample" className="quiet">サンプルの版に戻す</button>
            <p className="hint">画像を単色用の凸版に変換します。カラー画像の元の色は印刷されません。</p>
            <div className="color-picker"><label htmlFor="color">塗るインクの色</label><canvas id="colorPalette" width="280" height="180" tabIndex={0} aria-label="色の明るさと鮮やかさ。矢印キーでも調整できます" /><label className="hue-label">色相<input id="colorHue" type="range" min="0" max="360" defaultValue="5" /></label><input type="color" id="color" defaultValue="#bc3d32" /><output id="colorOut">#BC3D32</output></div>
            <Range id="ink" label="一回に塗るインク量" value={35} />
            <label>塗り方<select id="inkMode" defaultValue="paint"><option value="paint">手塗り</option><option value="uniform">全面に一定量</option><option value="gradient">量のグラデーション</option></select></label>
            <div id="paintControls"><Range id="brushSize" label="ローラーの半径" value={45} max={120} /><label className="check"><input id="eraseInk" type="checkbox" /> インクを拭き取る</label><button id="clearInk" className="quiet">インクを全部拭く</button><p className="hint">版をドラッグして塗布。同じ場所を重ね塗りすると厚くなります。色を変えると次の塗布から変わります。</p></div>
            <div id="gradientControls" hidden><Range id="gradientEnd" label="グラデーションの終点量" value={10} /><label>向き<select id="gradientAngle"><option value="0">左 → 右（刷り上がり）</option><option value="90">上 → 下</option><option value="45">左上 → 右下</option></select></label></div>
          </aside>
          <div className="canvas-area"><div className="board plate-board"><canvas id="plate" tabIndex={0} aria-label="鏡像の版。ドラッグで塗布。矢印で位置を移動し、スペースで塗布" width="640" height="640" /></div><p className="canvas-caption">鏡像の版面 · 暗い金属が凸部 / 色が付いた部分がインク</p></div>
        </div>
      </section>
      <section className="stage" aria-labelledby="print-title">
        <div className="stage-heading"><h2 id="print-title">刷る</h2><span id="count">0回</span></div>
        <div className="stage-content">
          <aside>
            <label>計算解像度<select id="resolution" defaultValue="8192"><option value="8192">8K（細かい計算）</option><option value="4096">4K（軽い計算）</option></select></label><button id="restartResolution" className="quiet">選んだ解像度で新しく始める</button><p className="hint">版・インク・紙をリセットして開始します。保存画像はどちらも4Kです。</p>
            <Range id="pressure" label="押す圧" value={55} /><Range id="roughness" label="紙の粗さ" value={55} /><Range id="speed" label="剥がす速度" value={40} /><Range id="viscosity" label="インクの粘度" value={60} />
            <p className="hint">厚塗りほど版の縁にはみ出します。低い粘度では紙ににじみ、高速の剥離では小さな飛沫が出ます。</p>
            <label>剥がす方向<select id="direction"><option value="0">左から右</option><option value="90">上から下</option><option value="45">左上から右下</option></select></label>
            <Range id="offsetX" label="横の位置" value={0} min={-100} max={100} /><Range id="offsetY" label="縦の位置" value={0} min={-100} max={100} />
            <label className="check"><input id="transparentExport" type="checkbox" /> PNGの紙を透過する</label>
            <div className="actions"><button disabled id="print" className="primary">版を押して、刷る</button><button id="clear" className="quiet">新しい紙</button><button id="dry" className="quiet">インクを乾かす</button><button id="download" className="quiet">4K PNGを保存</button></div>
            <p id="status" className="status" role="status">読み込み中…</p>
          </aside>
          <div className="canvas-area"><div className="board"><canvas id="paper" width="640" height="640" aria-label="試し刷り結果" /><div id="empty">版にインクを塗り、「刷る」を押してください</div></div><p className="canvas-caption">刷り上がり</p></div>
        </div>
      </section>
      <footer><a href="https://www.jstage.jst.go.jp/article/nig1958/24/1/24_1_41/_article/-char/en" target="_blank" rel="noopener">参考文献：Studies on Printing Ink Transfer (1986)</a> · <a href="https://www.jstage.jst.go.jp/article/jtappij1955/45/7/45_7_809/_article/-char/en" target="_blank" rel="noopener">Ink Transfer Parameters (1991)</a> · <a href="https://arxiv.org/abs/2001.10209" target="_blank" rel="noopener">Liquid Bridge Breakup (2020)</a></footer>
    </main>
  </div>;
}
