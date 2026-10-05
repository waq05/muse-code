# TUI 视觉对齐 dsh-TUI 计划书（2026-10-06）

> 目标：把 msc 终端界面的**视觉与信息架构**对齐 dsh-TUI v0.13.0（用户实机截图为准），补齐后两边的「观感差」收敛到品牌差异。
> 证据：dsh 侧 = 用户两张实机截图 + 源码级规格取证（`theme.ts` / `LogoV2.tsx` / `Whale.tsx` / `splashFonts.ts` / `StatusLine.tsx` / `StatusMetrics.ts` / `markdown.ts` / `MarkdownTable.tsx` / `SubagentMessage.tsx` / `UserPromptMessage.tsx` / `AssistantThinkingMessage.tsx` / `Chat.tsx` pill / `PageMargin.tsx`）；msc 侧 = 0.6.57 实机截图三张（boot / 对话 / 滚动，隔离 HOME + 假端点驱动真 UI，走查脚本 `scripts/_tui-visual-run.mjs` 已就位可复跑）。
> 原则不变：不 fork dsh、不复制业务代码，只对齐设计规格；所有色值进 `theme.ts` 单一真源；恒定帧几何（0.6.55-57 的地基）不许回退。

## 一、差距矩阵（逐项， levels：P0=一眼就差 / P1=明显 / P2=打磨）

| # | 项 | dsh-TUI 现状 | msc 现状 | 级别 |
|---|---|---|---|---|
| 1 | **色板** | 「Gentle Mist Blue」真彩 hex 全套：正文 #E8E6E0 暖白、accent #7DA1DE 雾蓝、success #82B89D、error #DA8A93、warning #D8B270、permission #ABC2EC、dim #8D95A6；用户消息金 #FFDF80 | `theme.ts` 只有 16 色 ANSI 名（cyan/green/red/yellow）+ `dimColor` 两档亮度 | **P0** |
| 2 | **Markdown 渲染** | 完整子集：H1 bold 下划线 accent / H2 bold #ABC2EC（截图蓝标题）/ 粗体 / 斜体 / 行内代码 #ABC2EC / OSC8 链接 / 列表符号染蓝 / 表格 `┌─┬┐` 边框+表头加粗居中 / 引用 `▎` | **裸文本**：`## 结论`、`**粗体**`、`\|表格\|`、`[链接](url)` 全按字面上屏（实机截图实锤，最大单项差距） | **P0** |
| 3 | **启动欢迎块** | 鲸鱼像素画（40×13）+ 「DEEPSEEK HARNESS」5 行点阵大字（8 款字体按日期轮换+渐变扫光）+ `✦ dsh-TUI vX` 词标 + model/cwd/tips 三行 + tagline，约 30 行品牌块，随内容滚走；<97 列阶梯降级 | `◆ Muse Code vX` + 两行暗淡提示，共 4 行 | **P0** |
| 4 | **用户消息行** | `❯ ` + 金色 #FFDF80 **bold**，续行悬挂缩进 2 列 | `❯ ` + 默认白色正文，无缩进规则 | **P0** |
| 5 | **状态栏 context 条** | 第 1 行：全宽分段进度条（按 system/prompt/assistant/thinking/tools 分段着色 + 空闲段读数 `10k/1.0M 1.0%`，≥80% 琥珀 ≥95% 红） | 无。tok 只有第 2 行的 `9.9k↑ 512↓ 缓存98%` | **P0** |
| 6 | **思考行** | `⚓ 思考（ctrl+o 展开）` 整行斜体+暗淡，≥1s 显示 `· 1s`；流式时盲文 spinner 蓝色脉动 | `💭 思考中（ctrl+t 展开）` 不斜体、**无时长**（core 条目缺 reasoning 时长）、无 spinner | **P1** |
| 7 | **助手正文** | `• ` 圆点占 2 列 + markdown 正文 | 无前缀直排 | **P1** |
| 8 | **回到底部条** | `↓ 回到底部（Enter/End）` **蓝底 #5E88CC 深字 #22262E bold** 的 pill，Enter/End 快捷键 | `⇡ 已回看历史，下方有 N 条新内容 · 点击本行或 PgDn 回到底部` 描边暗条（实机截图对比强烈），无 Enter/End | **P1** |
| 9 | **块间距与页边距** | PageMargin 默认左右各 2 列、上下各 1 行；渲染块之间 1 空行 | 0 边距，条目贴排（GAP.none），整屏文字顶着边框 | **P1** |
| 10 | **输入框** | 左侧 `⌸ ` 会话列表按钮（点击开 picker，hover 提亮）+ `❯`（工作中变暗）；顶/底自绘边框，静止 #55606F | 无左按钮；整框 round 边框（gray/accent） | **P1** |
| 11 | **子代理内联卡** | 转录内嵌卡：状态点+bold「子代理：描述」+model·耗时·tok·tools·状态词，下方当前工具行 + 最新 3 行输出瀑布（dim、`│` 引导） | 无内联卡（subagent 工具走通用 ToolCard；/agents 浮层 0.6.57 已有） | **P1** |
| 12 | 状态行字段 | 左：model·tps·后台·effort·mode·cache·tokens·≈¥cost(峰/谷)；右：git 分支·cwd·标题·#会话id | 已有：状态词·模式·权限·model·effort·tok；cwd·会话·后台芯片 | P2 |
| 13 | 思考展开键位 | ctrl+o（dsh 的回看走别的键） | ctrl+t（ctrl+o 已被回看全文占用） | P2（保留 msc 键位，只统一文案） |
| 14 | spinner/耗时/峰谷费用 | 有 | 无（费用需计价表，数据源缺失） | P2（成本项缓做） |

