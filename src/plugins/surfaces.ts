/**
 * surfaces 插件：provide `surfaces` 服务——界面快照的片段注册表。
 *
 * 每个功能点把自己那块状态投影登记进来（模式登记模式、清单登记清单……），
 * 装配快照的那一层（transcript 插件）只问注册表要全部片段，不认识任何具体功能。
 * 注册表本体在 core/surface-registry.ts，这里挂成服务。
 *
 * @module dsc/plugins/surfaces
 */
import type { Plugin } from '@deepseek-ai/cordis'
import { SurfaceRegistry } from '../core/surface-registry.js'
import type { RuntimeSurfaces } from '../contract.js'
import type { SurfaceService } from '../services/types.js'

export const surfacesPlugin: Plugin.Object = {
  name: 'surfaces',
  provide: 'surfaces',
  apply(ctx) {
    const registry = new SurfaceRegistry<RuntimeSurfaces>()
    const service: SurfaceService = {
      register<K extends keyof RuntimeSurfaces>(id: K, read: () => RuntimeSurfaces[K]): () => void {
        return registry.register<K>({ id, read })
      },
      build(): RuntimeSurfaces {
        return registry.build()
      },
      get ids() {
        return registry.ids
      },
    }
    ctx.provide('surfaces', service)
  },
}
