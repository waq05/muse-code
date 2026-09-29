# dsc 界面开发规范

面向**要动界面的人**。参考系是 hermes 桌面端（`D:\hermes\hermes-agent\apps\desktop\DESIGN.md`），
但那套 `--ui-*` 变量、Tabler 图标、nanostores 是 hermes 自己的实现；dsc 的落地是三份样式表加
一层原语，本文档讲的就是「hermes 的设计意图 → dsc 怎么写」。

| 想知道 | 去看 |
| --- | --- |
| 代码怎么分层、往哪改、怎么验证 | [development.md](development.md) |
| **界面长什么样、新控件往哪加** | **本文档** |
| 为什么长成这样、踩过哪些坑 | [development-log.md](development-log.md) |

改界面之前先读第 1 节和第 2 节；写完自查用第 13 节。终端界面（`src/app/`，ink）不在本文档范围。

## 1. 七条设计原则

hermes 的 `DESIGN.md` 开头有七条，逐条换成 dsc 的说法：

| # | 原则 | 在 dsc 里意味着什么 |
| --- | --- | --- |
| 1 | **扁平，不做盒子套盒子** | 面板里不要再套卡片，不要用分隔线切列表。用留白和一条发丝线分组。 |
| 2 | **浮层用无边框抬升** | 弹层 = `--dsc-bg-popover` + `--dsc-shadow-float` + 一条 `--dsc-stroke-float`，不画粗边框。 |
| 3 | **一个关注点一个原语** | 按钮只有 `.dsc-btn`，列表行只有 `.dsc-row`。新需求先想能不能用已有的，不能就扩它，别另起一个。 |
| 4 | **用令牌，不用字面量** | 颜色、圆角、字号、间距、层级、时长一律写 `var(--dsc-*)`。样式表里出现十六进制颜色就算 bug（例外见 §2.6）。 |
| 5 | **样式住在原语里** | 调用点给 `data-variant` / `data-size`，不许在调用点覆盖原语的 padding、圆角、颜色。 |
| 6 | **意图先于自动** | 后台有结果回来可以更新角标和缓存，但不许自己切页面、抢焦点、弹面板。 |
| 7 | **即时反馈** | 直接操作先改界面，落盘和网络后面对账；失败了要看得见地回滚。 |

第 1、4、5 条是这轮重构的主线：改之前 `styles.css` 里有 28 处写死的颜色、24 处圆角字面量、
6 处 z-index 字面量，现在分别是 6 处（故意留的）、6 处、0 处。

## 2. 令牌体系（`styles/tokens.css`）

全部令牌在这一份文件里，**深色写在 `:root`，浅色写在 `[data-theme='light']`，密度写在
`[data-density='compact'|'roomy']`**。样式表其余部分只引用，不定义。

### 2.1 颜色是怎么长出来的

不是一张写死的色表，是一条「中性底 + 种子色 + 混比」的链条：

```
--dsc-neutral-page/-side/-card   中性底色（无彩）
--dsc-seed-page/-side/-card      带品牌倾向的种子色
--dsc-mix-page/-side/-card       种子色占多少
   ↓
--dsc-bg-page / --dsc-bg-side / --dsc-bg-card     页面 / 侧栏 / 卡片底
--dsc-bg-raised → --dsc-bg-popover                抬升面 → 浮层底
```

浅色主题只换中性底、种子色和混比这三组，上面那层派生自动跟着变。**加新的表面色要挂在这条链上**，
不要直接写 `#fff`。

### 2.2 颜色角色表

