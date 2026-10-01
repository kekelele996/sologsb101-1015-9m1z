/**
 * 对账与发件箱状态管理（Pinia）
 * - 订阅两边对账待裁定条目（recon）与班组同步发件箱（sync_outbox）。
 * - 提供裁定（采用班组 / 采用技术组）与按本侧重试动作。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { OutboxItem, ReconItem, ReconResolution } from '../types/recon'
import { initDatabase, listOutbox, listRecon } from '../utils/db'
import { reconcile, resolveReconItem, retryTeamOutbox } from '../utils/sync'

export const useReconStore = defineStore('recon', () => {
  const reconItems = ref<ReconItem[]>([])
  const outbox = ref<OutboxItem[]>([])
  const lastMessage = ref('')
  const ready = ref(false)

  const pendingRecon = computed<ReconItem[]>(() => reconItems.value.filter((item) => item.status === 'pending'))
  const resolvedRecon = computed<ReconItem[]>(() => reconItems.value.filter((item) => item.status === 'resolved'))
  const failedOutbox = computed<OutboxItem[]>(() =>
    outbox.value.filter((item) => item.status === 'pending' || item.status === 'failed')
  )

  async function init(): Promise<void> {
    await initDatabase()
    // 首屏先跑一次对账（已有数据迁移到两边后立即对账），再订阅
    await reconcile()
    liveQuery(async () => ({
      recon: await listRecon(),
      outbox: await listOutbox(),
    })).subscribe({
      next: ({ recon, outbox: outboxRows }) => {
        reconItems.value = recon
        outbox.value = outboxRows
        ready.value = true
      },
      error: () => {
        ready.value = true
      },
    })
  }

  /** 手动触发一次两边对账 */
  async function runReconcile(): Promise<void> {
    const count = await reconcile()
    lastMessage.value = count === 0 ? '两边对账完成，没有对不上的记录' : `两边对账完成，${count} 条待裁定已摆到档案页`
  }

  /** 裁定待条目：采用班组现场 / 采用技术组定级 */
  async function resolve(id: string, resolution: ReconResolution): Promise<void> {
    await resolveReconItem(id, resolution)
    lastMessage.value = resolution === 'team' ? '已裁定采用班组现场，并请技术组复评' : '已裁定采用技术组定级'
  }

  /** 班组侧同步失败后按本侧重试（只重放本方字段，不退回技术组已定字段） */
  async function retryOutbox(): Promise<void> {
    const count = await retryTeamOutbox()
    lastMessage.value = count === 0 ? '没有需要重试的班组同步' : `已按本侧重试 ${count} 条班组同步，技术组已定字段未退回`
  }

  return {
    reconItems,
    outbox,
    lastMessage,
    ready,
    pendingRecon,
    resolvedRecon,
    failedOutbox,
    init,
    runReconcile,
    resolve,
    retryOutbox,
  }
})
