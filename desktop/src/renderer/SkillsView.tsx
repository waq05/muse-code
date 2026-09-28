/**
 * 技能中心：左栏「技能」页与设置面板的「技能」分区共用本组件。
 *
 * 两个 tab：
 * - 已安装：本地扫出来的技能（含插件贡献的虚拟技能），可启停、看正文、从磁盘导入；
 * - 市场：从配置的市场源（默认 anthropics/skills 与本仓库 .agents/skills）浏览并安装。
 *
 * 数据全部经 RuntimeProxy 走宿主（技能发现、启停、市场抓取都在宿主进程里）。
 *
 * @module desktop/renderer/SkillsView
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  MarketBrowseResult,
  MarketSkillView,
  MarketSource,
  SkillDetail,
  SkillInfoView,
} from '@dsc/runtime/contract.js'
import { dsc, type RuntimeProxy } from './bridge.js'
import { IconBolt, IconFolder, IconPlus, IconRefresh, IconSearch, IconStore } from './icons.js'

/** 来源徽章（用户主目录最常见，不显示；其余说明技能从哪来）。 */
const SOURCE_LABELS: Record<string, string> = {
  'project-dsc': '本项目 .dsc/skills',
  'project-agents': '本项目 .agents/skills',
  custom: '自定义目录',
  'user-dsc': '',
}

/** 面板内反馈：成功一句话自动消失，失败留着直到下次操作。 */
interface Note {
  kind: 'ok' | 'error'
  text: string
}

