# 数学世界 —— 开发用命令
#
# P0 阶段：只跑学习引擎，不涉及前端 / 故事 / AI 教练
# P1 阶段：加上内容工作台（math-content）

.PHONY: help test demo simulate engine-check \
        content-validate content-lint content-stats content-schema content-dump content-generate content-check \
        content db-init db-reset api api-test

help:
	@echo "引擎"
	@echo "  make test               跑全部单元测试"
	@echo "  make demo               跑 P0 端到端演示（5 次 attempt 场景）"
	@echo "  make simulate           跑 7 个虚拟孩子 × 30 天模拟体检"
	@echo "  make engine-check       跑测试 + demo（P0 验收）"
	@echo ""
	@echo "内容工作台（等价于 ./math-content <command>）"
	@echo "  make content-validate   检查内容错误（有错退出码 1）"
	@echo "  make content-lint       检查可疑内容"
	@echo "  make content-stats      覆盖度报表"
	@echo "  make content-schema     导出 JSON Schema + 配置编辑器补全"
	@echo "  make content-generate   用模板批量生成候选题"
	@echo "  make content-dump       导出 JSON 供数据库导入"
	@echo "  make content-check      validate + lint + stats（P1 验收）"
	@echo "  make content            以上全部内容相关步骤"
	@echo ""
	@echo "后端 API + 数据库"
	@echo "  make db-init            内容 dump → 建库（build/math_world.db，可重复执行）"
	@echo "  make db-reset           删库重建"
	@echo "  make api                起服务 http://127.0.0.1:8000（--reload）"
	@echo "  make api-test           只跑 db + api 测试"

test:
	python3 -m pytest

demo:
	python3 -m tools.demo_p0

simulate:
	python3 -W ignore -m tools.simulate

engine-check: test demo

content-validate:
	python3 -m tools.content_cli validate

content-lint:
	python3 -m tools.content_cli lint

content-stats:
	python3 -m tools.content_cli stats

content-schema:
	python3 -m tools.content_cli schema

content-generate:
	python3 -m tools.content_cli generate

content-dump:
	python3 -m tools.content_cli dump

content-check: content-validate content-lint content-stats

content: content-schema content-check content-dump

db-init: content-dump
	python3 -m tools.init_db

db-reset:
	rm -f build/math_world.db
	python3 -m tools.init_db

api:
	python3 -m uvicorn backend.api.app:create_app --factory --reload --port 8000

api-test:
	python3 -m pytest tests/test_db.py tests/test_api.py
