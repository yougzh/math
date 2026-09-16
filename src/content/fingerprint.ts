/**
 * 输入指纹 —— 把"内容/配置有没有变过"变成一个可比较的字符串。
 *
 * ⚠️ 与 loader.ts 一样是**构建期专用**（用了 `node:fs`）。
 *
 * 为什么需要它
 * ------------
 * `src/generated/` 是 gitignore 的构建产物。于是存在一种**静默**失败：
 * 改了 content/*.yaml 但忘了重新构建 —— 对拍测试会拿旧产物去比旧 fixture，
 * 两边一致、全绿，而应用跑的是过期内容。这类 bug 不会有人发现，直到线上
 * 出了"我明明改了内容怎么没生效"的怪事。
 *
 * 有了指纹，这种状态就是一个响亮的报错。注意对拍测试**不能**改成
 * "先自动重新构建再比" —— 那会让它永远比的是新产物，产物过期这件事
 * 就再也测不出来了。
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import path from "node:path";

/** 参与指纹的输入目录（相对 root） */
const INPUT_DIRS = ["content", "config"] as const;

/**
 * 递归收集目录下所有文件，返回相对 `root` 的 POSIX 路径。
 *
 * 刻意不按扩展名过滤：多算一个文件只会造成一次"误报过期"，
 * 少算一个文件会造成一次"漏报变更" —— 两个方向的风险不对等。
 * 编辑器留下的 .swp / .DS_Store 会让指纹变化，那是可接受的假警报。
 */
function collectFiles(root: string, directory: string): string[] {
  const out: string[] = [];
  const walk = (relative: string): void => {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(path.join(root, relative), {
        withFileTypes: true,
        encoding: "utf-8",
      });
    } catch {
      return; // 目录不存在 = 没有输入，交给调用方判断是否合理
    }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  walk(directory);
  return out;
}

/**
 * 内容 + 配置的输入指纹。
 *
 * 输入 = `content/` 与 `config/` 下所有文件的**相对路径 + 字节内容**。
 * 路径参与哈希，所以"把内容从 A 文件挪到 B 文件"也算变化（确实算，它可能
 * 改变加载顺序 → 改变 load_order）。绝对路径不参与，换台机器结果相同。
 *
 * `root` 显式传入而不是用 process.cwd()：调用方（构建脚本 / 测试）可能是
 * 从不同目录被拉起来的，靠 cwd 会让指纹时对时错。
 */
export function sourceFingerprint(root: string): string {
  const files = INPUT_DIRS.flatMap((dir) => collectFiles(root, dir)).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    // 分隔符用 \0 —— 文件名里不可能出现，避免 "a" + "bc" 与 "ab" + "c" 撞哈希
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(path.join(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
