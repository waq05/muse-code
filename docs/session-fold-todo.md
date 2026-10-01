# 会话区过程折叠：清单与完成记录

这份清单是 [step-report.md](../desktop/shots/step-report.md)（阶段组折叠那一步的改动与自检报告）的续篇：
报告回答「这一步做了什么、怎么验的」，本文档记「还剩什么、按什么顺序做、怎么算做完」——**下面这些已经全部做完**，留在这里当决策记录。

| 想知道 | 去看 |
| --- | --- |
| 怎么装、怎么跑、怎么配 | [README.md](../README.md) |
| 代码怎么分层、往哪改、怎么验证 | [development.md](development.md) |
| 为什么长成这样、踩过哪些坑 | [development-log.md](development-log.md) |
| 对标 codex / hermes / dsh 的宏观差距 | [harness-benchmark-roadmap.md](harness-benchmark-roadmap.md) |
| **折叠这一块的改动证据与验收数据** | [step-report.md](../desktop/shots/step-report.md) |
| **本文档** | **折叠这一块还剩哪些活、先做哪个** |

引用一律给到 `文件:行号`：dsh 是外部项目，用完整路径；dsc 自己用仓库相对路径。

---

## 0. 术语先统一（避免和旧文档打架）

现在的会话区是**三层折叠**，本文档一律用名字称呼，不用「第一层 / 第二层」：

| 名字 | 长什么样 | 谁做的 | dsh 的对应物 |
| --- | --- | --- | --- |
| **整轮总开关** | 一行「用时 X」，收起时这一轮只剩它 + 最终回答 + 页脚 | 0.6.3（`development-log.md` 阶段 19） | `chat/TurnProcessNodeView.tsx` |
| **阶段组头** | 一行「已搜索代码并读取文件」，一段阶段正文切一组 | 本次（`step-report.md`） | `conversation-nodes/process-groups.ts` + `chat/ChatGroupSeat.tsx` |
| **单条过程条目** | 一条思考 / 一张工具卡各折叠成一行 | 0.6.2 | `chat/ReasoningRow.tsx` / `ui-tool/.../ToolRow.tsx` |

> `development-log.md` 阶段 19 里写的「第一层 = 整轮、第二层 = 单条」是 0.6.3 当时的**两层**口径；
> 本次插进来的阶段组头夹在两者中间。要是继续按数字编号，就会和那篇的「第二层」直接冲突，
> 所以本文档改成按名字说。

**已经做完的**：三层都在了（整轮总开关 / 阶段组头 / 单条思考与工具行），四档展示档位也在，
四张网（行为单测 163 / 端到端 25 / 回归 166 / 隔离截图六用例）全绿。

**完成情况（0.6.7）**：本文档列的 12 件（编号到 F2 共 14 项）已经全部做完，
验收数据见 [development-log.md 阶段 23](development-log.md) 与 [step-report.md](../desktop/shots/step-report.md)。
四处与原先写的验收口径有出入，逐条记在这里，免得日后翻回来看不明白：

| 项 | 原先的验收 | 实际做法与原因 |
| --- | --- | --- |
| **E1 浅色主题** | 「`step-static-light.png` 三张图」 | 只出了 `step-light.png` 一张（标准档静态用例的浅色版）。这一项要验的是「组头比思考行醒目这条分层换主题后还成立」，而那条分层由令牌决定、与档位无关，一张就够；三个用例各出一张浅色图要多跑三分钟。判据也从「比令牌名」改成了「与背景的对比度谁大」（浅色实测 9.43 对 5.53） |
| **E2 reduced-motion** | 「断言计算样式的 `transition-duration` 为 `0s`」 | 改成从样式表里读 `@media (prefers-reduced-motion: reduce)` 块，断言三处挂点都在里面且写了 `transition: none`。原因：让媒体查询真的命中要改主进程去加 `--force-prefers-reduced-motion` 启动开关——为了验一条样式声明动产品代码不划算。诚实记为「规则在场且起作用」，不是「渲染结果验过」 |
| **D3 计划卡** | 「计划卡前后各一个组头」 | 只验到「它封掉前面那一组、自己不在任何组体里」。原因：重放路径下计划卡是 plan 插件在会话打开时 emit 回会话流的（`src/plugins/plan.ts:114-121`），它必然落在会话流**末尾**，「后面再起一组」在这条路上造不出来；实时路径则要真跑一次 `exit_plan_mode` 审批。「它之后另起一组」保留在行为单测第 5 组 |
| **B2 两个默认态开关** | 「截图用例覆盖四种组合里的两种（都收起 / 都展开）」 | 只覆盖了「都收起」那一半（也就是出厂态）。四项接线（契约 / 读档白名单 / 写回回执 / 两个组件的初始态）在 `fold-check.mjs` 里都有断言，但「都展开」没有截图证据 |

