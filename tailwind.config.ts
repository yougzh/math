import type { Config } from "tailwindcss";

/**
 * 儿童端设计基线：
 * - 字号偏大（正文 18px 起，题面 24px+）
 * - 可点区域 ≥ 44×44，主按钮 ≥ 56px 高
 * - 圆角大、对比高、无明显闪烁
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        sky: {
          50: "#f0f9ff",
          100: "#e0f2fe",
          200: "#bae6fd",
        },
        world: {
          bg: "#fdf8ef",
          ink: "#2f2a24",
          soft: "#6b6155",
          card: "#ffffff",
          sun: "#ffce54",
          grass: "#7ecb6f",
          sea: "#5aa9e6",
          berry: "#e8788a",
          wood: "#c98f5a",
          gold: "#f2b73a",
          gem: "#8f7fe8",
          seed: "#7ecb6f",
        },
      },
      fontSize: {
        kid: ["1.125rem", { lineHeight: "1.7rem" }],
        "kid-lg": ["1.375rem", { lineHeight: "2rem" }],
        "kid-xl": ["1.75rem", { lineHeight: "2.25rem" }],
        "kid-2xl": ["2.25rem", { lineHeight: "2.75rem" }],
      },
      borderRadius: {
        kid: "1.5rem",
        pill: "999px",
      },
      boxShadow: {
        kid: "0 6px 0 rgba(0,0,0,0.10)",
        "kid-sm": "0 3px 0 rgba(0,0,0,0.10)",
        soft: "0 10px 30px rgba(47,42,36,0.08)",
      },
      keyframes: {
        floaty: {
          "0%,100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-6px)" },
        },
        popin: {
          "0%": { transform: "scale(0.85)", opacity: "0" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        drift: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
      },
      animation: {
        floaty: "floaty 3s ease-in-out infinite",
        popin: "popin 0.25s ease-out both",
        drift: "drift 18s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
