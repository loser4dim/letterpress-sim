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
          <div className="stage-heading"><h1 id="plate-title">版を作る</h1><span>01</span></div>
          <div className="stage-content"><aside>
            <h3>基本的な組み方</h3>
            <label>使う版<select disabled id="assemblyList" /></label>
            <label>版の名前<input disabled id="assemblyName" type="text" maxLength={32} defaultValue="版1" /></label>
            <div className="button-row"><button disabled id="newAssembly" className="quiet">新しい版を作る</button><button disabled id="removeAssembly" className="quiet">この版を外す</button></div>
            <label>位置・大きさのスナップ<select disabled id="snap" defaultValue="8"><option value="0">なし</option><option value="4">4</option><option value="8">8</option><option value="16">16</option><option value="32">32</option></select></label>
            <label className="check"><input disabled id="keepAspect" type="checkbox" defaultChecked /> 画像の縦横比を保つ</label>
            <fieldset className="reference-controls"><legend>透かして参照する版</legend><div id="referenceList" /><Range id="referenceOpacity" label="参照版の濃さ" value={25} max={60} /></fieldset>
            <p className="hint">版だけを切り替えられます。刷った紙と各版のインクは残ります。参照版は組版画面だけに表示します。</p>
            <h3>文字を入れる</h3>
            <label>文字<textarea disabled id="textInput" rows={3} maxLength={128} defaultValue="活版" /></label>
            <label>書体<select disabled id="textFont" defaultValue="system"><option value="system">端末の明朝体</option><option value="Noto Serif JP">Noto Serif JP</option><option value="Noto Sans JP">Noto Sans JP</option><option value="Zen Old Mincho">Zen Old Mincho</option><option value="Shippori Mincho">Shippori Mincho</option></select></label>
            <Range id="textSize" label="文字の大きさ" value={40} min={16} max={96} />
            <Range id="textPadding" label="文字のまわりの余白" value={2} max={24} />
            <button disabled id="addText" className="quiet">1文字ずつ追加</button>
            <p className="hint">1文字ずつ台座を作ります。改行と空白も使えます。Google Fontsの書体は通信して読み込みます。</p>
            <h3>画像を入れる</h3>
            <label>画像の版の作り方<select disabled id="plateMode" defaultValue="halftone"><option value="halftone">写真：網点（AM）</option><option value="diffusion">写真：細かい点（誤差拡散）</option><option value="binary">線画：二値化</option></select></label>
            <label>カラー画像の変換<select disabled id="separation" defaultValue="luminance"><option value="luminance">明るさ</option><option value="red">赤成分</option><option value="green">緑成分</option><option value="blue">青成分</option></select></label>
            <Range id="threshold" label="二値化のしきい値" value={150} max={255} />
            <Range id="screen" label="網点の細かさ" value={128} min={32} max={192} />
            <Range id="tone" label="写真の明るさ（濃い ← → 薄い）" value={125} min={50} max={220} />
            <label className="check"><input disabled id="invert" type="checkbox" /> 画像の白黒を反転</label>
            <label className="upload">画像を選ぶ（1つの版につき1枚）<input disabled id="upload" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" /></label>
            <button disabled id="sample" className="quiet">サンプル画像を使う</button>
            <p className="hint">画像を選び直すと、その版の画像だけを置き換えます。</p>
            <h3>選んだ文字・画像を調整</h3>
            <label>選択中<select disabled id="blockList" /></label>
            <label className="check"><input disabled id="blockLocked" type="checkbox" /> 位置と大きさを固定</label>
            <Range id="blockSize" label="台座の幅" value={40} min={8} max={512} />
            <div id="glyphControls" hidden>
              <label>この文字の書体<select disabled id="glyphFont"><option value="system">端末の明朝体</option><option value="Noto Serif JP">Noto Serif JP</option><option value="Noto Sans JP">Noto Sans JP</option><option value="Zen Old Mincho">Zen Old Mincho</option><option value="Shippori Mincho">Shippori Mincho</option></select></label>
              <Range id="glyphLeft" label="左の余白（刷り上がり）" value={2} max={32} /><Range id="glyphRight" label="右の余白（刷り上がり）" value={2} max={32} /><Range id="glyphTop" label="上の余白" value={2} max={32} /><Range id="glyphBottom" label="下の余白" value={2} max={32} />
            </div>
            <button disabled id="removeBlock" className="quiet">選んだ文字・画像を外す</button>
            <p className="hint">角の四角をドラッグするとサイズ変更できます。文字は縦横比を保ちます。台座どうしは重ねられず、文字の余白を詰めると隣り合わせにできます。矢印キーでも移動できます。</p>
          </aside><div className="canvas-area"><div className="board plate-board"><canvas id="plate" tabIndex={0} aria-label="台座をドラッグして版を組む" width="640" height="640" /></div><p className="canvas-caption" id="plateCaption">鏡像の版面 · 台座をドラッグして組版</p><p id="plateStatus" className="status" role="status" /></div></div>
        </section>
        <section className="stage" aria-labelledby="ink-title">
          <div className="stage-heading"><h2 id="ink-title">インクを塗る</h2><span>02</span></div>
          <div className="stage-content"><aside>
            <button disabled id="clearInk" className="quiet">版のインクを全部拭く</button>
            <h3>ローラーで塗る</h3>
            <div id="paintControls"><Range id="brushSize" label="ローラーの幅" value={90} min={16} max={256} /><label className="check"><input disabled id="eraseInk" type="checkbox" /> 布で拭き取る</label><button disabled id="reloadRoller" className="quiet">同じ色のインクをローラーに補充</button><p className="hint">版面をドラッグして塗ります。ローラーのインクは減り、版からの回収でも混ざります。停止中はインクが増えません。</p></div>
            <h3>色を選ぶ</h3>
            <div className="color-picker"><label htmlFor="color">インクの色</label><canvas id="colorPalette" width="280" height="180" tabIndex={0} aria-label="色の明るさと鮮やかさ。矢印キーでも調整できます" /><label className="hue-label">色相<input disabled id="colorHue" type="range" min="0" max="360" defaultValue="5" /></label><input disabled type="color" id="color" defaultValue="#bc3d32" /><output id="colorOut">#BC3D32</output></div>
            <Range id="ink" label="ローラーに補充するインク量" value={35} />
          </aside><div className="canvas-area"><div className="board plate-board"><div className="ink-surface"><canvas id="inkPlate" tabIndex={0} aria-label="ローラーで版にインクを塗る" width="640" height="640" /><div id="inkCursor" aria-hidden="true" hidden /></div></div><p className="canvas-caption">鏡像の版面 · ローラーをドラッグしてインクを載せる</p></div></div>
        </section>
        <section className="stage" aria-labelledby="print-title">
          <div className="stage-heading"><h2 id="print-title">刷る</h2><span id="count">0回</span></div>
          <div className="stage-content"><aside>
            <Range id="pressure" label="押す圧" value={55} /><Range id="roughness" label="紙の粗さ" value={55} /><Range id="dwell" label="押している時間" value={40} />
            <Range id="speed" label="剥がす速度" value={40} /><Range id="viscosity" label="インクの粘度" value={60} /><Range id="elasticity" label="インクの糸引き" value={55} /><Range id="heightStrength" label="インクの盛り上がりの陰影" value={60} />
            <label>剥がす方向<select disabled id="direction"><option value="0">左から右</option><option value="90">上から下</option><option value="45">左上から右下</option></select></label>
            <Range id="offsetX" label="横の位置" value={0} min={-100} max={100} /><Range id="offsetY" label="縦の位置" value={0} min={-100} max={100} />
            <label className="check"><input disabled id="dryBefore" type="checkbox" defaultChecked /> 紙のインクを乾かしてから次を刷る</label>
            <p className="hint">乾かすと色が重なり、湿ったまま刷ると前のインクが動き、顔料が混ざります。</p>
            <button disabled id="print" className="primary">版を押して、刷る</button>
            <p id="status" className="status" role="status">読み込み中…</p>
            <div className="save-controls"><h3>結果を保存する</h3><label>PNGの背景<select disabled id="exportBackground" defaultValue="transparent"><option value="transparent">透過（インクだけ）</option><option value="paper">紙を含める</option></select></label><button disabled id="download" className="primary">4K PNGを保存</button></div>
            <div className="paper-controls"><button disabled id="clear" className="quiet">新しい紙に交換</button></div>
          </aside><div className="canvas-area"><div className="board"><canvas id="paper" width="640" height="640" aria-label="試し刷り結果" /><div id="empty">版にインクを載せ、「刷る」を押してください</div></div><p className="canvas-caption">刷り上がり</p></div></div>
        </section>
      </>}
      <footer>参考文献：<a href="https://www.jstage.jst.go.jp/article/nig1958/24/1/24_1_41/_article/-char/en" target="_blank" rel="noopener">Ink Transfer (1986)</a> · <a href="https://www.jstage.jst.go.jp/article/photogrst1964/68/4/68_4_309/_article" target="_blank" rel="noopener">印刷における階調表現 (2005)</a> · <a href="https://bioresources.cnr.ncsu.edu/wp-content/uploads/2020/02/1989.2.951.pdf" target="_blank" rel="noopener">Paper Compressibility (1989)</a> · <a href="https://arxiv.org/abs/2001.10209" target="_blank" rel="noopener">Liquid Bridge Breakup (2020)</a> · <a href="https://grail.cs.washington.edu/projects/watercolor/" target="_blank" rel="noopener">Pigment Layers / Kubelka–Munk (1997)</a></footer>
    </main>
  </div>;
}