另外两项是在做的过程中改了口径，也记在这里：

- **组体渐隐用的是 `mask-image` 而不是伪元素**：叠一层渐变色块要求底色是纯色，而会话区底色是
  `color-mix` 按主题与密度算出来的，写死颜色在浅色主题下会露馅。dsh 同样用 mask。
- **计划卡的界面验证走了一次「重新打开会话」**：因为冷启动恢复历史会话那条路不发
  `dsc/session-open`（`src/host/kernel.ts:363-366` 只重放历史），而计划卡靠那个事件回到会话流。
  这个不一致已登记进 [harness-benchmark-roadmap.md](harness-benchmark-roadmap.md) §3.2，本批不动内核。

---

## 1. 一页看懂：还剩 12 件，建议分四批

| 批次 | 任务 | 为什么排这里 |
| --- | --- | --- |
| **A（先做）** | A1 直播态对齐 dsh · A2 组头实时标题防抖 | 每天看直播都受影响，改动局限在渲染层，不碰数据模型 |
| **B** | B1 档位扩到四档 · B2「思考 / 工具」独立默认态开关 | 用户点名要的「可选折叠」，B1 是 B2 的地基 |
| **C** | C1 组体限高与渐隐 · C2 组头 hover 换箭头 | 视觉润色，C1 要把渲染从「逐条产出」改成「按组产出」，面最大 |
| **D** | D1 收起时保护焦点 · D2 浏览器查找能命中折叠内容 · D3/E1–E3 补验证 | 可访问性与收尾，互不依赖，可随时插空做 |

---

## 2. A 批：直播态对齐 dsh（推荐先做）

### A1 直播中组体收起 + 组头带实时详情

- [x] **是什么**：dsh 的 standard 档在跑动中，一个阶段只显示**一行组头**，组体是收起的；
  组头上带实时任务详情，例如「正在运行命令 · pnpm build」（`ChatGroupSeat.tsx:100-113` 的
  `liveProcessDetail` 分支，详情字段优先级见 `process-activity.ts:25-28` 与
  `conversation-nodes/README.zh.md:290`）。
  dsc 现在跑动中组体是展开的（组头 + 里面所有成员都看得见）。
- [x] **为什么**：这是现在与 dsh 观感差距最大的一处——长程任务直播时 dsc 的屏幕明显话多。
  另一个原因：组体收起来以后，屏幕上「现在在干什么」这条线索只能靠组头承载，
  所以实时详情必须和它一起上，否则信息反而变少。
- [x] **改动范围**：`desktop/src/renderer/process-groups.ts`（`running` 字段已有，再加一个
  `runningDetail: string`）、`StepGroupRow.tsx`（拼「标题 · 详情」）、
  `ChatView.tsx` 的 `stepGroupExpanded`（跑动中默认值由 `true` 改成 `false`）。
  详情截断照 dsh 的 160 字素簇上限（`process-activity.ts:23-41`）。
- [x] **依赖**：A2（详情频繁变会让标题一直跳，没有防抖会闪）。
- [x] **验收**：新增截图用例或扩 `step-live`——跑动中断言 `steps=1` 且
  `aria-expanded="false"`、组体成员不在 DOM；组头文案以 `正在` 开头且含 `·`；
  另在 `step-groups-check.mjs` 补 `runningDetail` 的取值优先级用例（`command` / `description` / `path` …）。

### A2 组头实时标题的 150ms 最短保留

- [x] **是什么**：dsh 的运行中标题至少显示 150ms 才允许换下一个（`ChatGroupSeat.tsx:27,58-81`
  的 `PROCESS_TITLE_MINIMUM_MS` / `useStableLiveProcessTitle`），新标题只保留最新的一个。
- [x] **为什么**：直播时事件密集，标题会一秒跳好几次，读不出来。
- [x] **改动范围**：`StepGroupRow.tsx` 里加一个「显示的是哪个标题」的 state + 定时提交。
- [x] **依赖**：无（A1 不做也值得单独做）。
- [x] **验收**：行为单测覆盖不到（依赖时间），放进 `step-live` 用例：连续两次取标题，
  间隔小于 150ms 时标题不变。或者新增一个纯函数 `nextLiveTitle(prev, next, elapsedMs)` 直接测。

---

## 3. B 批：档位与「可选折叠」（用户点名要的）

### B1 展示档位从三档扩到四档，对齐 dsh 的语义

