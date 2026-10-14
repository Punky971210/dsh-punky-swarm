# 包内资产与实装去向

> 本节自仓库根 `README.md` 移出（2026-10-10 README 精简），正文逐行原样保留。
> 原文位置：`README.md` 的 `## 包内资产与实装去向` 一节（原 :158–212，共 55 行）。

---

本插件随包携带**预设本体**（蟛蜞模式纪律与装配面）与**团队技能**（`software-team` / `design-team`）。装入 dsh 后，这些资产会被同步到你的用户目录，技能由此可被运行期加载。

### 包内路径 → 实装去向

| 包内路径 | 实装去向（用户目录） | 性质 |
|---|---|---|
| `presets/jiufeng/` | `~/.dsh/.agent-presets/jiufeng/` | 用户机实装面：随预设同步 |
| `presets/jiufeng/asset-manifest.json` | `~/.dsh/.agent-presets/jiufeng/asset-manifest.json` | 用户机实装面：资产清单本身，也是下表同步项的声明来源 |
| `skills/software-team/` | `~/.agents/skills/software-team/` | 用户机实装面：技能目录，供 `skill` 工具加载 |
| `skills/design-team/` | `~/.agents/skills/design-team/` | 同上 |
| `presets/hook-rules/` | **无用户机落点** | 包内原地读取面：随插件安装目录原地读取（启动时装载一次），**不复制到 `~/.dsh` 或 `~/.agents`**，故不会出现在你的用户目录里 |

### 触发时机

- **同步发生在插件启动/重载时**（dsh 载入本插件的 `apply` 阶段），每个进程执行一次；不是每次工具调用、也不提供任意时刻的手动触发命令。
- 因此：**运行中改了包内资产，需要重启 dsh 才生效**。
- **同步由包内清单 `presets/jiufeng/asset-manifest.json` 驱动**——清单声明「同步哪些包内路径、各自落到哪里」，而不是把路径写死在代码里；新增或调整资产改清单即可（清单的落点根只有两个枚举：`preset` = `~/.dsh/.agent-presets`、`skill` = `~/.agents/skills`，不能写绝对路径）。
- **清单缺失或损坏时不会静默不同步**：清单文件不存在、读取失败、JSON 非法或字段不合规时，机制**回落到内置默认三条**（上表前三行）并照常同步，同时在启动日志给出告警：`asset manifest 不可用（…），已回退内置默认资产表；用户机实装面可能与包内清单声明不一致`。也就是说，最坏情形下三份资产仍然会被装上，只是清单的声明性失效——你有日志可查、不是无声跳过。

### 资产清单（人读版 schema）

清单是包内 `presets/jiufeng/asset-manifest.json`，把「包内相对路径 → 落点根 → 目标子路径」写成 JSON。字段与出厂值：

```json
{
  "manifestVersion": 1,
  "description": "蟛蜞模式（jiufeng）资产清单：声明包内预设与团队技能到用户机实装面的单向同步（真源=包内 skills/，不反向同步）",
  "assets": [
    { "rel": "presets/jiufeng", "note": "蟛蜞模式预设本体", "target": { "root": "preset", "subpath": "jiufeng" } },
    { "rel": "skills/software-team", "note": "软件工程团队技能（真源）", "target": { "root": "skill", "subpath": "software-team" } },
    { "rel": "skills/design-team", "note": "设计团队技能（真源）", "target": { "root": "skill", "subpath": "design-team" } }
  ]
}
```

| 字段 | 含义与约束 |
|---|---|
| `manifestVersion` | 清单 schema 版本，当前为 `1` |
| `description` | 一句话说明（单行） |
| `assets[].rel` | 包内相对路径（`/` 分隔，不得含 `..`、`\`、`:` 或前导 `/`） |
| `assets[].note` | 该条用途（人类可读，可选） |
| `assets[].target.root` | 落点根类型，仅 `preset` / `skill` 两值 |
| `assets[].target.subpath` | 落点根内的目标子路径（路径规则同 `rel`） |

**真源方向是单向的**：包内 `skills/` 是唯一真源，同步方向为 包内 → 用户机；你在 `~/.agents/skills/` 下的改动**不会**回流到包内。

### 幂等与注意

- **幂等**：目标内容与包内一致时跳过（不重复写），不一致时整体覆盖重写。
- **会做**：**活目标根内多余文件会被覆盖清除**（例如包内已无 `stale.md`，同步后目标根里的 `stale.md` 也会消失）。
- **不会做**：**旧目标根目录不被删除**。资产改名或移除后，条目的旧目标根不再有同步动作，`syncDir` 无 job 即无动作，**旧目录会残留在用户目录**（历史上技能由 `jiufeng-team` 更名为 `software-team` 时，旧目录即留存下来）。
- **清理须手工**：技能更名后旧目录应手工删除，否则两个名字的技能并存，技能目录加载与装配断言可能双命中；同理，**清单中移除某条 = 只停止同步，不会清理用户机上已有副本**，清理同样须手工。
- 自举条（清单文件本体）每次同步都会重拷一份到用户目录，以保证那里的清单副本恒不旧于本次实际执行的声明；**目录类资产才走内容一致判定，文件类资产（如自举条）每次整拷**。
