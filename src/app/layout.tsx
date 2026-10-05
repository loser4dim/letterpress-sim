import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "活版実験室 — Next.js × Rust", description: "画像から凸版を作り、Rust / WebAssemblyでインクと紙の印刷を試す実験室。" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="ja"><body>{children}</body></html>; }