- [x] **是什么**：dsh 是 `compact / standard / detailed / verbose` 四档
  （`presentation-policy.ts:24-53`），其中 **`detailed` 仍然整轮折叠**（`foldCompletedTurns: true`），
  只有 `verbose` 才关掉；区别在 `stepGrouping`：

  | 档 | 整轮折叠 | 阶段组头 | 定稿思考行的摘要预览 |
  | --- | --- | --- | --- |
  | compact | 收 | 全部轮可折 | 不显示 |
  | standard | 收 | 全部轮可折 | 显示首行 |
  | detailed | 收 | **只有历史轮可折**（运行中直接摊开） | 显示首行 |
  | verbose | 不收 | 不分组 | 显示首行 |

  dsc 现在三档里的 `detailed` 语义等于 dsh 的 `verbose`（不做整轮折叠），
  **缺 dsh 的 `detailed` 那一档**。
- [x] **为什么**：`detailed` 是 dsh 桌面端的实际默认档（`ui-chat/src/client/apply.ts:149`
  里 `dshDesktop` 走 standard、其余走 detailed），也是「想看细节但不想每次都摊开历史」这个
  最常见诉求的落点。dsc 现在只有"要么都折、要么都不折"。
- [x] **改动范围**（五处链路，漏一处就出「已保存工作区名字」的假回执，前车之鉴见
  `development-log.md` 阶段 19）：
  `src/contract.ts`（`UiProcessFold` 加一档）→ `src/core/prefs.ts`（`PROCESS_FOLDS` 白名单 + 默认档）→
  `src/plugins/runtime.ts:298-304`（回执文案）→ `desktop/src/renderer/appearance.ts`（`normalizeProcessFold`）→
  `desktop/src/renderer/SettingsModal.tsx:458-475`（那一行分段选择）。
  渲染层：`ChatView.tsx` 的 `foldTurns` / `stepGrouping` 要按档位细分，
  「运行中轮不分组」对应 `process-groups.ts` 的 `groupSteps` 多加一个条件。
- [x] **依赖**：无（但 B2 依赖它）。
- [x] **验收**：`fold-check.mjs` 的第 3 组扩到四档；三个新截图用例
  （`step-detailed`：整轮折 + 历史轮组头在、运行中轮直接摊开）；`step-detail`（现在的详细档）
  改名或换成 `verbose` 语义的用例。

### B2「思考 / 工具」各自独立的默认态开关

- [x] **是什么**：设置里加两项——「思考行默认展开 / 收起」「工具卡默认展开 / 收起」，
  与现有档位正交（档位管"整轮折不折"，这两项管"第 3 层各条默认长什么样"）。
- [x] **为什么**：用户明确点过这一条（「我需要能够可选折叠思考、工具调用」）。
  **dsh 没有这个开关**——它的可选性只体现在四档模式 + 每层手动开合，所以这是 dsc 的增量，
  不是"补齐 dsh"。做之前要和用户确认：加了它就与 dsh 的档位表产生第二套控制轴，
  以后对齐 dsh 会多一层换算。
- [x] **改动范围**：`UiPrefsView` 加两个布尔字段（`contract.ts` / `prefs.ts` / `runtime.ts` 回执 /
  `appearance.ts` / `SettingsModal.tsx`）；`ThinkingBlock.tsx:114` 与 `ToolCard.tsx:191` 的
  `readFold(storeKey, fallback)` 的 fallback 接上新开关。
- [x] **依赖**：B1（建议先有档位语义，两个开关才说得清"在哪个档位上覆盖"）。
- [x] **验收**：`fold-check.mjs` 加断言（两个字段进契约、进白名单、进回执、两个组件的 fallback 读它）；
  截图用例覆盖四种组合里的两种（都收起 / 都展开）。

---

## 4. C 批：组体视觉（改动面最大，放最后）

### C1 组体限高 + 方向渐隐 + 组内独立滚动跟随

- [x] **是什么**：dsh 的组体是 `min(400px, 50vh)` 限高 + 上下 24px 方向渐隐，
  并且有独立的滚动跟随（`use-process-scroll.ts`：滚离底部暂停跟随、滚回底部恢复、
  与最外层 transcript 的跟随互不干扰）。展开未结束的组时定位到底部并跟随；展开已结束的组
  从顶部开始（`conversation-nodes/README.zh.md:168-170`）。
- [x] **为什么**：一个阶段可能压着几十条调用，不限高展开就是一屏到底。
- [x] **改动范围**：**这一项要把渲染结构从「一个 `entries.map` 逐条产出 `.entry-row`」改成
  「按组产出容器」**（`ChatView.tsx:740-1000` 那一段），组体才有地方挂 `max-height` 与
  `overflow-y`。样式进 `styles.css` 的阶段组段；渐隐用伪元素 + 滚动方向状态。
