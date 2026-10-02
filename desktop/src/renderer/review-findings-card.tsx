/**
 * /review findings 卡（T18）：审查队友交回的 `<review-findings>` 汇报在会话流里的
 * 展示形态——按条渲染（优先级徽标 + 标题 + 位置 + 说明 + 建议），位置可点开文件
 * 预览并定位到行（右侧栏 preview 页签的行号跳转）。
 *
 * 解析在 review-findings.ts（零依赖纯模块，探针直测）；本组件只管画。
 *
 * @module dsc/renderer/review-findings-card
 */
import type { JSX } from 'react'
import { IconSearch } from './icons.js'
import { joinPath } from './file-util.js'
import type { ReviewFinding, ReviewFindingsDoc } from './review-findings.js'

/** 优先级徽标的文案与色档（P1 用最重的警示色，档位递减）。 */
const PRIORITY_LABEL: Record<ReviewFinding['priority'], string> = { P1: 'P1 必须修', P2: 'P2 应该修', P3: 'P3 可更好' }

export function ReviewFindingsCard(props: {
  doc: ReviewFindingsDoc
  cwd: string
  onOpenFile?: (path: string, line?: number) => void
}): JSX.Element {
  const { doc } = props
  const open = (path: string, line?: number): void => {
    if (props.onOpenFile === undefined) return
    // 位置写的是仓库相对路径；已是绝对路径（模型偶尔写全）就直接用
    const abs = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') ? path : joinPath(props.cwd, path)
    props.onOpenFile(abs, line)
  }
  return (
    <div className="review-findings" data-review-findings>
      <div className="review-findings-head">
        <IconSearch size={15} />
        <span className="review-findings-title">代码审查 · {doc.teammate === '' ? '审查队友' : doc.teammate}</span>
        {doc.state !== undefined && <span className="review-findings-state">{doc.state}</span>}
      </div>
      {doc.trailing !== '' && <p className="review-findings-note">{doc.trailing}</p>}
      {doc.findings.length > 0 && (
        <ul className="review-findings-list">
          {doc.findings.map((finding, index) => (
            <li key={index} className="review-finding" data-priority={finding.priority}>
              <div className="review-finding-head">
                <span className="review-finding-badge">{PRIORITY_LABEL[finding.priority]}</span>
                <span className="review-finding-title">{finding.title}</span>
              </div>
              {finding.location !== undefined && (
                <button
                  type="button"
                  className="review-finding-loc"
                  title={finding.location.line === undefined ? '打开文件预览' : `打开 ${finding.location.path}:${String(finding.location.line)}`}
                  onClick={() => open(finding.location!.path, finding.location!.line)}
                >
                  {finding.location.path}
                  {finding.location.line !== undefined && <span className="review-finding-line">:{String(finding.location.line)}</span>}
                </button>
              )}
              {finding.detail !== '' && <p className="review-finding-detail">{finding.detail}</p>}
              {finding.suggestion !== undefined && finding.suggestion !== '' && (
                <p className="review-finding-suggest">建议：{finding.suggestion}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