| 角色 | 令牌 | 用在哪 |
| --- | --- | --- |
| 页面 / 侧栏 / 卡片 | `--dsc-bg-page` `--dsc-bg-side` `--dsc-bg-card` | 三层底色，别越级 |
| 抬升 / 浮层 | `--dsc-bg-raised` `--dsc-bg-popover` | 弹层、菜单、对话框 |
| 软填充五档 | `--dsc-fill-primary` … `--dsc-fill-quinary` | 从最实到最淡的控制底，按「这块要多显眼」选 |
| 行 / 控制态 | `--dsc-row-hover-bg` `--dsc-row-active-bg` `--dsc-control-hover-bg` `--dsc-control-active-bg` | 悬停与选中 |
| 文字四级 | `--dsc-text-primary` `-secondary` `-tertiary` `-quaternary` | 正文 / 次要 / 提示 / 装饰，**不要自造透明度** |
| 骨架文字 | `--dsc-text-scaffold` `--dsc-text-scaffold-meta` | 顶栏、状态栏这类框架文字 |
| 描边四级 | `--dsc-stroke-1` … `--dsc-stroke-4` | 1 最强（最明显），界面分隔默认用 `--dsc-stroke-3` |
| 浮层发丝线 | `--dsc-stroke-float` | 只在浮层上，跟 `--dsc-shadow-float` 配对 |
| 语义色 | `--dsc-red` `-orange` `-yellow` `-green` `-cyan` `-purple` | 状态、图标、图表；深浅两套取值不同 |
| 品牌 | `--dsc-accent` `--dsc-accent-hover` `--dsc-accent-text` `--dsc-text-on-accent` | 主行动、选中、链接 |

`--dsc-accent-text` 和 `--dsc-accent-hover` 是**派生色**，写在 `tokens.css` 末尾的 `:root` 块里，
用 `color-mix()` 从主题变量算出来，这样浅色主题会自己重算。新增派生色照这个写法。

### 2.3 圆角、间距、尺寸

| 组 | 令牌 | 取值 | 规矩 |
| --- | --- | --- | --- |
| 圆角 | `--dsc-r-control` `-badge` `-icon` `-block` `-row` `-overlay` `-card` `-composer` `-pill` | 2.5 / 3 / 4 / 5 / 6 / 8 / 10 / 8 / 999 px | 近乎方角。**不许写圆角字面量**，没有合适的那一档再商量加一档。 |
| 间距 | `--dsc-sp-0` … `--dsc-sp-8` | 2 / 4 / 6 / 8 / 10 / 12 / 16 / 20 / 24 px | 布局留白走这一套，别写 `gap: 13px` |
| 行几何 | `--dsc-row-h` `--dsc-row-pad-x` `--dsc-row-gap` `--dsc-row-lead` | 26px×密度 / 8 / 6 / 14 | 所有列表行共用 |
| 控制尺寸 | `--dsc-ctl` `-sm` `-lg` `--dsc-send` `--dsc-input-min-h` `-max-h` | 24 / 20 / 32 / 26 / 26 / 150 px | 按钮与控制件对齐用 |
| 标题栏 | `--dsc-titlebar-h` `--dsc-titlebar-btn` `--dsc-titlebar-icon` | 36 / 24 / 13.9 px | 和原生控件条一起算，见 §10 |
| 版面 | `--dsc-sidebar-w` `--dsc-sidebar-rail` `--dsc-page-inset` `--dsc-page-max` `--dsc-thread-max` | 237px / 56px / clamp(20px,4vw,64px) / 1200px / 76ch | 正文列宽用 `ch`，别写 px |

### 2.4 字体阶梯

字号全部走 `--dsc-font-scale`，所以「外观 → 字号」改一档全局跟着变。

| 令牌 | 基准 | 用在哪 |
| --- | --- | --- |
| `--dsc-fs-body` / `--dsc-lh-body` | 13 / 18 px | 正文、会话标题 |
| `--dsc-fs-caption` / `--dsc-lh-caption` | 12 / 16 px | 说明、时间、次要信息 |
| `--dsc-fs-tool` | 11 px | 工具行参数与结果 |
| `--dsc-fs-label` `--dsc-fs-micro` | 10.2 / 9.6 px | 小节标签、角标 |
| `--dsc-fs-code` | 11.2 px | 代码块与行内代码 |
| `--dsc-fs-ui` `--dsc-fs-ui-lg` | 12 / 14 px | 界面控件文字 |
| `--dsc-fs-title` `--dsc-fs-hero` | 16 / 21 px | 面板标题、欢迎页大字 |
| `--dsc-fs-prose` / `--dsc-lh-prose` | 14 / 22 px | 模型长文（比界面正文大一档，读起来不费劲） |

