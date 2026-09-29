/**
 * Windows 网络管控「第二级」的 ABI 常量与规格表：WFP 层/条件 GUID、12 条 BLOCK filter、
 * 5 条防火墙规则清单、环回 TCP 的端口补集。
 *
 * 三种值的来源要分清（这是本文件唯一容易出错的地方）：
 *   1. **Windows 官方常量**（WFP 层 GUID、条件 GUID、FWP_* 枚举、FWP_E_* 返回码）：照抄即可，
 *      值取自 Windows SDK 的 fwpmu.h/fwptypes.h，并逐条与 windows-sys 0.61.2（由 Win32 元数据
 *      生成的 Rust 绑定）核对过，核对方式见每条注释；
 *   2. **dsc 自己的 WFP 身份**（provider 1 个 + sublayer 1 个 + 12 条 filter 的 key）：uuid v4，
 *      一次生成、永久硬编码。WFP 用 GUID 认对象，持久对象装上就活在系统里，GUID 一变动等于换了
 *      套命名空间、把旧对象孤儿化（codex 的 wfp.rs 专门警告过）。所以**绝不**照抄 codex 的 GUID，
 *      也**绝不在运行时**随机生成；
 *   3. **实测字面量**（防火墙 RemoteAddresses 的补集写法、SDDL 形态）：来自 codex 已经用
 *      Windows 防火墙 COM 验证过的字面量（见 setup_provisioning/firewall.rs 的测试）。
 *
 * 两个反直觉但必须踩准的值，单独标出来：
 *   - `FWP_ACTION_BLOCK` 是 **0x1001**，不是 0x1（0x1000 是 FWP_ACTION_FLAG_TERMINATING）；
 *   - `FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V4/V6` 的 GUID 是 0x...f53a0c / 0x55a650e1...，
 *     跟「直觉上像」的邻值差得很远。
 *
 * @module dsc/core/sandbox/win/net-abi
 */

// ── WFP 层 GUID（Windows 官方常量，来源 Windows SDK fwpmu.h）────────────────────
//
// 核对记录（windows-sys 0.61.2，src/Windows/Win32/NetworkManagement/WindowsFilteringPlatform/mod.rs）：
//   FWPM_LAYER_ALE_AUTH_CONNECT_V4         = GUID::from_u128(0xc38d57d1_05a7_4c33_904f_7fbceee60e82)
//   FWPM_LAYER_ALE_AUTH_CONNECT_V6         = GUID::from_u128(0x4a72393b_319f_44bc_84c3_ba54dcb3b6b4)
//   FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V4  = GUID::from_u128(0x1247d66d_0b60_4a15_8d44_7155d0f53a0c)
//   FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V6  = GUID::from_u128(0x55a650e1_5f0a_4eca_a653_88f53b26aa8c)

/** ALE_AUTH_CONNECT_V4：出站连接授权层（TCP/UDP 连接与 ICMP 都在这里过）。 */
export const FWPM_LAYER_ALE_AUTH_CONNECT_V4 = 'c38d57d1-05a7-4c33-904f-7fbceee60e82'
/** ALE_AUTH_CONNECT_V6：同上，IPv6。 */
export const FWPM_LAYER_ALE_AUTH_CONNECT_V6 = '4a72393b-319f-44bc-84c3-ba54dcb3b6b4'
/** ALE_RESOURCE_ASSIGNMENT_V4：本地端点（bind/隐式绑定）分配层，ICMP 的「分配」在这里。 */
export const FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V4 = '1247d66d-0b60-4a15-8d44-7155d0f53a0c'
/** ALE_RESOURCE_ASSIGNMENT_V6：同上，IPv6。 */
export const FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V6 = '55a650e1-5f0a-4eca-a653-88f53b26aa8c'

// ── WFP 条件 GUID（Windows 官方常量）──────────────────────────────────────────
//
// 核对记录（同上文件）：
//   FWPM_CONDITION_ALE_USER_ID    = 0xaf043a0a_b34d_4f86_979c_c90371af6e66
//   FWPM_CONDITION_IP_PROTOCOL    = 0x3971ef2b_623e_4f9a_8cb1_6e79b806b9a7
//   FWPM_CONDITION_IP_REMOTE_PORT = 0xc35a604d_d22b_4e1a_91b4_68f674ee674b

