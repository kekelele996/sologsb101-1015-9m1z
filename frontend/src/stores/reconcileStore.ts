/**
 * 两侧对账状态管理（Pinia）
 * 订阅 discrepancies 表：班组与技术组对不上的记录摆到这里，
 * 写清古树编号 / 字段 / 两侧取值，待人裁定；裁定后按所选侧对齐并结案。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { LedgerDiscrepancy } from '../types/ledger'
import { db, initDatabase } from '../utils/db'
import { resolveDiscrepancy } from '../utils/sync'

let subscribed = false

export const useReconcileStore = defineStore('reconcile', () => {
  const discrepancies = ref<LedgerDiscrepancy[]>([])
  const ready = ref(false)

  const pending = computed<LedgerDiscrepancy[]>(() =>
    discrepancies.value.filter((row) => row.status === 'pending')
  )
  const resolved = computed<LedgerDiscrepancy[]>(() =>
    discrepancies.value.filter((row) => row.status !== 'pending')
  )

  async function init(): Promise<void> {
    await initDatabase()
    if (!subscribed) {
      subscribed = true
      liveQuery(() => db.discrepancies.toArray()).subscribe({
        next: (rows) => {
          discrepancies.value = [...rows].sort((a, b) => {
            if (a.status !== b.status) return a.status === 'pending' ? -1 : 1
            return b.foundAt.localeCompare(a.foundAt)
          })
          ready.value = true
        },
        error: () => {
          ready.value = true
        },
      })
    }
  }

  /** 裁定：以班组值或技术组值结案 */
  async function resolve(
    discrepancy: LedgerDiscrepancy,
    choice: 'resolved-crew' | 'resolved-tech',
    note = ''
  ): Promise<string> {
    const result = await resolveDiscrepancy(discrepancy, choice, note)
    return result.message
  }

  return { discrepancies, ready, pending, resolved, init, resolve }
})
