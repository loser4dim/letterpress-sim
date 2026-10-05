import type { NextConfig } from "next";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A deployment gets a new asset directory whenever any engine file changes.
// Worker, WASM and relative module imports therefore share one immutable version.
const source = join(process.cwd(), "public", "wasm");
const files = readdirSync(source).filter(name => /\.(js|wasm)$/.test(name)).sort();
const hash = createHash("sha256");
for (const name of files) hash.update(name).update(readFileSync(join(source, name)));
const enginePath = "/_letterpress_engine/" + hash.digest("hex").slice(0, 16);
const destination = join(process.cwd(), "public", enginePath);
mkdirSync(destination, { recursive: true });
for (const name of files) copyFileSync(join(source, name), join(destination, name));
writeFileSync(join(process.cwd(), "public", "_letterpress_engine", "current.json"), JSON.stringify({ version: enginePath.split("/").at(-1), apiVersion: 3 }));

const nextConfig: NextConfig = {
  output: "export",
  env: { NEXT_PUBLIC_ENGINE_PATH: enginePath },
  trailingSlash: true,
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;