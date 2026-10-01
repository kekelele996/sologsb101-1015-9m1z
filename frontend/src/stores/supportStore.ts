/**
 * 加固件状态管理（Pinia）—— 两侧分账
 * - 班组侧：登记加固件、登记现场检查日期（markCrewSupportChecked）
 * - 技术组侧：调整检查周期（setTechSupportCycle）
 * 两侧互不覆盖；班组检查日期走「班组 → 技术组」同步，失败按本侧重试。
 */
import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { Support, SupportDraft } from '../types/support'
import {
  initDatabase,
  isSimulateOffline,
  markCrewSupportChecked,
  putSupport,
  removeSupport,
  setMeta,
  setTechSupportCycle,
} from '../utils/db'
import { nowIso, uuid } from '../utils/id'
import { countPendingCrewRecords, reconcileAll, syncCrewToTech, type SyncResult } from '../utils/sync'

export const useSupportStore = defineStore('support', () => {
  const lastMessage = ref('')
  const revision = ref(0)
  const offline = ref(false)
  const pendingCount = ref(0)

  async function init(): Promise<void> {
    await initDatabase()
    offline.value = await isSimulateOffline()
    pendingCount.value = await countPendingCrewRecords()
    revision.value += 1
  }

  async function refreshPending(): Promise<void> {
    pendingCount.value = await countPendingCrewRecords()
  }

  /** 切换「模拟离线」：离线时班组 → 技术组同步会失败（演示按本侧重试） */
  async function setOffline(value: boolean): Promise<void> {
    offline.value = value
    await setMeta('simulateOffline', value ? 'true' : 'false')
    lastMessage.value = value ? '已模拟技术组台账离线：班组记录会保留在本侧并标记失败' : '已恢复与技术组台账的连接'
  }

  /** 登记新加固件：共享登记信息 + 两侧初值（周期归技术组、检查日期归班组） */
  async function createSupport(draft: SupportDraft): Promise<Support> {
    const stamp = nowIso()
    const row: Support = {
      id: uuid('support'),
      treeId: draft.treeId,
      type: draft.type,
      installDate: draft.installDate,
      checkCycleMon: draft.checkCycleMon,
      lastCheckDate: draft.lastCheckDate,
      techCheckDate: draft.lastCheckDate,
      owner: 'crew',
      crewUpdatedAt: stamp,
      techAckAt: stamp,
      syncState: 'synced',
      lastSyncAt: stamp,
      syncError: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    }
    await putSupport(row)
    revision.value += 1
    lastMessage.value = `已登记 ${row.type}：周期由技术组核定，检查日期记入班组台账`
    return row
  }

  /** 班组：登记本次现场检查（只写班组侧，不动周期；新值待同步） */
  async function markChecked(id: string, date: string): Promise<void> {
    await markCrewSupportChecked(id, date)
    revision.value += 1
    await refreshPending()
    lastMessage.value = '班组已登记本次现场检查，等待同步到技术组台账'
  }

  /** 技术组：调整检查周期（只写技术组侧，不动班组检查日期） */
  async function updateCycle(id: string, checkCycleMon: number): Promise<void> {
    await setTechSupportCycle(id, checkCycleMon)
    revision.value += 1
    lastMessage.value = '技术组已更新检查周期，班组已登记的现场检查记录不受影响'
  }

  async function deleteSupport(id: string): Promise<void> {
    await removeSupport(id)
    revision.value += 1
    await refreshPending()
  }

  /** 班组 → 技术组：推送全部待同步 / 失败记录 */
  async function syncToTech(): Promise<SyncResult> {
    const result = await syncCrewToTech()
    await refreshPending()
    revision.value += 1
    if (result.offline) {
      lastMessage.value = '技术组台账暂不可达，记录已保留在班组侧，连接恢复后可重试'
    } else {
      lastMessage.value = `同步完成：推送 ${result.pushed} 条，发现两侧不一致 ${result.discrepancies} 条`
    }
    return result
  }

  /** 全量重新对账（扫描两侧检查日期不一致的加固件） */
  async function reconcile(): Promise<number> {
    const opened = await reconcileAll()
    await refreshPending()
    revision.value += 1
    lastMessage.value = opened > 0 ? `重新对账发现 ${opened} 条两侧不一致，已挂到对账页等人裁定` : '两侧台账核对一致'
    return opened
  }

  return {
    lastMessage,
    revision,
    offline,
    pendingCount,
    init,
    refreshPending,
    setOffline,
    createSupport,
    markChecked,
    updateCycle,
    deleteSupport,
    syncToTech,
    reconcile,
  }
})