小节标签还有 `--dsc-label-case: uppercase` 和 `--dsc-label-track: 0.16em`，用 `.dsc-sect` 自动带上。

### 2.5 密度

`--dsc-density` 一个数乘出行高、堆叠间距、块间距、回合间距：标准 `1`、紧凑 `0.9`、宽松 `1.15`。
**新写的垂直节奏要乘它**（`calc(6px * var(--dsc-density))`），否则「外观 → 密度」对它无效。

### 2.6 阴影、层级、动效

| 组 | 令牌 | 用在哪 |
| --- | --- | --- |
| 阴影 | `--dsc-shadow-xs` `-sm` `-md` `-float` `-composer` | `xs` 贴地、`md` 菜单与下拉、`float` 弹层与对话框、`composer` 输入区 |
| 层级 | `--dsc-z-dock` 20 / `-handle` 24 / `-menu` 40 / `-backdrop` 120 / `-modal` 130 / `-modal-popover` 140 / `-toast` 200 / `-tip` 210 / `-picker` 220 / `-crash` 1500 | 选一档，**不许写 `z-index: 9999`** |
| 动效 | `--dsc-dur` 100ms / `--dsc-dur-slow` 180ms / `--dsc-ease` | 过渡只写 `var(--dsc-dur) var(--dsc-ease)` |
| 提示 | `--dsc-tip-delay` 200ms / `--dsc-tip-warm` 300ms | 首次悬停等 200ms，热了之后 300ms 内秒开 |

**故意保留的颜色字面量只有 6 处**：品牌渐变 logo 和它上面的白字、彩底上的白色图标、开关的白滑块、
两处深色遮罩（`.dsc-overlay` 与设置页遮罩）。别的地方出现 `#` 开头的颜色就是漏网的。

## 3. 原语层（`styles/primitives.css`）

一个关注点一个原语，全部 `.dsc-` 前缀、全部用属性选档位。**调用点只给属性，不给尺寸。**

### 3.1 按钮 `.dsc-btn`

变体（`data-variant`）：`primary`（实心品牌色，一屏通常只该有一个）、`destructive`（危险）、
`secondary`（软填充，非主按钮的默认长相）、`outline`（透明底 + 1px 内描边）、`chip`（可点的筛选片）、
`ghost`（只靠悬停背景说话）、`floating`（浮在任意表面之外）、`grip`（拖拽把手）、
`text` / `textStrong` / `link`（行内文字行动作，前者悬停才下划线、中者始终带下划线）。

尺寸（`data-size`）：`xs` / `sm` / `lg` / `inline`（嵌在句子里、不带盒子）/ `micro`（状态条与表尾）、
`icon` / `icon-xs` / `icon-sm` / `icon-titlebar`。

规矩：基础圆角是 `--dsc-r-control`(2.5px)，只有图标档换成 `--dsc-r-icon`(4px)；按钮高度由 padding
和行高决定，不设固定高度（`primitives.css:15`）。SVG 尺寸由档位定，别在调用点改。

### 3.2 其余原语

