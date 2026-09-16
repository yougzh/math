"""内容工作台命令行工具。

    python3 -m tools.content_cli <command>
    ./math-content <command>

    validate  内容错误，退出码非 0 —— 绝不能入库
    lint      内容可疑，退出码始终 0 —— 需要人过目
    stats     覆盖度报表（哪个能力缺哪种脚手架，一眼看见）
    preview   看某道题 / 某个故事的真实内容
    generate  用模板批量生成候选题
    dump      导出规范化 JSON，供 P2 数据库导入使用
    schema    导出 YAML 的 JSON Schema
"""
