"use client";

import { useParams, useRouter } from "next/navigation";
import { StoryPlayer } from "@/components/story/StoryPlayer";
import { Loading } from "@/components/ui/Loading";

/**
 * 故事播放器路由：/stories/[code]
 * 这里是纯客户端数据流（没有后端也要能跑通、能构建），因此不做构建期取数。
 */
export default function StoryPage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const code = typeof params?.code === "string" ? params.code : "";

  if (!code) return <Loading label="正在找这个故事…" />;

  return (
    <div className="mx-auto max-w-3xl px-4 py-5">
      <StoryPlayer code={code} onBack={() => router.push("/")} />
    </div>
  );
}