| 原语 | 选择器 | 档位与要点 |
| --- | --- | --- |
| 表单控件 | `.dsc-ctl` | 输入框/文本域/下拉共用；静息描边 7%，悬停翻倍，聚焦更亮；`aria-invalid` 走危险色；`data-size: xs/sm` |
| 字段行 | `.dsc-field` `__label` `__help` | 设置页每一行就是「标签 + 说明 + 控件」 |
| 徽标 / 计数 | `.dsc-badge` | `data-tone: accent/muted/success/warn/danger/outline`，`data-size: xs`；**徽标不可点**，可点的筛选片是 `.dsc-btn[data-variant='chip']` |
| 分段选择 | `.dsc-segmented` `__btn` | 少量互斥选项（主题、密度、统计周期）；两态视图切换不用它，用一个 `ghost` 图标按钮显示「切过去是什么」 |
| 列表行 | `.dsc-row` `__body` `__lead` `__label` `__meta` `__actions` | 侧栏会话行是基准，导航行、插件行、技能行、设置行、归档行全沿用它的几何；`data-active` / `aria-current` 表选中 |
| 小节标签 | `.dsc-sect` `__meta` | `meta` 槽放计数 |
| 日期分隔 | `.dsc-date-sep` | 两侧发丝线由伪元素画 |
| 文本标签页 | `.dsc-tabs` `__btn` | 用 `aria-selected` 表选中 |
| 浮层容器 | `.dsc-pop` | `data-size: menu/menu-lg/menu-xl`；底色 + `--dsc-shadow-float` |
| 菜单 | `.dsc-menu` `__item` `__label` `__sep` `__key` | `__item[data-tone='danger']` 是危险项，`__key` 放快捷键 |
| 遮罩对话框 | `.dsc-overlay` `__card` | 卡片 = 抬升面 + 浮层阴影 |
| 确认框 | `.dsc-confirm` `__title` `__detail` `__actions` | 走 `confirmAction()`，见 §6 |
| 悬浮提示 | `.dsc-tip` | 走 `installTipLayer()`，见 §7 |
| 加载 / 骨架 / 空态 / 列表内空态 | `.dsc-loader` `.dsc-skeleton` `.dsc-state-empty` `.dsc-state-inlist` | 别再手写第三种居中空态 |
| 通告 / 吐司 | `.dsc-notice` `.dsc-toast` | 通告目前只有 `data-tone='danger'`；吐司有 `danger` 和 `success` |

### 3.3 什么时候扩原语、什么时候别新建

- 新控件只是**已有原语换一套参数**？加一档 `data-*`，别新建类。
- 新控件是**新的关注点**（dsc 里还没有的东西）？在 `primitives.css` 里按同样的写法加一节，
  并在本节表格里补一行。
- 只在**一个页面里用一次**、且不是通用语义？写进 `styles.css` 的功能区，标好注释。
- 想把某个页面的原语「微调一下」？先问是不是原语本身该改——改一处、处处受益，比在调用点覆盖强。

## 4. 布局与几何

- 三栏：56px 图标窄栏 → 可拖宽的侧栏（默认 237px）→ 正文列。侧栏和正文列两侧都能拖
  （`ThreadResizer.tsx`，拖出来的宽度写成根元素上的 CSS 变量）。
- 页面左右留白用 `--dsc-page-inset`，内容最大宽度 `--dsc-page-max`；正文段落宽度 `--dsc-thread-max`（76ch）。
- 列表行之间**默认不加分隔线**，用间距分开；确实需要时用一条 `--dsc-stroke-3` 发丝线。
- 顶栏高度和原生控件条联动，见 §10。
- 面板尺寸与收起状态存在 `panels.ts` 里，重启后恢复（`development.md` §13）。

## 5. 聊天、工具行与状态

- **对话是主界面**：正文栏永远优先，工具、预览、轨迹是补充。
- 工具行（`ToolCard.tsx`）：参数与结果用 `--dsc-fs-tool`；展开的详情高度上限 `--dsc-tool-detail-max-h`。
- **危险红只给真正的失败**：用户拒绝、执行报错才用 `--dsc-red`；读不到文件、退出码 1 这类模糊结果
  用中性通告（这就是「已拒绝」状态落盘那一轮改的东西）。
