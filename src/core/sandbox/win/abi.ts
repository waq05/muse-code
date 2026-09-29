/**
 * Win32 ABI 常量与 x64 结构体布局（全手工字节，不依赖 koffi 结构体）。
 *
 * 为什么手工打包：dsh 的同类实现实证过——koffi 的结构体对联合体/内联 SID 支持不牢，
 * 且这些布局是一次性学完的固定知识。所有偏移按 x64 对齐，来源逐一注明；
 * 移植到 ARM64 时必须重新核对（照 dsh 的 abi-probe.cpp 验法）。
 *
 * @module dsc/core/sandbox/win/abi
 */

// ── 令牌 ────────────────────────────────────────────────────────────────────

/** OpenProcessToken 要的权限：ASSIGN_PRIMARY|DUPLICATE|QUERY|ADJUST_DEFAULT。 */
export const TOKEN_ACCESS = 0x0001 | 0x0002 | 0x0008 | 0x0080
/** OpenProcess 要的权限：PROCESS_QUERY_INFORMATION。 */
export const PROCESS_QUERY_INFORMATION = 0x0400

/** GetTokenInformation 信息类：组列表。 */
export const TokenGroups = 2
/** GetTokenInformation 信息类：默认 DACL。 */
export const TokenDefaultDacl = 6
/** GetTokenInformation 信息类：完整性级别。 */
export const TokenIntegrityLevel = 25

/** CreateRestrictedToken 标志：禁用全部特权 + 合成受限用户 + 仅写受限（pass-2 只管写）。 */
export const CREATE_RESTRICTED_FLAGS = 0x1 | 0x4 | 0x8

/** 组属性：登录会话 SID 的标记（含 enabled/mandatory 位，比较时取高两位）。 */
export const SE_GROUP_LOGON_ID = 0xc0000000
/** 强制标签 ACE 的属性位。 */
export const SE_GROUP_INTEGRITY = 0x20

/** WellKnownSidType：Everyone（S-1-1-0）。 */
export const WinWorldSid = 1
/** WellKnownSidType：低完整性标签（S-1-16-4096）。 */
export const WinLowLabelSid = 66

/** SID 缓冲区的安全上限（最大 68 字节）。 */
export const SID_MAX_BYTES = 68
/** SID_AND_ATTRIBUTES 在 x64 上的步长（指针 8 + uint32 4 + 补齐 4）。 */
export const SID_AND_ATTRIBUTES_SIZE = 16

// ── 访问掩码 ────────────────────────────────────────────────────────────────

export const DELETE = 0x00010000
export const READ_CONTROL = 0x00020000
export const WRITE_DAC = 0x00040000
export const WRITE_OWNER = 0x00080000
/** FILE_GENERIC_WRITE（SYNCHRONIZE|READ_CONTROL|append|write_data|write_attr|write_ea）。 */
export const FILE_GENERIC_WRITE = 0x120116
/** FILE_GENERIC_READ（SYNCHRONIZE|READ_CONTROL|read_data|read_attr|read_ea）。 */
export const FILE_GENERIC_READ = 0x120089
/** FILE_GENERIC_EXECUTE（SYNCHRONIZE|READ_CONTROL|execute|read_attr|read_ea... 掩码 0x1200A0）。 */
export const FILE_GENERIC_EXECUTE = 0x1200a0
/** 目录上的「删除子项」位。 */
export const FILE_DELETE_CHILD = 0x00000040
/** STANDARD_RIGHTS_WRITE = READ_CONTROL。 */
export const STANDARD_RIGHTS_WRITE = READ_CONTROL
/** STANDARD_RIGHTS_REQUIRED（DELETE|READ_CONTROL|WRITE_DAC|WRITE_OWNER|SYNCHRONIZE）。 */
export const STANDARD_RIGHTS_REQUIRED = 0x000f0000
/** FILE_ALL_ACCESS（能力 SID 默认 DACL ACE 用）。 */
export const FILE_ALL_ACCESS = STANDARD_RIGHTS_REQUIRED | 0x1ff

/**
 * 可写根授权掩码 = (FILE_GENERIC_WRITE|DELETE|FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE。
 *
 * 三处刻意：带上 DELETE 与 FILE_DELETE_CHILD（沙箱里要能删自己创建的东西）；
 * 剥掉 READ_CONTROL（标准写本就带，剥掉避免与 deny 语义纠缠）；
 * 刻意**不带** WRITE_DAC/WRITE_OWNER——被沙箱的进程不许改 ACL 或夺所有权。
 */