/** 条件：发起连接的用户 SID（数据是 FWP_SECURITY_DESCRIPTOR_TYPE）。 */
export const FWPM_CONDITION_ALE_USER_ID = 'af043a0a-b34d-4f86-979c-c90371af6e66'
/** 条件：IP 协议号（FWP_UINT8）。 */
export const FWPM_CONDITION_IP_PROTOCOL = '3971ef2b-623e-4f9a-8cb1-6e79b806b9a7'
/** 条件：远端端口（FWP_UINT16）。 */
export const FWPM_CONDITION_IP_REMOTE_PORT = 'c35a604d-d22b-4e1a-91b4-68f674ee674b'

// ── IP 协议号（RFC 1700 / winsock 的 IPPROTO_*）───────────────────────────────

export const IPPROTO_ICMP = 1
export const IPPROTO_TCP = 6
export const IPPROTO_UDP = 17
export const IPPROTO_ICMPV6 = 58

// ── FWP 枚举与标志（值同 Windows SDK）────────────────────────────────────────

/**
 * 动作：阻断。
 *
 * **0x1001 = FWP_ACTION_FLAG_TERMINATING(0x1000) | 1**，SDK/windows-sys 里的 FWP_ACTION_BLOCK
 * 就是 4097。写成 0x1 会被 WFP 当成非法动作类型（不是「弱一点的阻断」），务必照抄。
 */
export const FWP_ACTION_BLOCK = 0x1001
/** 匹配方式：相等（FWP_MATCH_EQUAL）。 */
export const FWP_MATCH_EQUAL = 0
/** 条件值类型：FWP_SECURITY_DESCRIPTOR_TYPE（ALE_USER_ID 用）。 */
export const FWP_SECURITY_DESCRIPTOR_TYPE = 14
/** 条件值类型：FWP_UINT8（协议号用）。 */
export const FWP_UINT8 = 1
/** 条件值类型：FWP_UINT16（端口用）。 */
export const FWP_UINT16 = 2
/** 空值（weight / effectiveWeight 用 FWP_EMPTY）。 */
export const FWP_EMPTY = 0
/**
 * ALE_USER_ID 安全描述符里 ACE 的访问掩码：FWP_ACTRL_MATCH_FILTER(0x1)。
 * 语义是「让引擎拿令牌里的用户 SID 来跟这个 SD 比对」，不是普通的访问控制；
 * 巧合的是防火墙 LocalUserAuthorizedList 的 SDDL 里那个 `CC` 也是 0x1，两处别混。
 */
export const FWP_ACTRL_MATCH_FILTER = 0x1

/** filter 标志：持久（重启后仍在）。 */
export const FWPM_FILTER_FLAG_PERSISTENT = 0x1
/** provider 标志：持久。 */
export const FWPM_PROVIDER_FLAG_PERSISTENT = 0x1
/** sublayer 标志：持久。 */
export const FWPM_SUBLAYER_FLAG_PERSISTENT = 0x1
/** sublayer 权重：高于防火墙默认子层，保证 BLOCK 先于 MPSSVC 的 permit 被评估。 */
export const DSC_WFP_SUBLAYER_WEIGHT = 0x8000

/** FwpmEngineOpen0 的认证服务：RPC_C_AUTHN_WINNT。 */
export const RPC_C_AUTHN_WINNT = 10

// ── WFP 返回码（FWP_E_*，均为 HRESULT 0x8032xxxx）─────────────────────────────
//
// 核对记录（windows-sys 0.61.2，Win32/Foundation）：
//   FWP_E_FILTER_NOT_FOUND   0x80320003
//   FWP_E_LAYER_NOT_FOUND    0x80320004
//   FWP_E_PROVIDER_NOT_FOUND 0x80320005
//   FWP_E_SUBLAYER_NOT_FOUND 0x80320007
//   FWP_E_NOT_FOUND          0x80320008
//   FWP_E_ALREADY_EXISTS     0x80320009
// 注意：本机实测也印证了这条次序（非提权会话里查内置层得到 0x80320004、
// 查不存在的子层得到 0x80320007）。**FWP_E_NOT_FOUND 是 0x80320008，不是 0x8032000A**
// （0x8032000A 是 FWP_E_IN_USE），所以「NOT_FOUND 容忍表」必须写 0x80320008。
//
// 用得上这套码的两个地方：① 子层探测（wfp.ts）要区分「真没有」与「本会话看不见」；
// ② 装 filter 前的 delete-if-present（setup.ts 的 C# 里）要容忍 0x80320003 与 0x80320008。