export function SkillsView(props: { proxy: RuntimeProxy; embedded?: boolean }): JSX.Element {
  // 自检钩子：?skillstab=market 直接进市场 tab（截图脚本不用模拟点击）
  const [tab, setTab] = useState<'installed' | 'market'>(() =>
    new URLSearchParams(location.search).get('skillstab') === 'market' ? 'market' : 'installed',
  )
  const [skills, setSkills] = useState<SkillInfoView[]>([])
  const [skillsError, setSkillsError] = useState('')
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [market, setMarket] = useState<MarketBrowseResult | null>(null)
  const [marketSource, setMarketSource] = useState('')
  const [marketLoading, setMarketLoading] = useState(false)
  const [installing, setInstalling] = useState('')
  const [sourcesEditing, setSourcesEditing] = useState(false)
  const [sourcesText, setSourcesText] = useState('')

  const show = (next: Note | null): void => setNote(next)
  const embedded = props.embedded === true

  const reloadSkills = (): void => {
    void props.proxy
      .listSkills()
      .then((list) => {
        setSkills(list)
        setSkillsError('')
      })
      .catch((error: unknown) => setSkillsError(text(error)))
  }

  const browse = (source: string, refresh: boolean): void => {
    setMarketLoading(true)
    void props.proxy
      .browseMarket(source)
      .then((result) => {
        setMarket(result)
        setMarketSource(result.source)
        // 浏览失败同时是刷新失败：把原因挂在源上显示
        if (result.error !== undefined) show({ kind: 'error', text: result.error })
        else if (refresh) show({ kind: 'ok', text: `已从 ${result.source} 取回 ${result.items.length} 个技能` })
        else maybeAutoInstall()
      })
      .catch((error: unknown) => show({ kind: 'error', text: text(error) }))
      .finally(() => setMarketLoading(false))
  }

  useEffect(() => {
    reloadSkills()
  }, [])

  useEffect(() => {
    if (tab === 'market' && market === null && !marketLoading) browse('', false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return skills
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle) ||
        (skill.whenToUse ?? '').toLowerCase().includes(needle),
    )
  }, [skills, query])

  const marketFiltered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const items = market?.items ?? []
    if (needle === '') return items
    return items.filter(
      (item) => item.name.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle),
    )
  }, [market, query])

  const toggle = (skill: SkillInfoView): void => {
    const next = !skill.enabled
    setSkills((current) => current.map((item) => (item.name === skill.name ? { ...item, enabled: next } : item)))
    void props.proxy
      .setSkillEnabled(skill.name, next)
      .then((result) => {
        if (!result.ok) show({ kind: 'error', text: result.error })
        else show(result.notice === undefined ? null : { kind: 'ok', text: result.notice })
        reloadSkills()
      })
      .catch((error: unknown) => {
        show({ kind: 'error', text: text(error) })
        reloadSkills()
      })
  }

  const openDetail = (skill: SkillInfoView): void => {
    if (detail?.name === skill.name) {
      setDetail(null)
      return
    }
    void props.proxy
      .readSkill(skill.name)
      .then((result) => {
        if (!result.ok) show({ kind: 'error', text: result.error })
        else setDetail(result.skill)
      })
      .catch((error: unknown) => show({ kind: 'error', text: text(error) }))
  }

  const importSkill = (): void => {
    void dsc.installSkill().then((names) => {
      if (names.length === 0) return
      show({ kind: 'ok', text: `已导入 ${names.join('、')}` })
      reloadSkills()
    })
  }

  const install = (item: MarketSkillView): void => {
    setInstalling(`${item.source}/${item.name}`)
    void props.proxy
      .installMarketSkill(item.source, item.name)
      .then((result) => {
        if (!result.ok) show({ kind: 'error', text: result.error })
        else {
          show({ kind: 'ok', text: result.notice ?? `已安装 ${item.name}` })
          reloadSkills()
          setMarket((current) =>
            current === null
              ? current
              : {
                  ...current,
                  items: current.items.map((entry) =>
                    entry.name === item.name && entry.source === item.source ? { ...entry, installed: true } : entry,
                  ),
                },
          )
        }
      })
      .catch((error: unknown) => show({ kind: 'error', text: text(error) }))
      .finally(() => setInstalling(''))
  }

  // 自检钩子：?skillinstall=<源>/<名字> 时，市场清单到手后自动装一次（验证网络抓取与落盘）
  const autoInstall = useRef(new URLSearchParams(location.search).get('skillinstall'))
  const maybeAutoInstall = (): void => {
    const raw = autoInstall.current
    if (raw === null) return
    autoInstall.current = null
    const slash = raw.indexOf('/')
    if (slash <= 0) return
    const source = raw.slice(0, slash)
    const name = raw.slice(slash + 1)
    setInstalling(`${source}/${name}`)
    void props.proxy
      .installMarketSkill(source, name)
      .then((result) => {
        show(result.ok ? { kind: 'ok', text: result.notice ?? `已安装 ${name}` } : { kind: 'error', text: result.error })
        reloadSkills()
      })
      .catch((error: unknown) => show({ kind: 'error', text: text(error) }))
      .finally(() => setInstalling(''))
  }

  const saveSources = (): void => {
    const sources: MarketSource[] = sourcesText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => {
        const [name, url] = line.split(/[,，\t ]+/)
        return { name: (name ?? '').trim(), url: (url ?? '').trim() }
      })
      .filter((source) => source.name !== '' && source.url !== '')
    if (sources.length === 0) {
      show({ kind: 'error', text: '至少写一行：源名, 仓库地址' })
      return
    }
    void props.proxy
      .setMarketSources(sources)
      .then((result) => {
        if (!result.ok) show({ kind: 'error', text: result.error })
        else {
          show({ kind: 'ok', text: result.notice ?? '市场源已保存' })
          setSourcesEditing(false)
          setMarket(null)
          browse(sources[0]?.name ?? '', false)
        }
      })
      .catch((error: unknown) => show({ kind: 'error', text: text(error) }))
  }

  const installedNames = new Set(skills.map((skill) => skill.name))

  return (
    <div className={`skills${embedded ? ' embedded' : ''}`}>
      <div className={`skills-head${embedded ? ' compact' : ''}`}>
        {embedded ? (
          <p className="skills-head-note">
            本机技能来自 <code>~/.dsc/skills</code> 与项目的 <code>.dsc/skills</code>，插件贡献的来源也列在这里
          </p>
        ) : (
          <div>
            <h1>技能</h1>
            <p>可复用的操作手册：模型按需读取，用户用 /技能名 直接调用</p>
          </div>
        )}
        <div className="skills-actions">
          <button className="icon-btn" title="重新扫描技能目录" onClick={reloadSkills}>
            <IconRefresh size={16} />
          </button>
          <button className="btn-primary" title="从磁盘导入：选含 SKILL.md 的目录或 .md 文件" onClick={importSkill}>
            <IconPlus size={14} /> 导入技能
          </button>
        </div>
      </div>

      <div className="skills-tabs">
        <button className={tab === 'installed' ? 'on' : ''} onClick={() => setTab('installed')}>
          <IconBolt size={14} /> 已安装 <span className="count">{skills.length}</span>
        </button>
        <button className={tab === 'market' ? 'on' : ''} onClick={() => setTab('market')}>
          <IconStore size={14} /> 市场 <span className="count">{market?.items.length ?? 0}</span>
        </button>
        <div className="skills-search">
          <IconSearch size={14} />
          <input
            placeholder={tab === 'installed' ? '搜索本机技能' : '搜索市场技能'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {note !== null && <div className={`settings-note ${note.kind}`}>{note.text}</div>}

      {tab === 'installed' ? (
        <div className="skills-list">
          {skillsError !== '' && <div className="settings-note error">扫描失败：{skillsError}</div>}
          {skills.length === 0 && skillsError === '' && (
            <div className="plugins-empty">
              还没有技能。把 <code>&lt;名字&gt;/SKILL.md</code> 放进 <code>~/.dsc/skills/</code> 或项目的{' '}
              <code>.dsc/skills</code>，或点右上「导入技能」、去「市场」tab 安装。
            </div>
          )}
          {filtered.map((skill) => (
            <div className={`skill-row${skill.enabled ? '' : ' off'}`} key={`${skill.source}/${skill.name}`}>
              <div className="skill-icon">
                <IconBolt size={15} />
              </div>
              <div className="skill-info">
                <div className="skill-name">
                  <span className="skill-title">
                    <span className="slash">/</span>
                    {skill.name}
                  </span>
                  {skill.source !== 'user-dsc' && SOURCE_LABELS[skill.source] !== undefined && (
                    <span className="tag">{SOURCE_LABELS[skill.source]}</span>
                  )}
                  {!skill.modelInvocable && <span className="tag">仅手动</span>}
                </div>
                <div className={`skill-desc${skill.problem !== undefined ? ' problem' : ''}`}>
                  {skill.problem !== undefined ? `⚠ ${skill.problem}` : skill.description}
                </div>
                {skill.whenToUse !== undefined && <div className="skill-when">何时用：{skill.whenToUse}</div>}
                <div className="skill-links">
                  <button className="text-btn" onClick={() => openDetail(skill)}>
                    {detail?.name === skill.name ? '收起正文' : '看正文'}
                  </button>
                  {skill.path !== undefined && (
                    <>
                      <button
                        className="text-btn"
                        title={skill.path}
                        onClick={() => {
                          void dsc.openPath(skill.path ?? '').then((problem) => {
                            if (problem !== '') show({ kind: 'error', text: `打开失败：${problem}` })
                          })
                        }}
                      >
                        <IconFolder size={13} /> 打开所在目录
                      </button>
                      <span className="mono skill-path">{skill.path}</span>
                    </>
                  )}
                </div>
                {detail !== null && detail.name === skill.name && (
                  <pre className="skill-body">{detail.content}</pre>
                )}
              </div>
              <button
                className={`switch${skill.enabled ? ' on' : ''}${skill.toggleable ? '' : ' locked'}`}
                role="switch"
                aria-checked={skill.enabled}
                title={
                  skill.toggleable
                    ? skill.enabled
                      ? '停用（不再进入模型目录，命令也摘掉）'
                      : '启用'
                    : '由插件提供，不能在技能中心启停'
                }
                onClick={() => {
                  if (skill.toggleable) toggle(skill)
                }}
              />
            </div>
          ))}
          {skills.length > 0 && filtered.length === 0 && (
            <div className="plugins-empty">没有匹配「{query}」的技能。</div>
          )}
        </div>
      ) : (
        <div className="skills-list">
          <div className="market-sources">
            {(market?.sources ?? []).map((source) => (
              <button
                key={source.name}
                className={`source-chip${source.name === marketSource ? ' on' : ''}${source.ok ? '' : ' bad'}`}
                title={source.ok ? source.url : `${source.url}\n${source.error ?? ''}`}
                onClick={() => browse(source.name, false)}
              >
                {source.name}
              </button>
            ))}
            <button
              className="text-btn"
              onClick={() => {
                const next = !sourcesEditing
                setSourcesEditing(next)
                if (next) {
                  setSourcesText(
                    (market?.sources ?? [])
                      .map((source) => `${source.name}, ${source.url}`)
                      .join('\n'),
                  )
                }
              }}
            >
              {sourcesEditing ? '收起' : '编辑源'}
            </button>
            <button className="text-btn" onClick={() => browse(marketSource, true)} disabled={marketLoading}>
              <IconRefresh size={13} /> {marketLoading ? '抓取中…' : '刷新'}
            </button>
          </div>

          {sourcesEditing && (
            <div className="market-edit">
              <textarea
                className="setting-input mono tall"
                rows={3}
                value={sourcesText}
                placeholder={'anthropics, https://github.com/anthropics/skills/tree/main/skills\ndsh, https://github.com/deepseek-ai/deepseek-harness/tree/master/.agents/skills'}
                onChange={(event) => setSourcesText(event.target.value)}
              />
              <div className="market-edit-hint">
                一行一个源：名字, GitHub 仓库地址（或返回 index.json 清单的地址）
              </div>
              <button className="btn-primary" onClick={saveSources}>
                保存市场源
              </button>
            </div>
          )}

          {marketLoading && market === null && <div className="settings-empty">正在抓取市场清单…</div>}
          {market?.error !== undefined && market.items.length === 0 && (
            <div className="settings-note error">
              {market.error}
              <button className="text-btn" onClick={() => browse(marketSource, true)}>
                重试
              </button>
            </div>
          )}
          {marketFiltered.map((item) => (
            <div className="market-row" key={`${item.source}/${item.name}`}>
              <div className="skill-icon store">
                <IconStore size={15} />
              </div>
              <div className="skill-info">
                <div className="skill-name">
                  {item.name}
                  <span className="tag">{item.source}</span>
                  {item.version !== undefined && <span className="tag">v{item.version}</span>}
                </div>
                <div className="skill-desc">{item.description}</div>
              </div>
              <button
                className={`btn-primary market-install${item.installed ? ' done' : ''}`}
                disabled={installing === `${item.source}/${item.name}`}
                onClick={() => install(item)}
              >
                {installing === `${item.source}/${item.name}`
                  ? '安装中…'
                  : item.installed || installedNames.has(item.name)
                    ? '已安装'
                    : '安装'}
              </button>
            </div>
          ))}
          {(market?.items.length ?? 0) > 0 && marketFiltered.length === 0 && (
            <div className="plugins-empty">这个源里没有匹配「{query}」的技能。</div>
          )}
          {(market?.items.length ?? 0) === 0 && market?.error === undefined && !marketLoading && (
            <div className="plugins-empty">这个源没有解析出技能。检查地址是否指向一个 GitHub 仓库或 index.json。</div>
          )}
        </div>
      )}

      <div className="skills-foot">
        模型只能看到技能的名字和一句话说明；正文要点开后由模型自己取用，不常驻上下文。
      </div>
    </div>
  )
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
