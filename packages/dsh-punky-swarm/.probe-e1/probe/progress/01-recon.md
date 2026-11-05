# 进度 01 · 只读侦察

- `batch_status probe-e1` → phase=planning, settled=false, SMOKE(产物契约类门豁免), handoffGate=entry:on/settle:on。
- `gate_status lane=probe` → 1 lane；`task_pool` → pooled=0 / dispatched=1 / 可派发=0。
- `handoff_view lane=probe` → READY，edges=0（无入边）；批内仅 1 lane、无 audit 层 ⇒ 无出边、无交接义务。
- 结论：无阻塞，可直接落产物。