export const FWP_E_FILTER_NOT_FOUND = 0x80320003
export const FWP_E_LAYER_NOT_FOUND = 0x80320004
export const FWP_E_PROVIDER_NOT_FOUND = 0x80320005
export const FWP_E_SUBLAYER_NOT_FOUND = 0x80320007
export const FWP_E_NOT_FOUND = 0x80320008
export const FWP_E_ALREADY_EXISTS = 0x80320009
/** FWP_E_IN_USE：对象被占用（顺带记一笔，它才是大家常记错的那个 0x8032000A）。 */
export const FWP_E_IN_USE = 0x8032000a

/** 「子层查不到」的返回码集合（探测时用来区分「没有」与「看不见」）。 */
export const FWP_E_LOOKUP_MISSING: readonly number[] = [FWP_E_SUBLAYER_NOT_FOUND, FWP_E_NOT_FOUND]

// ── dsc 自己的 WFP 身份（uuid v4，一次生成，永久硬编码，勿重生成）─────────────

/** dsc 的持久 WFP provider（一组 filter 的归属）。 */
export const DSC_WFP_PROVIDER_GUID = '6457c14d-3d0d-4bb7-af2a-07311a5c18c2'
/** dsc 的持久 WFP sublayer（12 条 filter 全挂它下面；探测存在性就是查它）。 */
export const DSC_WFP_SUBLAYER_GUID = 'bd22d574-59b1-4f71-ab24-7856770ddb51'
/** provider / sublayer / filter 的显示名前缀（在 netsh wfp show 与防火墙 UI 里认得出是 dsc 的）。 */
export const DSC_WFP_DISPLAY_PREFIX = 'dsc Windows Sandbox WFP'

// ── 12 条 BLOCK filter 的规格表 ──────────────────────────────────────────────

/** 一条持久 BLOCK filter 的规格：条件固定为「账号 SID」（由调用方补齐）+ 下面这项。 */
export interface WfpFilterSpec {
  /** filter 的 key（dsc 自有 GUID，硬编码）。 */
  readonly key: string
  /** WFP 里的显示名（审计用）。 */
  readonly name: string
  /** 挂在哪一层。 */
  readonly layer: string
  /** IP 协议号；只按端口拦的那几条为 null。 */
  readonly protocol: number | null
  /** 远端端口；ICMP 那四条为 null。 */
  readonly remotePort: number | null
  /** 说明文字（同样进 WFP 显示数据，便于 `netsh wfp show filters` 里读）。 */
  readonly description: string
}

/**
 * 12 条 filter：ICMP v4/v6 各在「连接授权」与「资源分配」两层拦（共 4 条），
 * 再加 DNS(53)、DoT(853)、SMB(445)、SMB(139) 各自的 v4/v6（共 8 条）。
 *
 * 每条都带 ALE_USER_ID 条件（账号 SID），所以只影响沙箱账号，不碰真人用户的网络。
 * 53/853/445/139 只按远端端口拦：TCP 与 UDP 都覆盖到，跟 codex 的取舍一致。
 */
