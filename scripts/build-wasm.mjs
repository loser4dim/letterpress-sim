import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
const result = spawnSync("cargo", ["build", "--manifest-path", "rust/Cargo.toml", "--release", "--target", "wasm32-unknown-unknown"], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync("public/wasm", { recursive: true });
copyFileSync("rust/target/wasm32-unknown-unknown/release/letterpress_engine.wasm", "public/wasm/letterpress_engine.wasm");
console.log("Rust engine → public/wasm/letterpress_engine.wasm");