export const GRANT_MASK = (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE

// ── ACL / ACE ───────────────────────────────────────────────────────────────

export const ACL_REVISION = 2
/** ACE 类型：允许。 */
export const ACCESS_ALLOWED_ACE_TYPE = 0x00
/** ACE 类型：拒绝。 */
export const ACCESS_DENIED_ACE_TYPE = 0x01
/** ACE 类型：强制标签。 */
export const SYSTEM_MANDATORY_LABEL_ACE_TYPE = 0x11
/** ACE 继承：子对象（文件）。 */
export const OBJECT_INHERIT_ACE = 0x01
/** ACE 继承：子容器（目录）。 */
export const CONTAINER_INHERIT_ACE = 0x02
/** 强制标签策略：低完整性不可写上来。 */
export const SYSTEM_MANDATORY_LABEL_NO_WRITE_UP = 0x01

/** SECURITY_INFORMATION：DACL。 */
export const DACL_SECURITY_INFORMATION = 0x00000004
/** SECURITY_INFORMATION：强制标签（SACL 的一部分）。 */
export const LABEL_SECURITY_INFORMATION = 0x00000010
/** SetNamedSecurityInfoW / GetNamedSecurityInfoW 的对象类型：文件或目录。 */
export const SE_FILE_OBJECT = 1

/** EXPLICIT_ACCESS 的模式。 */
export const GRANT_ACCESS = 2
export const DENY_ACCESS = 3
export const REVOKE_ACCESS = 4

/** TrusteeForm：ptstrName 是 SID 字节。 */
export const TRUSTEE_IS_SID = 0
/** TrusteeType：不指名类型。 */
export const TRUSTEE_IS_UNKNOWN = 0
/** TrusteeType：内置已知组（Everyone 用）。 */
export const TRUSTEE_IS_WELL_KNOWN_GROUP = 5

/** EXPLICIT_ACCESS_W 在 x64 上共 48 字节。 */
export const EXPLICIT_ACCESS_SIZE = 48
/** EXPLICIT_ACCESS_W 字段偏移（x64 对齐；TRUSTEE 从 16 开始）。 */
export const EA_OFFSETS = {
  grfAccessPermissions: 0,
  grfAccessMode: 4,
  grfInheritance: 8,
  pMultipleTrustee: 16,
  MultipleTrusteeOperation: 24,
  TrusteeForm: 28,
  TrusteeType: 32,
  ptstrName: 40,
} as const

/** ACL 头里的 ACE 数量偏移（AclRevision@0, Sbz1@2, AclSize@2, AceCount@4）。 */
export const ACL_ACE_COUNT_OFFSET = 4
/** 第一条 ACE 在 ACL 里的偏移。 */
export const ACL_FIRST_ACE_OFFSET = 8
/** ACCESS_ALLOWED/DENIED_ACE 的掩码偏移（头 4 字节后）。 */
export const ACE_MASK_OFFSET = 4
/** 各类 ACE 的内联 SID 偏移（头 4 + 掩码 4）。 */
export const ACE_SID_OFFSET = 8

// ── 进程创建 ────────────────────────────────────────────────────────────────

/** 挂起创建：先塞进 Job 再放行，杜绝「杀树前先跑起来」的窗口。 */
export const CREATE_SUSPENDED = 0x00000004
export const STARTF_USESTDHANDLES = 0x00000100
export const STARTF_USESHOWWINDOW = 0x00000001
export const SW_HIDE = 0

/**
 * STARTUPINFOW 在 x64 上 104 字节（13 个 4 字节字段对齐到 8 后接三个句柄）。
 * 注意 dwFlags 在 60 而不是 44——前三个指针字段把布局顶开了。
 */
export const STARTUPINFOW_SIZE = 104
export const SI_OFFSETS = {
  cb: 0,
  dwFlags: 60,
  wShowWindow: 64,
  hStdInput: 80,
  hStdOutput: 88,
  hStdError: 96,
} as const

/** PROCESS_INFORMATION 在 x64 上 24 字节。 */
export const PROCESS_INFORMATION_SIZE = 24
export const PI_OFFSETS = {
  hProcess: 0,
  hThread: 8,
  dwProcessId: 16,
  dwThreadId: 20,
} as const

// ── Job Object ──────────────────────────────────────────────────────────────

/** JobObjectExtendedLimitInformation 信息类。 */
export const JobObjectExtendedLimitInformation = 9
/** 最后一个 Job 句柄关闭时终止全部成员：父进程死 = 子树死。 */
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION 在 x64 上 144 字节，LimitFlags 在 16。 */
export const JOBOBJECT_EXTENDED_LIMIT_SIZE = 144
export const JOBOBJ_LIMIT_FLAGS_OFFSET = 16

// ── 账号登录（网络第二级：runner 以专用离线账号跑命令）────────────────────────

/** LogonUserW 的登录类型：交互式。 */
export const LOGON32_LOGON_INTERACTIVE = 2
/** LogonUserW 的提供者：默认。 */
export const LOGON32_PROVIDER_DEFAULT = 0

// ── 等待与错误 ──────────────────────────────────────────────────────────────

export const WAIT_OBJECT_0 = 0
export const WAIT_TIMEOUT = 0x00000102
export const INFINITE = 0xffffffff
/** 进程还活着的探测退出码。 */
export const STILL_ACTIVE = 259

export const ERROR_BROKEN_PIPE = 109
export const ERROR_NO_DATA = 232
export const ERROR_INSUFFICIENT_BUFFER = 122
export const ERROR_INVALID_PARAMETER = 87
export const ERROR_ACCESS_DENIED = 5
export const ERROR_LOGON_FAILURE = 1326
export const ERROR_ACCOUNT_DISABLED = 1331
export const ERROR_NONE_MAPPED = 1332

// ── 锁文件 ──────────────────────────────────────────────────────────────────

export const GENERIC_READ = 0x80000000
export const GENERIC_WRITE = 0x40000000
export const OPEN_EXISTING = 3
export const OPEN_ALWAYS = 4
export const FILE_SHARE_READ = 0x00000001
export const FILE_SHARE_WRITE = 0x00000002
/** 刻意不带 FILE_SHARE_DELETE：防别人把锁文件换掉（照 dsh）。 */
export const FILE_ATTRIBUTE_NORMAL = 0x80
export const LOCKFILE_FAIL_IMMEDIATELY = 0x00000001
export const LOCKFILE_EXCLUSIVE_LOCK = 0x00000002
/** LockFileEx 的 OVERLAPPED 在 x64 上 32 字节（koffi 3.1.1 传 NULL 会崩，给零块）。 */
export const OVERLAPPED_SIZE = 32
