# SpecLang 规格骨架（抄走改值；本文件不是产物，别再原样提交）
#
# 必填与可选取舍以 vendor 原件为准：references/vendor/speclang/speclang-waterfall/assets/MECHANICAL_RULES.md
# 校验：node scripts/speclang-validate.mjs --ruby="<ruby 绝对路径>" <本文件>
# 通过判据：exit 0 且 stdout 含 `SUMMARY: 0 failures, 0 warnings. [PROCEED`
version: 0.5

feature_context:
  feature_id: FEATURE-<模块>-<序号>          # 全局唯一；与本项目需求编号族对齐
  source_event_ids: [<上游事件/需求 id>]      # 追得到出处，别留空数组
  feature_goal: "<一句话说清这次要交付什么，以及怎样算完成>"
  success_signals:                            # 每条都要可判（有读数/有 exit code），禁写「体验更好」
    - "<可判的成功信号 1>"
    - "<可判的成功信号 2>"
  out_of_scope:                               # 显式写出不做什么，防止范围漂移
    - "<本批不做的项及原因>"

system_architecture:
  subsystems:
    - subsystem_id: SUBSYS-<名>
      responsibility: "<该子系统唯一负责什么>"
      owned_modules: [<模块名>]                # 与 owned_code_artifacts 对应，禁交叉归属
      exported: [<对外导出的模块名>]
      dependencies: []                        # 只写真正依赖的 subsystem_id；成环即红
      owned_code_artifacts:                   # 路径相对仓根，逐条真实存在
        - "<path/to/file>"

contracts:
  - contract_id: CONTRACT-<名>-<序号>          # 唯一
    subsystem: SUBSYS-<名>                    # 必须已声明
    pre_condition: "<前置条件；无则写 none>"
    post_condition: "<可判定的后置条件——校验器只核结构，语义由 hoare-check 复核>"
    traces: [<测试/证据锚点 id>]               # 每条 active 契约至少要有一个去处，否则红

traces:                                       # 契约的去处（测试用例 / 证据文件 / 命令）
  - trace_id: <测试或证据 id>
    kind: test|doc|command
    location: "<path 或命令>"
    status: active|planned                   # planned 不计通过
