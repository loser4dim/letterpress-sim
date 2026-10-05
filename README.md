# 活版実験室

Next.js / Reactの画面とRust / WebAssemblyの印刷エンジン。ブラウザ内で画像から単色用の凸版を作り、インクを塗って紙へ転写します。

## 解像度

- シミュレーションの紙：**8192 × 8192**。インク転移、紙の接触、にじみ、飛沫、湿ったインクの移動、圧痕をこの格子で処理します。
- PNG保存：**4096 × 4096**。8K格子の2 × 2点を、色へ変換した後で平均します。プレビューを拡大して保存する処理ではありません。
- 画面プレビュー：640 × 640。版のプレビュー・手塗りの膜厚と顔料のフィールド：512 × 512。手塗りを8Kの版上で双線形補間します。
- 画像の輝度／選択したRGB成分：6552 × 6552。二値化／網点の凸部を8K紙の対応する位置で評価します。

紙は64 × 64のタイルに分割し、インクや圧痕が発生したタイルだけ確保します。紙の光学濃度は16ビット固定小数点で保存し、紙目を座標から生成します。密な全面印刷では紙の状態だけで約0.94 GB、画像入力・出力・ブラウザのキャンバスにも追加メモリが必要です。8K処理はWeb Worker上で行いますが、処理時間や必要メモリは画像と端末に依存します。

## ローカル起動

```cmd
pnpm install --frozen-lockfile
pnpm dev
```

コンパイル済みWASMとWorkerを同梱しています。Next.jsの依存関係はpnpm-lock.yamlに固定されています。

## Rustを変更する

rustupから最新のstableをインストールします。rust/rust-toolchain.tomlでもstableを選択しています。

```cmd
rustup update stable
rustup target add wasm32-unknown-unknown
pnpm build:wasm
pnpm test:wasm
pnpm dev
```

Windows上の標準MSVC構成で通常のcargo testを実行するには、Visual StudioのC++ビルドツールとWindows SDKが必要です。このエンジンのWASMだけをビルドし、Node.jsでWASMをテストする場合はそれらを必要としません。エンジンに外部クレートやC/C++ビルドスクリプトはありません。

```cmd
cargo test --manifest-path rust/Cargo.toml
pnpm exec eslint .
pnpm exec tsc --noEmit
pnpm build
```

## テスト

- rust/src/lib.rs：圧力ゼロ、塗布インクの減少、転移量、8K→4Kの平均化、乾燥・紙の交換を検査します。計算規則の単体テストは小さな格子で実行します。
- scripts/test-wasm.mjs：実際の8192格子のWASM、疎なタイル確保、4096出力、転移、乾燥、膜厚減少、厚塗り、Workerのメッセージ転送と進捗を検査します。全8K面を厚塗りする負荷テストではありません。
- GitHub Actions：Rustテスト、WASMビルド／テスト、ESLint、Next.jsビルドを行ってoutをPagesへ公開します。

## モデルの範囲

カラー画像は輝度またはRGB成分を単色用の網点・二値版に変換します。原画像の色を自動で多版印刷する機能はありません。塗った色は版の膜厚とともに保持され、印刷で減少します。

接触・分離・インク輸送は物理現象を参考にした簡略モデルです。色はRGBから計算した光学濃度の近似で、分光顔料モデルではありません。広がりと飛沫は再現可能な乱数で転移先を選びます。実測の粘度・圧力・紙物性による実機結果の予測には使えません。

参考文献：[Studies on Printing Ink Transfer (1986)](https://www.jstage.jst.go.jp/article/nig1958/24/1/24_1_41/_article/-char/en)
