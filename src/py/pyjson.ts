/**
 * `json.dumps` 的最小移植 —— 只实现本项目用到的面。
 *
 * 当前唯一消费者是 `replay.ts` 的 `states_equal`：把 `_state_fingerprint`
 * 序列化成字符串再比较。这里刻意**只做同侧比较的支撑**：
 *
 *   - `states_equal` 的两个入参都是 TS 状态，序列化只需要「确定性 + 同构」，
 *     不需要与 Python 的 `json.dumps` 输出逐字节一致 —— 对拍 fixture 里
 *     `states_equal` 只出现布尔结果，字符串本身不过 fixture。
 *   - 因此数字直接走 JS 的 `String(number)`：Python 的 `1`（int）与 `1.0`
 *     （float）在 JSON 里是 "1" 与 "1.0"，但 TS 的 number 不区分两者，
 *     `to_dict()` 里同一个字段没有信息可以判断该输出哪种形状。硬按字段名
 *     猜是坏味道 —— 等真有「fingerprint 字符串进跨语言对拍」的需求时，
 *     再回来把 float 的 `.0` 规则补进来（到时对拍会逼出所有分歧）。
 *
 * 键序：`sortKeys` 对应 `sort_keys=True`；不给时按插入序（Python 3.7+ 的
 * dict 语义，Map 同构）。字符串转义默认 `ensure_ascii=True`（非 ASCII 转
 * \uXXXX，Python 的默认值）—— 指纹里目前只有 ASCII 的 code，但默认值
 * 照抄 Python，避免"换个调用点就变形状"。
 */

export interface PyDumpsOptions {
  sortKeys?: boolean;
  ensureAscii?: boolean;
}

/** Python `json.dumps` 的字符串转义（ensure_ascii=True 的默认面） */
function pyEncodeString(value: string, ensureAscii: boolean): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      default: {
        const code = ch.codePointAt(0)!;
        if (ch < " " || (ensureAscii && code > 0x7e)) {
          // 与 Python 一致：BMP 内用 4 位 \u，代理对（>0xFFFF）用一对 \u
          if (code > 0xffff) {
            out += pyEncodeCodePoint(code);
          } else {
            out += `\\u${code.toString(16).padStart(4, "0")}`;
          }
        } else {
          out += ch;
        }
      }
    }
  }
  return `${out}"`;
}

function pyEncodeCodePoint(code: number): string {
  // 代理对拆成两个 \uXXXX（Python 的 ensure_ascii 就是这么干的）
  const high = Math.floor((code - 0x10000) / 0x400) + 0xd800;
  const low = ((code - 0x10000) % 0x400) + 0xdc00;
  return `\\u${high.toString(16).padStart(4, "0")}\\u${low.toString(16).padStart(4, "0")}`;
}

function pyEncodeValue(value: unknown, options: Required<PyDumpsOptions>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return pyEncodeString(value, options.ensureAscii);
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      // NaN / Infinity 在 Python json 里输出 NaN/Infinity（非法 JSON 但能算），
      // 本项目 fingerprint 不含它们 —— 撞上就直接炸，别静默出个假字符串
      if (!Number.isFinite(value)) {
        throw new Error(`pyDumps 不支持非有限数字：${value}`);
      }
      return String(value);
    }
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => pyEncodeValue(item, options)).join(", ")}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      if (options.sortKeys) {
        entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      }
      const body = entries
        .map(([key, val]) => `${pyEncodeString(key, options.ensureAscii)}: ${pyEncodeValue(val, options)}`)
        .join(", ");
      return `{${body}}`;
    }
    default:
      throw new Error(`pyDumps 不支持的类型：${typeof value}`);
  }
}

export function pyDumps(value: unknown, options: PyDumpsOptions = {}): string {
  const full: Required<PyDumpsOptions> = {
    sortKeys: options.sortKeys ?? false,
    ensureAscii: options.ensureAscii ?? true,
  };
  return pyEncodeValue(value, full);
}
