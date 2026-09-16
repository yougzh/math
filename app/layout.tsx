import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import "./globals.css";
import { DebugPanel } from "@/components/dev/DebugPanel";
import { PendingAttemptsNotice } from "@/components/system/PendingAttemptsNotice";

export const metadata: Metadata = {
  title: "数学世界",
  description: "孩子以为自己在玩故事，其实一直在做数学训练。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#fdf8ef",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <PendingAttemptsNotice />
        <Suspense fallback={null}>
          <DebugPanel />
        </Suspense>
      </body>
    </html>
  );
}