- 思考块、工具块这类「面板里的面」用 `--dsc-fill-quinary` 一档的软填充，不要描边。
- 步骤时间线的竖线是**中性色**（`color-mix(in srgb, var(--dsc-base) 10%, transparent)`），
  不要用带品牌色的 `--dsc-stroke-1`——浅色主题下会变成一条很吵的蓝线。
- 审批卡（`ApprovalCard.tsx`）停在对话流里，不抢焦点、不自动展开面板。
- 用户气泡里的贴图（`.entry-user-images img`）用 132×96 固定框 + `object-fit: contain`：
  截图和 1×1 的小图都占同一格，点开是原图；输入框上方那排待发贴图（`.attach-strip`）同理由，56×56。
- 后台事件（工具结果、队友完工）只更新角标和缓存，**不许替换前台正文或抢焦点**（原则 6）。

## 6. 反馈：加载、空态、错误、确认

| 场景 | 用什么 | 注意 |
| --- | --- | --- |
| 加载中 | `.dsc-loader` / `.dsc-skeleton` | 不要写「加载中…」这种死文字配一个转圈 |
| 列表为空 | `.dsc-state-inlist` | 行内空态，带一个图标和一句为什么空 |
| 整页为空 | `.dsc-state-empty` | 标题 + 说明，别手写第三种居中空态 |
| 报错 | `.dsc-notice[data-tone='danger']` | 说明**发生了什么 + 怎么办**，不要只贴错误码 |
| 轻提示 | `toastOk()` / `toastErr()` | 一次性、可自动消失；要用户做决定的事不要用吐司 |
| 要用户确认 | `confirmAction({...})` | 唯一的「你确定吗」通道；打开即聚焦确认键，`Enter` 确认、`Esc` 取消；**不许用 `window.confirm`** |
| 悬停解释 | `installTipLayer()` + `.dsc-tip` | 只在「悬停能学到新东西」时用，详 §7 |

## 7. 提示、图标与品牌

**提示**（hermes 的 `<Tip>` 规则，dsc 一致）：

- 该提示的：没标签的顶栏/工具栏图标、快捷键、被截断的路径、归属标记。
- **不该提示的**：菜单触发器（`⋯`、齿轮——它自己的语义就是「打开菜单」，动词在菜单里）、关闭叉、
  以及可见文字已经说清楚的控件。
- 别用原生 `title=`：样式不可控、延迟约 500ms，和自绘提示打架。
- 时序：首次悬停等 `--dsc-tip-delay`(200ms)，之后 `--dsc-tip-warm`(300ms) 内秒开；出场 100ms 淡出。

**图标**：`icons.tsx` 是自维护的细线 SVG 集（`stroke-width: 1.6`、`currentColor`、默认 16px）。
一个动作对应一个图标，不引入第二套图标库、不在同一组控件里混风格。品牌方块是 `.welcome-mark`
（首屏那颗 52px 的渐变色块，`styles.css:850`）和侧栏的 `.sidebar-header .brand`，它们是 §2.6 里
允许写死颜色的地方。

**终端配色**：`components/terminalTheme.ts` 把 `--dsc-*` 转成 xterm 的 `ITheme`。注意 xterm 只认
具体色值，而令牌大多是没求值的 `color-mix(...)` 原文，所以它和 `appearance.ts` 用的是同一套两步
取色：先借隐藏元素拿计算色，再过 1×1 画布归一成 sRGB。**加终端颜色不要另写一套取色**。

## 8. 动效与直接操作

- 过渡用 `var(--dsc-dur) var(--dsc-ease)`（100ms）或 `--dsc-dur-slow`（180ms）。**不许写 `transition: all`**，
  也不许在热交互上做布局动画。
- 动效跟着状态走，**绝不延迟状态**：选中、按下、拖拽目标当帧就位。
- `base.css` 已经处理了两件事：`prefers-reduced-motion` 时一律瞬时到位；
  `prefers-reduced-transparency` 时撤掉所有 `backdrop-filter`（模糊层每帧重采样，贵）。