结论：**骨架（恒定帧/视口/浮层/鼠标）已对齐，差距集中在「皮肤」——色板、markdown、品牌块、密度**。P0 三项做完观感差距消掉约七成。

## 二、分批实施

### 批次一（0.6.58）— P0 皮肤骨架
1. **theme.ts 真彩化**：整套令牌对齐 dsh 语义并落 msc 语义名——`TEXT.body`→#E8E6E0、新增 `ACCENT`=#7DA1DE、`STATUS_COLOR` 换 #7FAE99/#DA8A93/#D8B270 系、新增 `USER_PROMPT`=#FFDF80、`PERMISSION`=#ABC2EC、`PILL_BG`=#5E88CC / `PILL_TEXT`=#22262E、`BORDER.frame`=#55606F。保留 16 色回退注记（ink `dimColor` 在 256 色终端自动降级，WT/VSCode/iTerm2 均真彩）。
2. **Markdown 子集渲染器**（新 `src/app/markdown.ts`，纯函数 `parse(markdown) → MarkdownBlock[]` + `<MarkdownView>` 组件）：标题（H1 accent bold+underline / H2 #ABC2EC bold / H3+ bold）、**粗体**、*斜体*、`行内代码`、无序/有序列表（符号染 #ABC2EC、缩进）、表格（`┌─┬┐` 边框、表头 bold 居中、列宽 largest-remainder、超宽降级 label: value）、引用 `▎`、代码块（2 空格缩进+围栏行暗淡）、链接（OSC 8，退化蓝字下划线）。挂到 `ChatView` 的 `text` 条目与 `TranscriptOverlay`；结果 memo 化（同一 entry 不重复解析）。**不追求完整 CommonMark**——模型常用子集优先。
3. **用户消息行**：`❯ ` 染 #FFDF80 bold，正文续行悬挂 2 列。
4. **欢迎块升级**（保持「随内容滚走、≥30 条不画」）：新增点阵大字 `MUSE CODE`（5 行块字，参照 dsh splashFonts 的字形表，双词两行+渐变着色可选）+ `✦ Muse Code vX` 词标 + model/cwd/tips 行 + 一行 tagline；按列数阶梯降级（≥97 全块 / ≥56 纯大字 / 其余现一行式）。不做鲸鱼（品牌不同），用 Muse 自己的像素标记（音符/菱形，1 张小画 ≤9 行）。
5. 测试：markdown 解析器单测 + 现有电池几何断言更新（间距/行数变化）+ 假端点实机截图对照（走查脚本回包就是富 markdown，天然是验收用例）。