export const DSC_WFP_FILTERS: readonly WfpFilterSpec[] = [
  {
    key: '906c71c1-a0b8-440f-9d55-93ea94c11f23',
    name: 'dsc_wfp_icmp_connect_v4',
    layer: FWPM_LAYER_ALE_AUTH_CONNECT_V4,
    protocol: IPPROTO_ICMP,
    remotePort: null,
    description: '阻断沙箱账号的 ICMP 连接授权（v4）',
  },
  {
    key: '65e3209f-a452-4281-811b-e299c7a5ef57',
    name: 'dsc_wfp_icmp_connect_v6',
    layer: FWPM_LAYER_ALE_AUTH_CONNECT_V6,
    protocol: IPPROTO_ICMPV6,
    remotePort: null,
    description: '阻断沙箱账号的 ICMP 连接授权（v6）',
  },
  {
    key: '58a9ef57-a3e8-4a83-9fbb-415a71c3f1e7',
    name: 'dsc_wfp_icmp_assign_v4',
    layer: FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V4,
    protocol: IPPROTO_ICMP,
    remotePort: null,
    description: '阻断沙箱账号的 ICMP 资源分配（v4）',
  },
  {
    key: 'd5d6b293-be8b-42c1-87a0-565c6b31f3b6',
    name: 'dsc_wfp_icmp_assign_v6',
    layer: FWPM_LAYER_ALE_RESOURCE_ASSIGNMENT_V6,
    protocol: IPPROTO_ICMPV6,
    remotePort: null,
    description: '阻断沙箱账号的 ICMP 资源分配（v6）',
  },
  {
    key: 'a8b40255-de27-495d-bd6f-b3569ea78539',
    name: 'dsc_wfp_dns_53_v4',
    layer: FWPM_LAYER_ALE_AUTH_CONNECT_V4,
    protocol: null,
    remotePort: 53,
    description: '阻断沙箱账号的 DNS（53/TCP+UDP，v4）',
  },
  {
    key: '0676d5c4-c49b-4c5f-841f-9aef3e22c8af',
    name: 'dsc_wfp_dns_53_v6',
    layer: FWPM_LAYER_ALE_AUTH_CONNECT_V6,
    protocol: null,
    remotePort: 53,
    description: '阻断沙箱账号的 DNS（53/TCP+UDP，v6）',
  },
  {
    key: 'ca497e81-2383-407c-9efe-e10ce06ef62d',
    name: 'dsc_wfp_dot_853_v4',
    layer: FWPM_LAYER_ALE_AUTH_CONNECT_V4,
    protocol: null,
    remotePort: 853,
    description: '阻断沙箱账号的 DNS-over-TLS（853，v4）',
  },
  {
    key: '25b2d0df-27fe-43b0-93b1-4f5f6d8efe0e',
    name: 'dsc_wfp_dot_853_v6',
    layer: FWPM_LAYER_ALE_AUTH_CONNECT_V6,
    protocol: null,
    remotePort: 853,
    description: '阻断沙箱账号的 DNS-over-TLS（853，v6）',
  },
  {
    key: 'a21d9de1-c8f5-4caa-9c9c-43235a2018c8',
    name: 'dsc_wfp_smb_445_v4',
    layer: FWPM_LAYER_ALE_AUTH_CONNECT_V4,
    protocol: null,
    remotePort: 445,
    description: '阻断沙箱账号的 SMB（445，v4）',
  },
  {
    key: '09e7b8ef-7e36-4c19-aa07-f9a6afb8c0fe',
    name: 'dsc_wfp_smb_445_v6',
    layer: FWPM_LAYER_ALE_AUTH_CONNECT_V6,
    protocol: null,
    remotePort: 445,
    description: '阻断沙箱账号的 SMB（445，v6）',
  },
  {
    key: '19c7dbc2-3de0-43e6-b387-0bb8f3f0b819',
    name: 'dsc_wfp_smb_139_v4',
    layer: FWPM_LAYER_ALE_AUTH_CONNECT_V4,
    protocol: null,
    remotePort: 139,
    description: '阻断沙箱账号的 SMB（139，v4）',
  },
  {
    key: 'aad2f721-86b9-4728-b0c3-a68006651dda',
    name: 'dsc_wfp_smb_139_v6',
    layer: FWPM_LAYER_ALE_AUTH_CONNECT_V6,
    protocol: null,
    remotePort: 139,
    description: '阻断沙箱账号的 SMB（139，v6）',
  },
]

// ── 防火墙：地址字面量与规则清单 ─────────────────────────────────────────────

/**
 * 「非环回」的远端地址补集（codex 用防火墙 COM 实测过这串字面量能被接受）：
 * 0.0.0.0-126.255.255.255 与 128.0.0.0-255.255.255.255 挖掉了 127/8，
 * `::`（未指定）与 `::2` 之后的全部 v6 挖掉了 ::1。
 */
export const DSC_FIREWALL_ADDRESS_NON_LOOPBACK =
  '0.0.0.0-126.255.255.255,128.0.0.0-255.255.255.255,::,::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'

/** 「环回」的远端地址：IPv4 的 127/8 与 IPv6 的 ::/127（含 :: 与 ::1）。 */
export const DSC_FIREWALL_ADDRESS_LOOPBACK = '127.0.0.0/8,::/127'

/** 一条防火墙规则的规格（New-NetFirewallRule 的参数来源）。 */
export interface FirewallRuleSpec {
  /** 规则名（dsc 前缀，PowerShell 侧用它做幂等删除）。 */
  readonly name: string
  /** 中文显示名（人看的）。 */
  readonly displayName: string
  /** 方向。 */
  readonly direction: 'Outbound' | 'Inbound'
  /** 协议。 */
  readonly protocol: 'Any' | 'TCP' | 'UDP'
  /** 远端地址字面量。 */
  readonly remoteAddresses: string
  /** 远端端口字面量；null 表示不限制（写进脚本时不带 -RemotePorts）。 */
  readonly remotePorts: string | null
}

