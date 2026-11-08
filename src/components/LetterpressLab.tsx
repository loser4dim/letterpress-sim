"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { loadEngine } from "../lib/wasm";
import { FONT_CATALOG, FONT_CATEGORIES } from "../lib/font-catalog";
import { initLab } from "../lib/init-lab";
const stages = [
  { id: "plate", title: "版を作る" },
  { id: "ink", title: "インクを塗る" },
  { id: "print", title: "刷る・保存" },
] as const;

function StageHeading({ id, number, title, description, children }: {
  id: string;
  number: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return <div className="stage-heading">
    <span className="step-number" aria-hidden="true">{number}</span>
    <div>
      <h2 id={id} tabIndex={-1}>{title}</h2>
      <p>{description}</p>
    </div>
    {children}
  </div>;
}

function Range({ id, label, value, max = 100, min = 0 }: { id: string; label: string; value: number; max?: number; min?: number }) {
  return <label>{label}<output id={id + "Out"}>{value}</output><input disabled id={id} type="range" min={min} max={max} defaultValue={value} /></label>;
}
function FontOptions() {
  return <>{FONT_CATEGORIES.map(category => <optgroup key={category} label={category}>{FONT_CATALOG.filter(font => font.category === category).map(font => <option key={font.family} value={font.family}>{font.label}</option>)}</optgroup>)}</>;
}
export default function LetterpressLab() {
  const root = useRef<HTMLDivElement>(null);
  const [session, setSession] = useState<{ resolution: number; sample: boolean } | null>(null);
  const [choice, setChoice] = useState(4096);
  useEffect(() => {
    if (!session) return;
    window.scrollTo(0, 0);
    root.current?.querySelector<HTMLElement>("#plate-title")?.focus({ preventScroll: true });
    let stopped = false;
    let cleanup: (() => void) | undefined;
    loadEngine(session.resolution).then(engine => {
      if (!stopped && root.current) cleanup = initLab(root.current, engine, { sample: session.sample });
      else engine.dispose();
    }).catch(error => {
      if (stopped || !root.current) return;
      const status = root.current.querySelector("#status");
      if (status) status.textContent = "読み込みに失敗しました。最初からやり直してください。";
      console.error(error);
    });
    return () => { stopped = true; cleanup?.(); };
  }, [session]);
  function restart() {
    if (root.current?.dataset.hasWork === "true"
        && !window.confirm("版・インク・紙をリセットして、最初に戻りますか？")) return;
    setSession(null);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("#startSample")?.focus());
  }

  return <div ref={root}>
    <header className="masthead">
      <div className="masthead-inner">
        <a className="brand" href="#">活版実験室</a>
        <span className="masthead-caption">LETTERPRESS LAB</span>
      </div>
    </header>
    <main>
      {!session ? <section className="start-panel">
        <div className="start-copy">
          <p className="eyebrow">BROWSER PRINT STUDIO</p>
          <h1>版を組んで、<br />一枚を刷る。</h1>
          <p className="start-description">文字や画像で版を作り、ローラーでインクを載せます。紙を替えたり色を重ねたりしながら、刷り上がりの違いを試せます。</p>
          <fieldset className="resolution-choices">
            <legend>計算解像度</legend>
            <label><input type="radio" name="resolution" value="4096" checked={choice === 4096} onChange={() => setChoice(4096)} /><strong>4K</strong><span>標準・軽め</span></label>
            <label><input type="radio" name="resolution" value="8192" checked={choice === 8192} onChange={() => setChoice(8192)} /><strong>8K</strong><span>精細・負荷高め</span></label>
          </fieldset>
          <p className="hint">保存はどちらも4K PNGです。</p>
          <div className="start-actions">
            <button id="startSample" className="primary" onClick={() => setSession({ resolution: choice, sample: true })}>見本の版で始める</button>
            <button id="startLab" className="quiet" onClick={() => setSession({ resolution: choice, sample: false })}>空の版から始める</button>
          </div>
        </div>
        <div className="start-specimen" aria-hidden="true">
          <div className="specimen-sheet">
            <span className="specimen-meta">活 版 実 験 室</span>
            <span className="specimen-type">活版</span>
            <span className="specimen-meta">INK · PAPER · PRESS</span>
          </div>
        </div>
      </section> : <>
        <div className="session-bar" id="workspaceStart">
          <div className="session-plate">
            <label htmlFor="assemblyList">使う版</label>
            <select disabled id="assemblyList" />
            <button disabled id="newAssembly" className="quiet">新しい版</button>
          </div>
          <div className="session-options">
            <span className="resolution-badge">{session.resolution === 8192 ? "8K" : "4K"}</span>
            <button className="quiet" id="restartLab" onClick={restart}>最初に戻る</button>
          </div>
        </div>
        <div className="workflow">
          <div className="workflow-tabs" role="tablist" aria-label="印刷の工程">
            {stages.map(({ id, title }, index) => <button
              key={id} id={`${id}-tab`} type="button" role="tab" data-stage={id}
              aria-controls={`${id}-stage`} aria-selected={index === 0} tabIndex={index === 0 ? 0 : -1}
            ><span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>{title}</button>)}
          </div>
          <div className="workflow-feedback">
            <p id="status" className="status" role="status">印刷エンジンを読み込んでいます…</p>
            <progress id="printProgress" max={100} value={0} aria-label="印刷の進み具合" hidden />
          </div>
        </div>
        <section className="stage" id="plate-stage" role="tabpanel" aria-labelledby="plate-tab">
          <StageHeading id="plate-title" number="01" title="版を作る" description="文字や画像を置き、紙に写る形を作ります。">
            <button disabled id="toInk" className="primary" data-go-stage="ink">塗布へ <span aria-hidden="true">→</span></button>
          </StageHeading>
          <div className="stage-content">
            <aside>
              <div className="control-group quick-start" id="blankPlateGuide">
                <h3>まず一枚組む</h3>
                <p className="hint">見本を使うか、下の欄から文字や画像を入れます。</p>
                <button disabled id="sample" className="quiet">見本の版を置く</button>
              </div>
              <h3>文字を入れる</h3>
              <label>文字<textarea disabled id="textInput" rows={3} maxLength={128} defaultValue="活版" /></label>
              <label>書体<select disabled id="textFont" defaultValue="system"><FontOptions /></select></label><p id="textFontPreview" className="font-example">Letterpress Aa 0123</p><button disabled id="textFontBrowse" className="quiet">書体の見本から選ぶ</button>
              <p className="hint">英字向け書体は日本語に対応しない場合があります。</p>
              <Range id="textSize" label="文字の大きさ" value={40} min={16} max={96} />
              <Range id="textPadding" label="文字のまわりの余白" value={0} max={24} />
              <button disabled id="addText" className="quiet">1文字ずつ追加</button>
              <p className="hint">字面ぴったりの台座を1文字ずつ作ります。改行と空白も使えます。Google Fontsの書体は通信して読み込みます。</p>
              <h3>画像を入れる</h3>
              <label className="upload">画像を選ぶ<input disabled id="upload" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" /></label>
              <label>画像の版の作り方<select disabled id="plateMode" defaultValue="halftone"><option value="halftone">写真：網点（AM）</option><option value="diffusion">写真：細かい点（誤差拡散）</option><option value="binary">線画：二値化</option></select></label>
              <details className="control-details">
                <summary>画像の階調と色成分</summary>
                <label>カラー画像の変換<select disabled id="separation" defaultValue="luminance"><option value="luminance">明るさ</option><option value="red">赤成分</option><option value="green">緑成分</option><option value="blue">青成分</option></select></label>
                <Range id="threshold" label="二値化のしきい値" value={150} max={255} />
                <Range id="screen" label="網点の細かさ" value={128} min={32} max={192} />
                <Range id="tone" label="写真の明るさ（濃い ← → 薄い）" value={125} min={50} max={220} />
                <label className="check"><input disabled id="invert" type="checkbox" /> 画像の白黒を反転</label>
              </details>
              <button disabled id="sampleInImage" className="quiet" hidden>見本の画像を使う</button>
              <p className="hint">画像は1版に1枚です。選び直すと現在の画像だけが置き換わります。</p>
              <details className="control-details">
                <summary>版の管理・参照</summary>
                <label>版の名前<input disabled id="assemblyName" type="text" maxLength={32} defaultValue="版1" /></label>
                <label>位置・大きさのスナップ<select disabled id="snap" defaultValue="8"><option value="0">なし</option><option value="4">4</option><option value="8">8</option><option value="16">16</option><option value="32">32</option></select></label>
                <label className="check"><input disabled id="keepAspect" type="checkbox" defaultChecked /> 画像の縦横比を保つ</label>
                <fieldset className="reference-controls"><legend>透かして参照する版</legend><div id="referenceList" /><Range id="referenceOpacity" label="参照版の濃さ" value={25} max={60} /></fieldset>
                <button disabled id="removeAssembly" className="quiet">この版を外す</button>
              </details>
              <details className="control-details" id="selectionDetails" hidden>
                <summary>選んだ台座を調整</summary>
                <label>選択中<select disabled id="blockList" /></label>
                <label className="check"><input disabled id="blockLocked" type="checkbox" /> 位置と大きさを固定</label>
                <Range id="blockSize" label="台座の幅" value={40} min={8} max={512} />
                <div id="glyphControls" hidden>
                  <label>この文字の書体<select disabled id="glyphFont" defaultValue="system"><FontOptions /></select></label><p id="glyphFontPreview" className="font-example">Letterpress Aa 0123</p><button disabled id="glyphFontBrowse" className="quiet">書体の見本から選ぶ</button>
                  <Range id="glyphLeft" label="左の余白（刷り上がり）" value={2} max={32} /><Range id="glyphRight" label="右の余白（刷り上がり）" value={2} max={32} /><Range id="glyphTop" label="上の余白" value={2} max={32} /><Range id="glyphBottom" label="下の余白" value={2} max={32} />
                </div>
                <button disabled id="removeBlock" className="quiet">選んだ文字・画像を外す</button>
                <p className="hint">角の四角をドラッグするとサイズ変更できます。文字は縦横比を保ちます。台座どうしは重ねられず、文字の余白を詰めると隣り合わせにできます。矢印キーでも移動できます。</p>
              </details>
            </aside>
            <div className="canvas-area">
              <div className="board plate-board"><canvas id="plate" tabIndex={0} aria-label="台座をドラッグして版を組む" width="640" height="640" /></div>
              <p className="canvas-caption board-caption">鏡像の版面 · ドラッグで組版</p>
            </div>
          </div>
        </section>
        <section className="stage" id="ink-stage" role="tabpanel" aria-labelledby="ink-tab" hidden>
          <StageHeading id="ink-title" number="02" title="インクを塗る" description="色を選び、版の上でローラーを転がします。">
            <button disabled id="toPrint" className="primary" data-go-stage="print">刷りへ <span aria-hidden="true">→</span></button>
          </StageHeading>
          <div className="stage-content">
            <aside>
              <div className="control-group quick-start" id="blankInkGuide">
                <p className="hint">この版は空です。先に文字・画像・見本を置いてください。</p>
                <button type="button" className="quiet" data-go-stage="plate">版を作るへ</button>
              </div>
              <h3>色を選ぶ</h3>
              <div className="color-picker"><label htmlFor="color">インクの色</label><canvas id="colorPalette" width="280" height="180" tabIndex={0} aria-label="色の明るさと鮮やかさ。矢印キーでも調整できます" /><label className="hue-label">色相<input disabled id="colorHue" type="range" min="0" max="360" defaultValue="5" /></label><input disabled type="color" id="color" defaultValue="#bc3d32" /><output id="colorOut">#BC3D32</output></div>
              <Range id="ink" label="ローラーに補充するインク量" value={35} />
              <Range id="inkScattering" label="インクの隠蔽力（顔料の散乱）" value={100} min={5} max={400} />
              <p className="hint">低いほど下色が見えます。変更後にローラーで載せたインクに適用します。</p>
              <h3>ローラーの操作</h3>
              <Range id="brushSize" label="ローラーの幅" value={90} min={16} max={256} />
              <button disabled id="reloadRoller" className="quiet">同じ色のインクを補充</button>
              <details className="control-details">
                <summary>インクを拭き取る</summary>
                <label className="check"><input disabled id="eraseInk" type="checkbox" /> ドラッグしたところを布で拭く</label>
                <button disabled id="clearInk" className="quiet">版のインクを全部拭く</button>
              </details>
            </aside>
            <div className="canvas-area">
              <div className="board plate-board"><div className="ink-surface"><canvas id="inkPlate" tabIndex={0} aria-label="ローラーで版にインクを塗る" width="640" height="640" /><div id="inkCursor" aria-hidden="true" hidden /></div></div>
              <p className="canvas-caption board-caption">ドラッグで塗布 · キーボードでは矢印キー</p>
            </div>
          </div>
        </section>
        <dialog id="fontDialog" aria-labelledby="fontDialogTitle">
          <div className="font-dialog-heading"><h2 id="fontDialogTitle">書体を見て選ぶ</h2><button id="fontClose" type="button" className="quiet">閉じる</button></div>
          <div className="font-filter"><label>書体名を検索<input id="fontSearch" type="search" placeholder="Garamond, Mono, Script…" /></label><label>種類<select id="fontCategory"><option value="">すべて</option>{FONT_CATEGORIES.map(category => <option key={category} value={category}>{category}</option>)}</select></label></div>
          <label>見本の文字<input id="fontSample" type="text" maxLength={80} defaultValue="Letterpress Aa 0123" /></label><p id="fontCount" className="hint" /><div id="fontGrid" /><p className="hint">表示中の書体から順に読み込みます。</p>
        </dialog>
        <section className="stage" id="print-stage" role="tabpanel" aria-labelledby="print-tab" hidden>
          <StageHeading id="print-title" number="03" title="刷る・保存" description="紙へ転写し、重ね刷りやPNG保存をします。">
            <button disabled id="print" className="primary">版を押して刷る</button>
          </StageHeading>
          <div className="stage-content">
            <aside>
              <div className="control-group quick-start" id="blankPrintGuide">
                <p className="hint">まず版を作ると刷れるようになります。</p>
                <button type="button" className="quiet" data-go-stage="plate">版を作るへ</button>
              </div>
              <Range id="pressure" label="押す圧" value={55} />
              <label className="check"><input disabled id="dryBefore" type="checkbox" defaultChecked /> 下刷りを乾かしてから刷る</label>
              <p className="hint">乾かすと色が層になり、湿ったままだと顔料が混ざります。インクなしなら空押しできます。</p>
              <details className="control-details">
                <summary>位置合わせ</summary>
                <label className="check"><input disabled id="showRegistration" type="checkbox" /> 次に刷る版の位置を紙に表示</label>
                <Range id="offsetX" label="横の位置" value={0} min={-100} max={100} />
                <Range id="offsetY" label="縦の位置" value={0} min={-100} max={100} />
                <p className="hint">青いガイドで版の位置を確認できます。PNGには入りません。</p>
              </details>
              <details className="control-details">
                <summary>紙と剥がし方</summary>
                <Range id="roughness" label="紙の粗さ" value={55} /><Range id="dwell" label="押している時間" value={40} />
                <Range id="speed" label="剥がす速度" value={40} /><Range id="viscosity" label="インクの粘度" value={60} /><Range id="elasticity" label="インクの糸引き" value={55} /><Range id="heightStrength" label="インクの盛り上がりの陰影" value={60} />
                <label>剥がす方向<select disabled id="direction"><option value="0">左から右</option><option value="90">上から下</option><option value="45">左上から右下</option></select></label>
              </details>
              <details className="control-details">
                <summary>紙・重ね刷りの実験設定</summary>
                <Range id="paperCompliance" label="紙の沈みやすさ" value={50} />
                <Range id="paperMoisture" label="紙の湿り具合" value={0} />
                <Range id="edgeSqueeze" label="版の縁でのインクの広がり" value={65} />
                <Range id="dryTrapping" label="乾いた下刷りへのインクの付きやすさ" value={92} />
                <Range id="wetTrapping" label="湿った下刷りへのインクの付きやすさ" value={78} />
                <Range id="dryRetention" label="乾燥後に残る表面膜厚" value={100} min={25} />
                <p className="hint">値は実測値に対応しない相対量です。乾燥後の膜厚は色を固定したまま、次の接触と陰影に反映します。</p>
              </details>
            </aside>
            <div className="canvas-area">
              <div className="board">
                <div className="paper-surface">
                  <canvas id="paper" width="640" height="640" aria-label="試し刷り結果" />
                  <canvas id="registration" width="640" height="640" aria-hidden="true" hidden />
                  <div id="empty">ここに刷り上がりが表示されます</div>
                </div>
              </div>
              <div className="canvas-actions">
                <p className="canvas-caption">現在の紙 <span id="count" className="impression-count">0回</span></p>
                <button disabled id="clear" className="quiet">新しい紙に交換</button>
              </div>
              <div className="save-controls">
                <label>PNGの背景<select disabled id="exportBackground" defaultValue="transparent"><option value="transparent">透過（インクだけ）</option><option value="paper">紙を含める</option></select></label>
                <button disabled id="download" className="quiet">4K PNGを保存</button>
                <p id="saveHint" className="hint">一度刷ると保存できます。</p>
              </div>
            </div>
          </div>
        </section>
      </>}
      <footer><span>参考文献</span> <a href="https://www.jstage.jst.go.jp/article/nig1958/24/1/24_1_41/_article/-char/en" target="_blank" rel="noopener">Ink Transfer (1986)</a> · <a href="https://www.jstage.jst.go.jp/article/photogrst1964/68/4/68_4_309/_article" target="_blank" rel="noopener">印刷における階調表現 (2005)</a> · <a href="https://bioresources.cnr.ncsu.edu/wp-content/uploads/2020/02/1989.2.951.pdf" target="_blank" rel="noopener">Paper Compressibility (1989)</a> · <a href="https://arxiv.org/abs/2001.10209" target="_blank" rel="noopener">Liquid Bridge Breakup (2020)</a> · <a href="https://grail.cs.washington.edu/projects/watercolor/" target="_blank" rel="noopener">Pigment Layers / Kubelka–Munk (1997)</a></footer>
    </main>
  </div>;
}
