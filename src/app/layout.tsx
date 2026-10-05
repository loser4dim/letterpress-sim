import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "活版実験室", description: "画像から凸版を作り、インクを塗って紙に刷る実験室。" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="ja"><body>{children}</body></html>; }