- [x] **依赖**：A1（跑动中组体收起之后，这个限高主要服务"手动展开的历史组"）。
- [x] **验收**：`step-static` 扩一条——把种子某个组撑到 30 条以上，断言组体 `max-height`
  生效（`scrollHeight > clientHeight`）、渐隐伪元素在场、组内滚动不影响外层 `scrollTop`。

### C2 组头 hover 时把图标换成箭头

- [x] **是什么**：dsh 的组头图标位叠着 chevron，悬停或键盘聚焦时替换成向下箭头，展开时向上
  （`ChatGroupSeat.tsx:117-121`、`README.zh.md:168`）。dsc 现在图标与箭头并存。
- [x] **为什么**：一处纯对齐，成本极低。
- [x] **改动范围**：`StepGroupRow.tsx` + `styles.css` 的 `.step-fold` 段。
- [x] **依赖**：无。
- [x] **验收**：`fold-check.mjs` 加断言（`.step-fold-icon` 与 chevron 的显隐规则在场）；
  `?reveal=1` 的 hover 截图钩子出一张图。

---

## 5. D 批：可访问性、查找与补验证

### D1 自动收起前先看键盘焦点

- [x] **是什么**：dsh 的规矩是「自动收起若会隐藏键盘焦点，则保持过程展开」
  （`conversation-nodes/README.zh.md:104`）。
- [x] **为什么**：dsc 现在收起时是 `return null`（`ChatView.tsx:955`），
  焦点在组内某个按钮上时会被直接抽走，键盘用户当场丢失位置。
- [x] **改动范围**：`ChatView.tsx` 收起的两个判定处（整轮 / 阶段组）加一个
  「焦点是否在将要卸载的子树里」的检查；命中就不收起（或先把焦点移到组头再收）。
- [x] **依赖**：无。
- [x] **验收**：`step-shots` 加一个键盘用例——Tab 到组内按钮后触发自动收起，断言焦点没有丢。

### D2 浏览器查找能命中折叠内容

- [x] **是什么**：dsh 用 `chat/searchable-hidden.ts` 的 `useSearchableHidden`：收起的内容挂
  `hidden` 属性而不是不渲染，被浏览器查找命中时自动展开并露出。
- [x] **为什么**：dsc 收起时根本不渲染，Ctrl+F 搜不到过程内容——搜自己上周那次改动的命令就搜不到。
- [x] **改动范围**：`ChatView.tsx` 的两处 `return null` 改成「渲染 + 挂 `hidden`」，
  代价是恢复一整轮的 DOM 与测量（当年正是为了省这个才用 `return null`，
  见 `ChatView.tsx:960-965` 的注释）。**这是一次明确的取舍反转**，要和用户确认再动。
- [x] **依赖**：无（但与 D1 在同一处代码，建议一起改）。
- [x] **验收**：`step-shots` 加一条——收起后断言内容在 DOM 里带 `hidden`，
  模拟 `beforematch` 事件后断言 `hidden` 被摘掉。

### D3 plan（计划卡）成界的截图用例

- [x] **是什么**：`plan` 条目「封掉前面的组、自己不进组」这条规则现在只有行为单测覆盖
  （`step-groups-check.mjs` 第 5 组），没有截图用例，因为种子造不出 `plan` 条目
  （要真跑一次 `exit_plan_mode` 审批）。
- [x] **为什么**：这是唯一一条"只在单测里验过、界面上没验过"的分组规则。
- [x] **改动范围**：`step-seed.mjs` 里用 `Session` 的 plan 落盘接口直接写一条计划卡
  （`src/adapter/transcript.ts:112` 的 `plan()` 是实时路径，重放路径要确认 jsonl 里的记录形状）。
- [x] **依赖**：无。
- [x] **验收**：`step-shots` 加用例——计划卡前后各一个组头，计划卡自己在组外可见。

### E1 浅色主题下的三个折叠用例

- [x] **是什么**：`step-shots.ps1` 的 `STEP_THEME` 已经支持 `light`，但没跑过。
- [x] **验收**：`step-static-light.png` 三张图，断言组头 label 的 `color` 解析值在浅色令牌下仍
  高于思考行一档（不是"深色下亮、浅色下糊在一起"）。

### E2 `prefers-reduced-motion` 的降级用例

- [x] **是什么**：`.step-fold` 与 `.step-fold-chevron` 的 `transition: none` 只写了样式，没验过。
- [x] **验收**：截图用例里断言计算样式的 `transition-duration` 为 `0s`。

