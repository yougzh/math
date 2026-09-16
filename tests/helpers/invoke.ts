/**
 * 执行 fixture 里的**调用表达式**：`name`（属性）或 `name[arg,arg]`（方法）。
 *
 * 为什么用表达式而不是"每个方法各写一条断言"：参数由 Python 侧序列化成
 * JSON 字面量存进 fixture，这里原样解析再调用 —— 两侧用的**是同一组参数**。
 * 手写两遍参数时最容易出的错（"我以为你测的是 (0.5,1,5)"）在这套结构下不可能发生。
 *
 * ⚠️ 映射漏了必须**报错**，不能静默返回 undefined —— 那会让整个 fixture
 * 条目退化成"永远通过"。所以下面两个 throw 是刻意的。
 */

/**
 * @param subject    被测对象（AlgorithmConfig / CompetencyGraph …）
 * @param methodNames Python 名 → 对象成员名。属性不需要列（两侧同名 snake_case）
 * @param expression `name` 或 `name[arg,arg]`，参数是 JSON 字面量
 */
export function invokeExpression(
  subject: object,
  methodNames: Readonly<Record<string, string>>,
  expression: string,
): unknown {
  const matched = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?$/.exec(expression);
  if (matched === null) {
    throw new Error(`无法解析的调用表达式：${expression}`);
  }
  const pythonName = matched[1]!;
  const argsText = matched[2];
  const members = subject as unknown as Record<string, unknown>;

  if (argsText === undefined) {
    return members[pythonName]; // 属性
  }
  const tsName = methodNames[pythonName];
  if (tsName === undefined) {
    throw new Error(
      `fixture 里有未映射的 Python 方法名「${pythonName}」—— ` +
        `把它补进映射表（否则这条 fixture 会被静默跳过）`,
    );
  }
  const target = members[tsName];
  if (typeof target !== "function") {
    throw new Error(`被测对象上没有方法 ${tsName}（映射自 ${pythonName}）`);
  }
  const args = argsText === "" ? [] : (JSON.parse(`[${argsText}]`) as unknown[]);
  return (target as (...rest: unknown[]) => unknown).apply(subject, args);
}

/** 取出表达式里用到的方法名（用于"映射表不留死键"的自检） */
export function methodsUsedIn(expressions: readonly string[]): Set<string> {
  const used = new Set<string>();
  for (const expression of expressions) {
    const name = /^([A-Za-z_][A-Za-z0-9_]*)\[/.exec(expression)?.[1];
    if (name !== undefined) used.add(name);
  }
  return used;
}