/** 规则名前缀（doctor 与卸载逻辑都用它认 dsc 自己的规则）。 */
export const DSC_FIREWALL_RULE_PREFIX = 'dsc-sandbox-'

/**
 * 5 条防火墙规则的清单（顺序即安装顺序，见 setup.ts）。
 *
 * 为什么是这 5 条：前 4 条跟 codex 一致（出站非环回、入站非环回、环回 UDP、环回 TCP 放行代理端口），
 * 第 5 条 `block-loopback-tcp-inbound` 是 dsc 自己加的：入站那条只挡非环回来源，
 * 环回入站（宿主进程连进沙箱里监听的端口）不在覆盖范围内，这里补上，取「失败也往关闭方向倒」。
 *
 * 代理端口的放行不是靠 allow 规则：Windows 防火墙里显式 block 优先于 allow，
 * 所以放行只能表达成「block 规则的端口补集」（loopbackTcpBlockPorts）。
 */
export function firewallRuleSpecs(proxyPort: number): readonly FirewallRuleSpec[] {
  return [
    {
      name: `${DSC_FIREWALL_RULE_PREFIX}block-outbound`,
      displayName: '[dsc] 沙箱账号：阻断非环回出站',
      direction: 'Outbound',
      protocol: 'Any',
      remoteAddresses: DSC_FIREWALL_ADDRESS_NON_LOOPBACK,
      remotePorts: null,
    },
    {
      name: `${DSC_FIREWALL_RULE_PREFIX}block-inbound`,
      displayName: '[dsc] 沙箱账号：阻断非环回入站',
      direction: 'Inbound',
      protocol: 'Any',
      remoteAddresses: DSC_FIREWALL_ADDRESS_NON_LOOPBACK,
      remotePorts: null,
    },
    {
      name: `${DSC_FIREWALL_RULE_PREFIX}block-loopback-udp`,
      displayName: '[dsc] 沙箱账号：阻断环回 UDP（堵本地 DNS/解析器）',
      direction: 'Outbound',
      protocol: 'UDP',
      remoteAddresses: DSC_FIREWALL_ADDRESS_LOOPBACK,
      remotePorts: null,
    },
    {
      name: `${DSC_FIREWALL_RULE_PREFIX}block-loopback-tcp`,
      displayName: '[dsc] 沙箱账号：阻断环回 TCP（只放行代理端口）',
      direction: 'Outbound',
      protocol: 'TCP',
      remoteAddresses: DSC_FIREWALL_ADDRESS_LOOPBACK,
      remotePorts: loopbackTcpBlockPorts(proxyPort),
    },
    {
      name: `${DSC_FIREWALL_RULE_PREFIX}block-loopback-tcp-inbound`,
      displayName: '[dsc] 沙箱账号：阻断环回 TCP 入站',
      direction: 'Inbound',
      protocol: 'TCP',
      remoteAddresses: DSC_FIREWALL_ADDRESS_LOOPBACK,
      remotePorts: null,
    },
  ]
}

/** 规则名清单（doctor 逐条点名查在不在）。 */
export function firewallRuleNames(proxyPort: number): readonly string[] {
  return firewallRuleSpecs(proxyPort).map((spec) => spec.name)
}

/**
 * 环回 TCP 的阻断端口补集：除了 `proxyPort` 一个端口，其余全堵，输出成防火墙的端口区间写法。
 *
 * 例：3128 → `'1-3127,3129-65535'`；1 → `'2-65535'`；65535 → `'1-65534'`；
 * 0 → `'1-65535'`（0 不是可用代理端口，等于不留洞）。
 * 单端口区间不写成 `a-a`，跟 codex 的 port_range_string 保持一致。
 */
export function loopbackTcpBlockPorts(proxyPort: number): string {
  if (!Number.isInteger(proxyPort) || proxyPort < 0 || proxyPort > 65535) {
    throw new RangeError(`环回 TCP 端口补集：代理端口必须是 0-65535 的整数，收到 ${String(proxyPort)}`)
  }
  if (proxyPort === 0) return '1-65535'
  const ranges: string[] = []
  if (proxyPort > 1) ranges.push(portRange(1, proxyPort - 1))
  if (proxyPort < 65535) ranges.push(portRange(proxyPort + 1, 65535))
  return ranges.length === 0 ? '1-65535' : ranges.join(',')
}

/** 区间文字：首尾相同就写单个端口。 */
function portRange(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`
}