- 直接操作先画界面、后落盘，失败可见地回滚（原则 7）。
- 隐藏不等于卸载：贵的界面保持挂载，用 `hidden` / `inert` 控制可见性。

## 9. 键盘、焦点与取消

- 键盘归属跟着焦点走：焦点在哪块，哪块收键；全局快捷键不许抢终端和编辑器的绑定。
- 焦环统一由 `base.css` 画（3px 强调色环），原语自己带，调用点不要另外加 `outline`。
- 选中文本用暖黄而不是品牌蓝：蓝底压白字在深色主题里会把字吃掉（`base.css:32`）。
- 一次取消只做一件事：取消当前交互，**或**关掉最上层可关的面，不许两个都做。
- `Esc` 关掉所有可关的浮层；取消在界面上是同步的，哪怕清理是异步的。

## 10. 外观设置与主题

「外观」三档存在 `~/.dsc/settings.json` 的 `ui` 里（`themeMode` / `fontSize` / `density`），
设置界面改完立刻生效并落盘：

1. `appearance.ts` 的 `applyAppearance()` 往 `<html>` 写 `data-theme` / `data-density` / `--dsc-font-scale`，
   样式表据此换色换字号；
2. 同一份外观写一份 localStorage 镜像，`main.tsx` 首帧和 `App.tsx` 的 `uiPrefs` 初值都读它——
   这样宿主返回真实设置之前不会先闪一次默认深色；
3. `pushWindowChrome()` 把 `--dsc-chrome-bar` / `--dsc-chrome-symbol` 算成 `#rrggbb` 通过
   `dsc:set-window-chrome` 发给主进程，主进程调 `setTitleBarOverlay` + `setBackgroundColor` 改
   系统画的那三个窗口按钮。

细节和坑（`color(srgb …)` 序列化、只收不透明色、深浅默认值）写在
[development.md §13「主题色怎么送到原生窗口控件」](development.md)。

**加一层主题要做什么**：只换 `tokens.css` 里那三组（中性底、种子色、混比）就够，
其它文件不该认识主题；派生色一律写在末尾 `:root` 块，让它跟着重算。

## 11. hermes 的主题引擎，以及要不要搬

