# 数学世界 —— 开发用命令
#
# Python 已删除（迁移 S6），全部走 Next.js 全栈（TypeScript）。
# 等价 npm scripts 见 package.json。

.PHONY: help dev build test simulate db-migrate

help:
	@echo "  make dev          起 Next dev server（http://localhost:3000）"
	@echo "  make build        内容构建 + next build（生产构建）"
	@echo "  make test         vitest 全量回归（对拍 fixture 是唯一基准）"
	@echo "  make simulate     TS 模拟器（7 画像 × 30 天体检）"
	@echo "  make db-migrate   内容 dump → 本地 PG 导入（可重复执行）"

dev:
	npm run dev

build:
	npm run build

test:
	npm test

simulate:
	npx tsx scripts/simulate.ts

db-migrate:
	npm run db:import
