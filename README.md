# 杀戮尖塔 2 控制（dsh-sts2）

给 DSH Agent 一组真的能打《杀戮尖塔 2》的工具：读战斗状态、出牌、选地图、拿奖励、处理事件和商店。走 [STS2 AI Agent](https://github.com/CharTyr/STS2-Agent) 的本地 HTTP API，不截屏、不猜像素；插件自动发现端口，并把所有动作锁在指定存档上。

这不是“自动战斗外挂”，而是一套给 Agent 用的手和眼睛：每一步仍然由模型根据 `sts2_brief` 的当前状态决定。

## 工具

| 工具 | 作用 |
| --- | --- |
| `sts2_launch` | 启动游戏并等待 mod API：优先 Steam（appid 2868840），失败再直接启动 exe；游戏已开就只等待 |
| `sts2_status` | mod 健康、游戏版本、当前屏幕、存档 profile、可用动作 |
| `sts2_state` | 完整状态（`screen` / `session` / `available_actions` / `combat` / `map` / `reward` / `event` / `shop` / `rest` …） |
| `sts2_brief` | 紧凑视图：屏幕、回合、可用动作、手牌、敌人意图/威胁、地图/奖励选项。连续打很多回合时用它，省上下文 |
| `sts2_act` | 执行一个动作：`play_card`、`end_turn`、`choose_map_node`、`claim_reward`、`choose_event_option`、`use_potion` 等 |
| `sts2_autofight` | 快速战斗：普通小怪自动打最多 N 回合（默认 8），能斩杀先斩杀、危险时格挡、安全时开形态/上易伤；遇到奖励/事件/换屏会停 |
| `sts2_runner_start` | 启动常驻后台 runner，直接循环处理战斗/奖励/地图/事件/休息/商店/宝箱/选牌 |
| `sts2_runner_status` | 看 runner 心跳：状态文件、当前屏幕/楼层/血量、最近日志 |
| `sts2_runner_stop` | 停止 runner（写 stop 标记并结束进程） |
| `sts2_guide` | 动作速查和基本策略；开始玩之前读一次 |

`sts2_act` 的 `params` 是动作参数对象，例如：

```json
{ "action": "play_card", "params": { "card_index": 2, "target_index": 0 } }
{ "action": "end_turn", "params": {} }
{ "action": "choose_map_node", "params": { "option_index": 1 } }
```

## 版本要求

| 游戏 | mod |
| --- | --- |
| v0.111.x（当前机器） | **STS2 AI Agent v0.18.0** |
| v0.113.0+（Dread & Blitz） | v0.19.x |

> v0.19.x 会引用游戏里的 `MegaCrit.Sts2.Core.Nodes.Screens.Blitz.NBlitzScreen`；v0.111.1 没有这个类型，`/state` 会 500。游戏没升级前不要升 mod。

## 游戏侧安装

1. 下载 `sts2-ai-agent-v0.18.0-windows.zip`。
2. 把压缩包 `mod/` 里的三个文件复制到游戏目录：

```text
E:\SteamLibrary\steamapps\common\Slay the Spire 2\mods\
  STS2AIAgent.dll
  STS2AIAgent.pck
  mod_id.json
```

3. 从 Steam 启动游戏。日志出现下面两行就成功了：

```text
[STS2AIAgent] Ready on http://127.0.0.1:8081/
--- RUNNING MODDED! --- Loaded 1 mods
```

端口被占用时会从 8080 往上顺延；插件会自动扫描 **8080–8090**，也可以用 `DSH_STS2_URL` 直接指定。

## 插件安装

### 本机目录（当前机器）

目录：`E:\smallDSH\伴侣\sts2-plugin`。在 DSH 插件管理器里启用 `dsh-sts2`，或：

```sh
dsh plugin --profile desktop add E:\smallDSH\伴侣\sts2-plugin
```

### 分发包

`dsh-sts2-0.1.0.zip` 解压后是一个完整插件目录。在 DSH 插件管理器里选“安装 bundle”指向该目录，或：

```sh
dsh plugin --profile desktop add <解压后的目录>
```

装完启用即可，工具会在下一个会话出现；不需要重启游戏。

## 启动游戏

```json
{ "wait_seconds": 120 }
```

`sts2_launch` 会：

1. 先看 `SlayTheSpire2.exe` 是否已经在跑；已经开着就只等 API；
2. 没开就用 `steam://rungameid/2868840` 从 Steam 启动；
3. Steam 没拉起来，再尝试直接启动 `E:\SteamLibrary\steamapps\common\Slay the Spire 2\SlayTheSpire2.exe`；
4. 每 2 秒探一次 mod `/health`，直到就绪或超时。

当前实测：Steam 启动到 mod API 就绪约 **9 秒**，返回 `screen: MAIN_MENU`。启动后仍需用 `sts2_status` / `sts2_act` 走进度，它不会自动开新局。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_STS2_PROFILE` | `2` | 期望的存档号；`sts2_act` 每次动作前检查，不匹配直接拒绝 |
| `DSH_STS2_URL` | 自动 | 例如 `http://127.0.0.1:8081`；不设时扫描 8080–8090 |
| `DSH_STS2_APPID` | `2868840` | Steam 启动用的 appid |
| `DSH_STS2_EXE` | 当前 Steam 库路径 | Steam 启动失败时直接启动的游戏 exe |

## 存档隔离（重要）

- 默认只操作 **profile2**；主存档 **profile1** 在 `E:\smallDSH\伴侣\backups\sts2-save-20261117` 有完整备份。
- 每个动作前都会读 `native_profile_id`；不是 2 就返回错误，不会写入。
- 换存档玩时用 `DSH_STS2_PROFILE` 明确指定，别直接改代码。
- `save_and_quit` 仍然存在，但不会自动调用。

## 快速战斗

普通小怪可以用 `sts2_autofight`，不用每张牌都问一次模型：

```json
{ "max_turns": 6, "stop_hp": 20 }
```

- `max_turns`：最多打几个玩家回合（1–20，默认 8）
- `stop_hp`：血量降到该值时停手，交回模型手动处理（默认 0，不设阈值）

它只做很朴素的启发式：能斩杀就斩杀，会被打死就先格挡，安全时开恶魔形态/燃烧/凶恶，再按伤害和能量出牌。**Boss、精英、血线很低或需要留药水的战斗建议手动**；它不会用药水，也不会读 Boss 特殊机制。

## 常驻 runner（推荐后台自动）

`sts2_runner_start` 会拉一个独立 Node 进程 `autoplay.mjs`，不经过模型回合，直接循环处理：

`COMBAT → REWARD → MAP → EVENT → REST → SHOP → CHEST → CARD_SELECTION`

失败会自动重开：`GAME_OVER → 主菜单 → 角色选择 → embark`，不会停在结算界面。每局会自己在可用角色里挑一个，并尽量不和上一局重复。默认**不限时**、最多玩 **4 局**（含启动时当前局）；只有玩满 4 局、连续报错 5 次或 `sts2_runner_stop` 才退出。

另有一个独立 `watchdog.mjs` 外置看门狗：runner 进程消失会自动重启；进程还活着但心跳超过 5 分钟会杀掉重启；每小时最多自动重启 6 次，`autoplay.stop` 会同时停掉它。

启动归属：只有 `sts2_launch` **真正把游戏启动起来**时才会自动拉起 runner；用户自己手动开的游戏不会被自动接管。`sts2_runner_start` 对用户手动启动的游戏默认拒绝，确实要接管时传 `force: true`；`sts2_runner_stop` 会清掉“由她启动”的状态。

游戏 mod 开关：插件平时会把 `mods/STS2AIAgent.dll`、`.pck`、`mod_id.json` 改名为 `.disabled`，所以你手动开游戏不会加载 mod；`sts2_launch` 真正启动前才恢复，游戏退出后再自动禁用。备份在插件的 `mod-backup/` 目录。代价是 mod 文件会被改名，且游戏没关时禁用不会即时卸载。

- 心跳：`autoplay-status.json`（含 `runs_started` / `max_runs`）
- 过程日志：`autoplay.log`
- 看门狗：`autoplay-watchdog.json` / `autoplay-watchdog.log`
- 停止：`sts2_runner_stop`，或写 `autoplay.stop`

**不要让 goal 和 runner 同时驱动同一局**：启动 runner 前先停掉/完成 goal，否则两边会抢动作。

```json
{ "run_id": "当前 run_id", "max_minutes": 0, "max_runs": 4 }
```

## 使用建议

1. 开局先 `sts2_status`，确认 mod、端口、存档。
2. 每回合先 `sts2_brief`，再 `sts2_act`，动作后再 `sts2_brief`；**不要复用上一回合的手牌下标**，手牌会重排。
3. 当前 `play_card` 失败（409 `invalid_action` / `invalid_target`）不会盲目重试，避免把同一 index 打到另一张牌上；重新读状态再决定。插件只对 `action_in_flight` 和 `end_turn` 的 `invalid_action` 做一次 800ms 重试。
4. 牌序/回合切换时状态可能晚半拍：返回 `pending` 或 `stable:false` 就等 0.5–1 秒再读，别连发。
5. mod 的 `instance_role=human`，不会自动打；不要开 mod 自带的自动游玩，否则会和外部动作抢。

## 常见错误

| 现象 | 原因 / 处理 |
| --- | --- |
| `404` / 找不到 API | mod 没加载，或端口不是 8081；看日志，或设 `DSH_STS2_URL` |
| `/state` 500 `NBlitzScreen` | mod 版本过新；v0.111.1 换回 v0.18.0 |
| `403` / profile 不匹配 | 当前存档不是 2；切换存档，或改 `DSH_STS2_PROFILE` |
| `409 invalid_target` | 下标过期（买牌、选牌、手牌重排）；重读状态 |
| `409 action_in_flight` | 上一个动作还没完；等它结束，不要连发 |
| 回合开始能量/手牌为空 | 状态还没稳定；等 1 秒重读 |

## 已知限制

- 只支持 Windows + 本地单机；mod 的 API 是社区实现，偶发 500/状态不同步。
- 版本强绑定：游戏升级后要换对应 mod，否则接口可能整体失效。
- 不做截屏/OCR；屏幕上的动画不进入状态，只有 mod 暴露的字段。
- 不保证 Agent 一定赢；`sts2_autofight` 只是启发式，血线很低时会为了抢伤害而不格挡。
- 一局里普通小怪自动、Boss/精英手动，是目前速度和稳定的折中。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 端口发现、HTTP 客户端、五个工具、状态压缩、存档检查 |
| `package.json` | 插件清单和 DSH bundle 声明 |
| `cordis.patch.yml` | 把 `dsh-sts2` 插进 profile |
| `locale/*.json` | 插件管理器里的标题与说明 |
| `icon.svg` | 插件图标 |
| `LICENSE` | MIT |

## License

MIT
