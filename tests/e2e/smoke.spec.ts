import { expect, test, type Page } from "@playwright/test";

/**
 * e2e smoke（迁移完成判据 #5）：
 * 真实 Next server + 真实 Postgres，跑通「首页 → 做题 → 提交 → 成长页 → 家长报告」。
 *
 * 做题策略（不赌题型 —— 故事各 beat 的 interaction_type 随孩子状态变化）：
 * 逐 beat 前进（旁白/奖励一路点过），遇到 UI 可作答的 challenge
 * （number_pad / choice）就**真实 UI 提交**；一路全是拖拽类
 * （blocks / number_line / decompose_drag / carry_exchange）时用同源 API
 * 提交一道真实题目兜底 —— 走的是同一条 Route Handler + PG 链路。
 *
 * UI 提交是否成功以 FeedbackCard（role=status）出现为准：反馈文案来自
 * 服务端（coach），它的出现意味着 attempt 事务 + 教练链路整体打通。
 * 答错也能继续（repair 语气配「继续故事」按钮），所以 smoke 不需要答对。
 */

const API = "/api/v1";

test("首页 → 做题 → 提交 → 成长页 → 家长报告", async ({ page, request }) => {
  // ── ① 首页：world 链路（Route Handler + PG + 内容 bundle）──
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "今天去哪里" })).toBeVisible();

  // ── ② 今日计划：找一个今日故事（plans 链路）──
  const plan = await (await request.get(`${API}/plans/today?child_id=1`)).json();
  const storyCode: string | null =
    plan.segments?.find((s: { story_code?: string | null }) => s.story_code)?.story_code ?? null;

  if (storyCode) {
    // ── ③ 故事页：story 链路 + 自动开学习会话 ──
    // （不 等 progressbar：进度 0% 时内层宽为 0 会被判 hidden）
    await page.goto(`/stories/${storyCode}`);
    await expect(page.getByRole("button", { name: "回到数学世界" })).toBeVisible();

    // ── ④ 做题 + 提交 ──
    await walkAndSubmit(page, request, storyCode);
  } else {
    // 今日计划没有故事段（例如当天都玩过了）：退而用 API 提交验证 attempt 链路
    const world = await (await request.get(`${API}/world?child_id=1`)).json();
    const items = world.universes?.[0]?.slots?.[0]?.items;
    const itemCode: string | undefined = Array.isArray(items) ? items[0]?.code : undefined;
    if (itemCode) await submitViaApi(request, itemCode);
  }

  // ── ⑤ 成长页：growth 链路 ──
  await page.goto("/growth");
  await expect(page.getByRole("heading", { name: "我的成长树" })).toBeVisible();

  // ── ⑥ 家长报告：report 链路（含 UTC 日口径的参与度计算）──
  await page.goto("/parent/report");
  await expect(page.getByRole("heading", { name: "数学成长报告" })).toBeVisible();
});

/**
 * 逐 beat 前进直到完成一次真实提交。
 * 返回提交方式（ui-choice / ui-pad / api）。
 */
async function walkAndSubmit(
  page: Page,
  request: import("@playwright/test").APIRequestContext,
  storyCode: string,
): Promise<"ui-choice" | "ui-pad" | "api"> {
  for (let step = 0; step < 30; step++) {
    // challenge · choice：点第一个选项 + 确认
    const choiceSubmit = page.getByRole("button", { name: "就选它" });
    if (await becomesVisible(choiceSubmit)) {
      await page.locator("ul.grid button").first().click();
      await choiceSubmit.click();
      await expect(page.getByRole("status")).toBeVisible();
      return "ui-choice";
    }

    // challenge · number_pad：NumberPad 监听 window keydown，数字 + 回车即可
    const padDigit = page.getByRole("button", { name: "数字 5" });
    if (await becomesVisible(padDigit)) {
      await page.keyboard.press("5");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("status")).toBeVisible();
      return "ui-pad";
    }

    // reward beat：收下奖励，继续走
    const collect = page.getByRole("button", { name: "收下啦" });
    if (await becomesVisible(collect)) {
      await collect.click();
      continue;
    }

    // narration beat：打字机按钮三态，每点一次前进一步
    const narr = page.getByRole("button", { name: /快点说完|然后呢\？|看完啦/ });
    if (await becomesVisible(narr)) {
      await narr.click();
      continue;
    }

    // 以上都不匹配：当前 challenge 是拖拽类（blocks 等）→ API 兜底提交
    const story = await (await request.get(`${API}/stories/${storyCode}?child_id=1`)).json();
    const challenge = story.beats?.find((b: { type: string }) => b.type === "challenge")?.challenge;
    if (!challenge?.item?.code) throw new Error("story 响应里没有 challenge item，无法验证提交链路");
    const res = await submitViaApi(request, challenge.item.code);
    expect(res.ok()).toBeTruthy();
    return "api";
  }
  throw new Error("故事步数超出上限仍未完成提交");
}

/** 短暂等待元素出现；超时返回 false（不抛错，用于逐个特征判定当前 beat）。 */
async function becomesVisible(locator: ReturnType<Page["getByRole"]>): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout: 2_500 });
    return true;
  } catch {
    return false;
  }
}

/** 同源 API 提交一道真实题目（与页面走同一条 /api/v1/attempts）。 */
async function submitViaApi(request: import("@playwright/test").APIRequestContext, itemCode: string) {
  return request.post(`${API}/attempts`, {
    data: {
      client_attempt_id: crypto.randomUUID(),
      child_id: 1,
      item_code: itemCode,
      answer: 1,
      hints_used: 0,
      telemetry: { response_time_ms: 5000, active_time_ms: 3000, idle_time_ms: 500 },
    },
  });
}