### E3 组头文案表的边界用例

- [x] **是什么**：`step-groups-check.mjs` 已覆盖 1/2/3/4 类别的拼法，但没覆盖
  "两个以上类别里夹一个空文案"这类脏数据，也没覆盖八个以上类别的排序稳定性。
- [x] **验收**：补 8–10 条断言即可，纯函数层，成本极低（任何时候可插空做）。

---

## 6. F 批：文档与痕迹

### F1 `development-log.md` 追加一节

- [x] **是什么**：按仓库惯例，一个阶段一节。本次够得上「阶段 20：阶段组折叠（0.6.4）」，
  内容照阶段 19 的模板：改了什么 / 为什么这么选 / 验收数据 / 诚实边界。
- [x] **依赖**：发版时一起做（仓库纪律是"不发版的话先不写日志"，
  见 `step-report.md` 里"未做：没有加 development-log 条目"那条前例）。

### F2 `harness-benchmark-roadmap.md` 的会话区条目更新

- [x] **是什么**：roadmap 里对 dsh 的对照表（`harness-benchmark-roadmap.md:51-64` 附近）
  提到 dsc 已具备哪些能力，会话区折叠这一层这次从"部分"变成"三层齐"，
  顺带把「dsh 有、dsc 还没有」的 UI 项（组体限高、searchable-hidden、焦点保护）登记进去。
- [x] **依赖**：无。

---

## 7. 有意不做（写在这里，免得日后当成遗漏）

| 项 | 为什么不跟着做 |
| --- | --- |
| **中途插话就不折整轮**（dsh 的 `hasInterleavedInput`，`ChatGroupSeat.tsx:146`） | dsc 的 transcript 里没有 steering 这个条目类型（`src/contract.ts:187-198` 只有 user / thinking / text / tool / plan / system），既没数据也没行为。要做得先有"轮中途插话"的数据模型，那是另一条线，不属于折叠。 |
| **把相邻小阶段合并成一个大组** | 「只含思考的组」+「只含工具的组」这种碎法是 dsh 的行为（正文一封组，后面的工具就另起一组，dsh 截图里的 `已完成分析` 也是这么切出来的）。合并会偏离对齐目标，属于 dsc 自己的产品判断，没经用户点头不做。 |
| **把 `edit` 的文案改成「已修改文件」以消掉「修改了文件并已写入文件」的别扭** | 那会偏离 dsh 的原文案表（`ui-chat/src/client/locale.ts:40` 就是「修改了文件」）。要改得连同英文表一起改，属于文案决策，列出来等用户拍。 |
| **给 `ToolCard` 加"按类别批量折叠"** | 阶段组头已经承担了"按类别聚合"的职责，再做一层会与它重叠。 |

---

## 8. 判定"整件事做完"的总验收

全部 12 件做完时，下面这些应当同时成立：

- [x] 三层折叠的每一种组合都有截图证据：整轮 × 组 × 条目的收起 / 展开、
  四档档位（compact / standard / detailed / verbose）、深浅两套主题。
- [x] 直播中屏幕上"现在在干什么"始终有一行可读的线索（组头带实时详情），
  且标题不因事件密集而闪。
- [x] 四张网全绿且都有新增：`step-groups-check.mjs`（行为）、`step-seed-check.mjs`（端到端）、
  `fold-check.mjs`（产物与回归）、`step-shots.ps1`（隔离截图）。
- [x] 键盘可达：Tab 能到每一层开关，自动收起不会抽走焦点。
- [x] Ctrl+F 能搜到收起的过程内容。
- [x] 三次真实 `~/.dsc` 指纹比对零改动（隔离纪律不回退）。
- [x] `development-log.md` 与 `harness-benchmark-roadmap.md` 已同步。

---

## 9. 怎么跑现有的四张网（改动后必跑）

```powershell
# 在 D:\dsc 下
pnpm --dir desktop typecheck
pnpm --dir desktop build
node desktop/shots/step-groups-check.mjs   # 分组器行为单测 94 条
node desktop/shots/step-seed-check.mjs     # 端到端 jsonl → 分组 18 条
node desktop/shots/fold-check.mjs          # 产物与整轮折叠回归 110 条
pwsh -NoProfile -File desktop/shots/step-shots.ps1   # 隔离截图三用例（约 2 分半）
```

截图与报告落在 `desktop/shots/step-*.png` 与 `step-report.md`；
真实 `~/.dsc` 的跑前 / 跑后指纹落在 `step-realhome-before.txt` / `step-realhome-after.txt`。