### 批次二（0.6.59）— P1 状态栏与交互密度
1. **context 进度条**（StatusBar 第 1 行，全宽）：v1 用 `used/window` 单段着色 + 空闲段右侧读数 `10k/1.0M 1.0%`，≥80% #D8B270、≥95% #DA8A93；数据源 `status.usage.inputTokens+outputTokens` + 模型 `contextWindow`（`snapshot.status` 需透出 window——core 补一个字段）。dsh 的按内容类型五段着色列为 P2（需 core 按类型记账）。
2. **状态行重排**：左组 `model · effort · 缓存% · tok in→out · 模式 · 权限`，右组 `ctx % · cwd · 会话id`（space-between），后台芯片保留。
3. **回到底部 pill**：蓝底 #5E88CC + #22262E bold `↓ 回到底部（Enter/End）`，新增 Enter/End 键位（回看态优先级高于提交——仅在有 pill 时拦截）。
4. **块间距 + 页边距**：ChatView 条目间 `GAP.tight`(1)（markdown 块内部另计）、根帧 `paddingX=2`；同步更新 App 的 `statusbarLines`/picker 几何与全部测试断言。
5. **输入框 ⌸ 按钮**：`❯` 左侧加 `⌸ `（dim，点击=打开会话选择器，对齐 dsh home 按钮）；工作中 `❯` 变暗。
6. 思考行：`⚓` + 整行斜体 + （P2 时长）文案对齐；流式 spinner 盲文帧（蓝色脉动简化为 accent 恒色）。

### 批次三（0.6.60）— P2 打磨 ✅（2026-10-06 完成）
- **context 条按内容类型分段** ✅：loop 每次组装请求发 `context` 事件，`estimateRequestSegments` 现算五段（无增量抵账，压缩/滚出自动重置）；`StatusView.contextUsed` 换成最近请求的 prompt_tokens（权威占用，替代 0.6.59 的 usage 累计——那会把滚出窗口的内容也算进去）；StatusBar 移植 dsh `allocateBarColumns`（可见段保底 1 列 + largest-remainder），分段色取 dsh 蓝系谱提亮一档适配深底。
- **子代理内联 waterfall 卡** ✅：contract `kind:'subagent'` 条目 + subagent 插件活动转发（正文行攒瀑布、lastTool、token 累计；仅父会话被查看时投递）+ 转录层按名 upsert + 会话切回按名册种卡；跑动 = spinner 头行 + 当前工具行 + 恒 3 行 `│` 瀑布，收工折头行，失败留 `└` 错误行；点击开队友转录浮层。
- **thinking 时长** ✅：直播尾 thinking 段记 startedAt，message 定稿挂 `durationMs`（重放无此数据降级不显示）；≥1s 显示 `· Ns`。
- **cost 峰谷** ✅（数据源已解）：新 `core/pricing.ts`（DeepSeek 官方价目 + 北京时段峰谷，与 dsh deepseekPricing 同源）；usage 事件带 model 按笔归账、峰谷分桶；状态行 `≈¥x.xx 峰/谷` 仅在 DeepSeek 官方端点且模型收录时出现——不显示好过给错数字。
- H2 hover 提亮：维持「缓」（鼠标已是点击语义，悬浮态对终端点击流意义有限）。

## 三、风险与对策
- **恒定帧几何**：间距/边距/状态栏行数一变，picker 与鼠标命中的构造行号全要跟改——每批跑全电池（28+29 项）+ 假端点截图对照。
- **markdown 解析错排**：只做白名单子集，解析失败退回原文渲染（永远不比现在差）；CJK 显示宽度用 click.ts 的 `displayWidth` 同源计算，表格列宽才不会错位。
- **真彩色兼容**：ink 输出 SGR truecolor，NO_COLOR/老终端由 `dimColor` 与 ANSI 降级兜底；不做双主题（dsh 的 light/ansi 主题体系超出本轮范围，列为远期）。
- ** reconciliation 量**：markdown 解析结果按 entry id memo，回看浮层复用同一份。

## 四、顺手修（走查中实锤的基础设施缺口）
- **`DSC_HOME` 覆盖不完整**：`migrate.ts:21` 把 config/credentials 路径钉死 `homedir()/.dsc`，`path-policy.ts:20` 的 `DSC_HOME` 只管部分路径——同一份测试隔离有两套行为（走查第一轮因此读到了真实配置）。批一顺手：`DSC_CONFIG_YAML/DSC_CREDENTIALS/sessionRoot` 统一改走 `path-policy` 的 `DSC_HOME`。

## 五、验收口径
每个批次结束：`pnpm build` + 全测试电池 0 FAIL + 双包 typecheck + `node bin/dsc.js --version`；**实机走查**（`scripts/_tui-visual-run.mjs`：隔离 HOME + 假端点回富 markdown）截 boot/对话/滚动三态，与 dsh 实机截图并排核对色板、markdown、密度、pill。