这一节是**参考资料**，给以后想扩主题系统的人看。dsc 现在是「一份纯 CSS 变量表 + 深/浅两套」，
hermes 是一整套运行时主题引擎（`D:\hermes\hermes-agent\apps\desktop\src\themes\`，15 个模块）。
结论先给：**dsc 不需要引入构建期主题编译器——hermes 也没有那东西**，它的主题全链路都是运行时。

### 11.1 hermes 是怎么组织的

| 层 | 位置 | 干什么 |
| --- | --- | --- |
| 数据模型 | `themes/types.ts:13-105` | `DesktopTheme` = 名字/标签 + `colors`（19 必填 + 7 可选的颜色槽）+ `darkColors` + `typography` + `terminal`（16 个 ANSI 槽）+ `customCSS` |
| 内置预设 | `themes/presets.ts:398-410` | 11 套：`nous`（默认）、`github`、`catppuccin`、`everforest`、`solarized` 从上游主题 fork；`nous-alt`、`midnight`、`ember`、`mono`、`cyberpunk`、`slate` 是第一方手写 |
| 颜色数学 | `themes/color.ts` | OKLCH 工具箱：`normalizeHex`、`mixOklab`、`oklchToHex`（出界二分降彩度保色相）、`ensureContrastOklch`（只走亮度，每步 0.02，最多 40 步）、`readableInk` |
| 重染 | `themes/retint.ts:91-198` | 从一个种子色重算整个强调色族：强调色槽继承种子色相、保留各自亮度；`primaryForeground` 用 `readableInk` 重挑；对侧栏的对比度下限 4.5:1 |
| 皮肤互换 | `themes/skin.ts:58-116` | 把 CLI/TUI 的 YAML skin 转成桌面主题，只从几个「负载最重」的键取种子，其余靠混 |
| 用户主题 | `themes/user-themes.ts` | 存 **localStorage**（不是文件），模块求值时同步读——为了 React 挂载前的首帧也能解析；逐条校验，用户主题不许遮蔽内置名 |
| VS Code 导入 | `themes/vscode.ts` | JSONC 容错 → workbench 键映射到自己的槽位（约 15 个键，强调色有 12 级回退链）→ 混出其余 |
| 落变量 | `themes/context.tsx:227-353` | 唯一写 token 的地方：往 `<html>` 的行内样式写三组变量（种子 `--theme-*`、混比 `--theme-mix-*`、应用层 `--dt-*`） |

两个值得记住的设计判断：

1. **深浅和皮肤是两个独立维度**。皮肤 = 调色板身份，模式 = `light/dark/system` 决定取哪套槽位；
   还有第三层 `renderedModeFor`（`context.tsx:191-201`）**按实际背景亮度判定真实明暗**，
   可以推翻用户选的模式——这样「声明 dark 但底色是亮的」主题不会让终端和图片反色错。
2. **sRGB 与 OKLab 分工明确**：页面/卡片/描边/文字这些层级梯度用 CSS
   `color-mix(in srgb, …)` 声明式推导（和 dsc 现在的做法一样）；只有品牌色族的派生走 OKLab，
   因为 sRGB 混白会把饱和蓝带偏约 8° 变成薰衣草色（`color.ts:253-265`）。

### 11.2 如果以后要搬，哪些能抄

| 判断 | 条目 | 代价 |
| --- | --- | --- |
| **能直接照抄** | 种子 + 声明式阶梯的分层（JS 只写种子和比例，层级交给 CSS） | 几乎为零，dsc 已经是这个结构 |
| | 强调色的最小对比度门槛（4.5:1）与「压色文字按实测择优」 | 约 30 行启动期 JS |
| | 按背景亮度判定真实明暗 | 一个 6 行的亮度函数，能防住终端/图片反色错 |
| | 「预设从上游 fork，不手改 hex」的纪律 | 零 |
| **要自己实现** | `retintTheme` + 它依赖的 OKLCH 工具箱 | 约 400～500 行纯函数。这是「把色相旋钮开放给用户」的前提，不做就只能让用户选整套预设 |
| | 首帧预涂（`index.html` 内联脚本 + 模块级首次上色） | 小。dsc 已有 localStorage 镜像这一层（§10），只差「允许用户自定义主题」时的扩展 |
| | 只给暗色盘的主题在浅色模式下的合成 | 一套额外混色规则；不做则暗色-only 主题在浅色下没有外观 |
| **建议放弃** | 11 套内置预设全搬 | 每套要维护 19 个颜色 × 深浅两套 + 一张 ANSI 表 |
| | 语义色朝强调色「弯」一点（`harmonize`） | 审美决策，会让「成功」的绿偏离用户预期 |
| | per-profile 皮肤分配、dev-only 的强调色覆盖 | dsc 单 profile 单窗口，复杂度换不来收益 |
| | VS Code 主题导入 | 纯增量功能（`themes/vscode.ts` 372 行 + JSONC 容错 + 多变体合并 + 主进程解 `.vsix`），不做不影响主题成立。终端配色 dsc 已经有了（`components/terminalTheme.ts`） |

### 11.3 结论

dsc 现在这套（`tokens.css` 一份、深色默认、浅色用 `[data-theme='light']` 覆盖、派生色写在末尾
`:root`）**不是欠账**，和 hermes 的 CSS 推导层是同一个思路。真要往「用户可调主题」走，
按这个顺序补：先按背景亮度判定真实明暗 → 再补种子与比例的可配置化 → 最后才轮到 OKLCH 重染。
前两件是小时级，第三件要认真评估（那是 `color.ts` 331 行的体量）。

## 12. 术语对照

| hermes | dsc | 说明 |
| --- | --- | --- |
| `--ui-*` / `--theme-*` | `--dsc-*` | 令牌前缀，全部集中在 `tokens.css` |
| `--theme-fill-*` / `--theme-stroke-*` 比例旋钮 | `--dsc-mix-*` / `--dsc-stroke-*` 百分比 | 同一套思路：调比例而不是调颜色 |
| `DesktopTheme.darkColors`（主题自带两套盘） | `[data-theme='light']` 覆盖块 | hermes 一个「皮肤」可带深浅两套；dsc 只有一份主题的深浅两份，不引入第三层身份 |
| `shadow-nous` + `--stroke-nous` | `--dsc-shadow-float` + `--dsc-stroke-float` | 浮层抬升组合 |
| `<Button variant size>` | `.dsc-btn[data-variant][data-size]` | 同一套变体名，dsc 多了 `chip` / `floating` / `grip` |
| `SearchField` | `.dsc-ctl` | dsc 没有独立搜索框原语 |
| `SegmentedControl` | `.dsc-segmented` | 语义一致 |
| `ListRow` | `.dsc-row` | 语义一致 |
| `ConfirmDialog` / `confirm()` | `confirmAction()` | 语义一致 |
| `Loader` / `ErrorState` / `EmptyState` | `.dsc-loader` / `.dsc-notice` / `.dsc-state-*` | 语义一致 |
| Tabler + Codicon | `icons.tsx` | dsc 自维护细线图标集 |
| `useI18n()` | 无 | **dsc 的中文文案直接写在组件里**，不做多语言 |
| nanostores | React state + IPC 快照流 | dsc 的状态来自运行时快照 |
| `--z-*` 层级阶梯 | `--dsc-z-*` | 同一套思路 |

## 13. 加一个界面之前——自查清单

- [ ] 能复用已有原语吗？不能的话，是加一档 `data-*` 还是真要新原语？
- [ ] 有没有颜色 / 圆角 / 字号 / 间距 / 层级 / 时长写成了字面量？
- [ ] 有没有在调用点覆盖原语的 padding、圆角、颜色？
- [ ] 新写的垂直节奏乘了 `--dsc-density` 吗？字号走 `--dsc-font-scale` 了吗？
- [ ] 浮层用了 `--dsc-shadow-float` + `--dsc-stroke-float`，没画粗边框？
- [ ] 列表没有平白加分隔线、没有卡片套卡片？
- [ ] 加载 / 空 / 错三种状态都有，且说清「发生了什么、怎么办」？
- [ ] 要用户确认的事情走了 `confirmAction()`，没走 `window.confirm`？
- [ ] 提示只出现在「悬停能学到新东西」的地方，没给菜单触发器和关闭叉加提示？
- [ ] 后台事件不会切页面、抢焦点、自动展开面板？
- [ ] 键盘归属正确，`Esc` 只关一层，焦环没被覆盖？
- [ ] **深色和浅色都看过**（`外观 → 主题` 切换），对比度都够？
- [ ] 改完跑了 `cd D:\dsc\desktop && pnpm run typecheck`？

## 14. 改完怎么验证

```sh
# 类型检查
cd D:\dsc\desktop && pnpm run typecheck

# 开发态起界面（改 renderer 会热更新）
cd D:\dsc\desktop && pnpm dev

# 打包版实拍（快捷键指向的就是它）
cd D:\dsc\desktop && pnpm run dist:dir     # → dist/win-unpacked/dsc.exe
```

实拍的环境变量钩子（`desktop/electron/main/index.ts`）见
[development.md §8](development.md)。看深浅两套时**务必两边都拍**：这轮重构里
「浅色主题下弹层还是深色」「原生控件条不跟主题」都是只在浅色下才暴露的问题。
