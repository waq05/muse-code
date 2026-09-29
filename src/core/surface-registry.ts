/**
 * 快照片段注册表：界面快照里每一块「某个功能点的状态投影」由那个功能点自己登记。
 *
 * 为什么要有这一层：装配快照的那一层（transcript）原先 inject 了模式、任务面等五个服务，
 * 一行读一个功能，加一个新状态面就得回去改它。改成注册表之后，
 * 装配层只认识「注册表」这一件事，模式登记模式那一块、清单登记清单那一块。
 *
 * 读取时的两条兜底：
 *   - 生产投影抛错 → 沿用上一次的值（一个插件算错不该把整帧快照弄没）；
 *   - 没有注册者 → 该 id 在快照里缺席，界面按空处理。
 *
 * @module dsc/core/surface-registry
 */

/** 一片界面投影：id + 取当前值（每次装配快照时调用，所以不必通知谁）。 */
export interface SurfaceContribution<T = unknown> {
  id: string
  read: () => T
}

/**
 * 注册表本体：注册返回退订函数，插件卸载后下一帧快照里就没有它了。
 * 键顺序 = 注册顺序，快照里的条目因此每次装配都稳定（界面不会莫名重排）。
 *
 * @typeParam S - 这一层要产出的快照类型（dsc 里就是 `RuntimeSurfaces`）。
 *   类型参数让调用方拿到的就是那个类型本身，不必再自己转一次；代价是它得保证
 *   在第一次产帧之前把该声明的片段都登记齐——dsc 的装配顺序保证了这点：
 *   产帧的是 transcript，而它只在界面真的来取帧时才装配，那时 base 插件早就挂完了。
 */
export class SurfaceRegistry<S extends object = Record<string, unknown>> {
  private readonly contributions = new Map<string, SurfaceContribution>()
  /** id → 上一次成功算出的投影（生产函数抛错时兜底）。 */
  private readonly lastGood = new Map<string, unknown>()

  /**
   * 登记一片投影；同 id 后注册者顶掉先注册者，退订只撤自己这一份。
   * @param contribution - 这片投影的归属键与取法。
   * @returns 退订函数。
   */
  register<K extends keyof S & string>(contribution: SurfaceContribution<S[K]>): () => void {
    this.contributions.set(contribution.id, contribution as SurfaceContribution)
    this.lastGood.delete(contribution.id)
    return () => {
      if (this.contributions.get(contribution.id) === contribution) {
        this.contributions.delete(contribution.id)
        this.lastGood.delete(contribution.id)
      }
    }
  }

  /** 已登记的片段 id（按注册顺序，自检与诊断用）。 */
  get ids(): string[] {
    return [...this.contributions.keys()]
  }

  /**
   * 装配当前所有投影（注册顺序）。
   * @returns 快照要用的那一块；未登记的键缺席（界面按空处理）
   */
  build(): S {
    const out: Record<string, unknown> = {}
    for (const [id, contribution] of this.contributions) {
      try {
        const value = contribution.read()
        this.lastGood.set(id, value)
        out[id] = value
      } catch {
        // 一个功能点算崩了不该让整帧快照没了：留旧值，界面照旧画得出来。
        if (this.lastGood.has(id)) out[id] = this.lastGood.get(id)
      }
    }
    // 键就是注册时那个 K，值也是 S[K]；这里只是把「逐键登记」这个事实告诉编译器。
    return out as S
  }
}
