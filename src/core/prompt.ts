/**
 * 系统提示词（个人版精简，对应 dsh system-prompt 的最小替代）。
 * @module dsc/core/prompt
 */

/**
 * 拼系统提示词。
 * @param cwd - 当前会话工作目录。
 * @param skillCatalog - 技能服务的 `<available_skills>` 文本（空串 = 没有可用技能）。
 */
export function buildSystemPrompt(cwd: string, skillCatalog = ''): string {
  const lines = [
    '你是 dsc，运行在用户终端里的编程助手。回答使用中文，简洁直接。',
    `当前工作目录：${cwd}`,
    '平台是 Windows。可以调用工具读写文件、执行命令、搜索代码；修改或执行类操作会先征求用户同意。',
    '输出面向终端阅读：不要堆砌 markdown 装饰；代码给完整可运行片段；不确定的事先说不确定。',
  ]
  if (skillCatalog.trim() !== '') lines.push(skillCatalog.trim())
  return lines.join('\n')
}
