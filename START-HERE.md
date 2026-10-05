# 更新方法

このZIPはプロジェクト全体です。Rustソース・テスト、WASMテスト、ビルドスクリプト、コンパイル済みWASM、Worker、pnpmの依存関係とロックファイル、GitHub Pagesのワークフローを含みます。

既存プロジェクトの変更をコミットしてから、ZIP内のletterpress-simフォルダの中身を既存プロジェクトへ上書きしてください。.gitやnode_modulesはZIPに含めていません。

```cmd
pnpm install --frozen-lockfile
pnpm dev
```

同梱WASMですぐ動かせます。Rust側もビルド・検証する場合は、プロジェクト直下で以下を実行してください。

```cmd
rustup update stable
rustup target add wasm32-unknown-unknown
cargo test --manifest-path rust/Cargo.toml
pnpm build:wasm
pnpm test:wasm
pnpm exec eslint .
pnpm exec tsc --noEmit
pnpm build
```

WindowsのMSVC構成でcargo testを使う場合は、Visual StudioのC++ビルドツールとWindows SDKが必要です。WASMビルドとpnpm test:wasmはそれらなしで実行できます。

## 8K / 4K

正方形で8K = 8192 × 8192の紙格子、4K = 4096 × 4096のPNGです。16:9の7680 × 4320 / 3840 × 2160ではありません。

8K格子での計算はWorker上で行い、PNGは8Kの2 × 2点を平均します。画面のプレビューを単に拡大した画像ではありません。手塗りの膜厚・顔料の場は512 × 512から補間しています。

密な全面印刷では紙の状態だけで約0.94 GBとなり、入力キャンバスや出力にも追加メモリが必要です。画面のプレビューは640 × 640です。詳しいモデルとテスト内容はREADME.mdを参照してください。

ブラウザで手塗り→8K印刷→4096 × 4096 PNGの保存、デスクトップ／スマホの同サイズ上下配置を確認済みです。全8K面を厚塗りした長時間の負荷試験は未実施です。
