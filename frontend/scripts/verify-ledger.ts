/**
 * 两侧分账规则的运行时验证（Node + fake-indexeddb，非生产代码）。
 * 直接跑：npx vite-node scripts/verify-ledger.ts
 */
import 'fake-indexeddb/auto'
import {
  db,
  initDatabase,
  listSupports,
  listReviews,
  listSurveys,
  markCrewSupportChecked,
  setTechSupportCycle,
  getMeta,
  setMeta,
  removeTree,
} from '../src/utils/db'
import { syncCrewToTech, reconcileAll, resolveDiscrepancy, hasPendingCrewRecords } from '../src/utils/sync'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures += 1
    console.error(`  ✗ ${msg}`)
  }
}

async function resetDb(): Promise<void> {
  if (db.isOpen()) db.close()
  indexedDB.deleteDatabase('gbheritagetree')
  await db.open()
}

async function main(): Promise<void> {
  /* ---------- 场景 1：首启（空库）播种即两侧已分账、已启用 ---------- */
  console.log('场景 1：首启播种，两侧分账')
  await resetDb()
  await initDatabase()
  assert((await getMeta('ledgerSplitEnabled')) === 'true', '分账标记已启用')
  const supports = await listSupports()
  const s0 = supports[0]
  assert(s0.owner === 'crew', '加固件记录归属存在（owner 字段已迁移）')
  assert(s0.techCheckDate === s0.lastCheckDate, '初始两侧检查日期一致')
  assert(s0.syncState === 'synced', '初始同步状态为已同步')
  const reviews = await listReviews()
  assert(reviews.every((r) => r.owner === 'tech' && typeof r.techUpdatedAt === 'string'), '复评全部归属技术组')
  const surveys = await listSurveys()
  assert(surveys.every((s) => s.owner === 'crew' && s.syncState === 'synced'), '树体检查全部归属班组且已确认')
  assert((await hasPendingCrewRecords()) === false, '没有待同步记录')

  /* ---------- 场景 2：班组登记检查不动周期；技术组调周期不动检查日期 ---------- */
  console.log('场景 2：两侧改同一棵树互不覆盖（在线）')
  const beforeCycle = s0.checkCycleMon
  await markCrewSupportChecked(s0.id, '2026-09-01')
  let after = (await listSupports()).find((x) => x.id === s0.id)!
  assert(after.checkCycleMon === beforeCycle, '班组登记检查后，技术组周期不变')
  assert(after.lastCheckDate === '2026-09-01', '班组检查日期已更新')
  assert(after.syncState === 'pending', '新检查日期进入待同步')
  await syncCrewToTech()
  after = (await listSupports()).find((x) => x.id === s0.id)!
  assert(after.syncState === 'synced' && after.techCheckDate === '2026-09-01', '同步后技术组确认日期对齐班组')
  await setTechSupportCycle(s0.id, 6)
  after = (await listSupports()).find((x) => x.id === s0.id)!
  assert(after.checkCycleMon === 6, '技术组周期已改为 6 个月')
  assert(after.lastCheckDate === '2026-09-01', '技术组调周期后，班组检查日期不消失')
  assert(after.techCheckDate === '2026-09-01' && after.syncState === 'synced', '调周期不影响已确认的检查日期')

  /* ---------- 场景 3：离线同步失败按本侧重试，技术组值不退回 ---------- */
  console.log('场景 3：离线失败 → 班组本侧重试成功；技术组定级不退回')
  await setMeta('simulateOffline', 'true')
  await markCrewSupportChecked(s0.id, '2026-09-20')
  let offline = await syncCrewToTech()
  after = (await listSupports()).find((x) => x.id === s0.id)!
  assert(offline.offline && offline.failed === 1, '离线时同步返回失败 1 条')
  assert(after.syncState === 'failed' && after.syncError !== '', '记录标记为同步失败并保留原因')
  assert(after.techCheckDate === '2026-09-01', '离线失败时技术组已确认日期不被改写（不退回）')
  assert(after.lastCheckDate === '2026-09-20', '班组本次检查值保留在本侧')
  await setMeta('simulateOffline', 'false')
  const retry = await syncCrewToTech()
  after = (await listSupports()).find((x) => x.id === s0.id)!
  assert(retry.pushed === 1 && after.syncState === 'synced', '恢复在线后按班组本侧重试成功')
  assert(after.techCheckDate === '2026-09-20', '重试后技术组确认班组最新检查日期')

  /* ---------- 场景 4：两侧确实分歧 → 人工重新对账挂起等人裁定，不自动覆盖 ---------- */
  console.log('场景 4：两侧对不上 → 重新对账摆到对账页等人裁定')
  // 模拟现场台账与技术组台账各自留下不同检查日期（如迁移遗留 / 双方各执一词）
  await db.supports.update(s0.id, { lastCheckDate: '2026-10-01', techCheckDate: '2026-09-20', syncState: 'synced' })
  const opened = await reconcileAll()
  after = (await listSupports()).find((x) => x.id === s0.id)!
  assert(opened === 1, '重新对账发现 1 条两侧不一致')
  assert(after.lastCheckDate === '2026-10-01' && after.techCheckDate === '2026-09-20', '对账动作不覆盖任何一侧原值')
  const openedAgain = await reconcileAll()
  assert(openedAgain === 0, '已存在待裁定差异时不重复挂账')
  const pendings = await db.discrepancies.where('status').equals('pending').toArray()
  assert(pendings.length === 1, '对账页有 1 条待人裁定')
  const disc = pendings[0]
  assert(disc.recordId === s0.id && disc.field === '现场检查日期', '差异写清记录编号与字段')
  assert(disc.crewValue === '2026-10-01' && disc.techValue === '2026-09-20', '差异写清两侧取值')
  assert(disc.treeCode !== '' && disc.treeCode !== '（古树已删除）', '差异写清古树编号')

  // 裁定按班组结案
  await resolveDiscrepancy(disc, 'resolved-crew', '现场复核以班组照片为准')
  after = (await listSupports()).find((x) => x.id === s0.id)!
  assert(after.techCheckDate === '2026-10-01' && after.syncState === 'synced', '按班组结案后技术组对齐班组')
  const discAfter = await db.discrepancies.get(disc.id)
  assert(discAfter?.status === 'resolved-crew' && discAfter.note !== '', '差异已按班组结案并留备注')

  // 按技术组结案：班组现场记录仍保留
  await db.supports.update(s0.id, { lastCheckDate: '2026-11-05', techCheckDate: '2026-10-01' })
  await reconcileAll()
  const pend2 = await db.discrepancies.where('status').equals('pending').toArray()
  await resolveDiscrepancy(pend2[0], 'resolved-tech')
  after = (await listSupports()).find((x) => x.id === s0.id)!
  assert(after.techCheckDate === '2026-10-01', '按技术组结案后技术组侧保持其确认值')
  assert(after.lastCheckDate === '2026-11-05', '按技术组结案也不删除班组已登记的现场记录')

  /* ---------- 场景 5：删古树级联清理差异 ---------- */
  console.log('场景 5：级联清理')
  const countDiscBefore = await db.discrepancies.count()
  await removeTree(s0.treeId)
  const leftover = await db.discrepancies.where('treeId').equals(s0.treeId).count()
  assert(leftover === 0, '删除古树后其待裁定差异一并清理')
  assert((await db.discrepancies.count()) < countDiscBefore + 1, '差异表无该树残留')

  if (failures > 0) {
    console.error(`\n${failures} 条断言失败`)
    process.exit(1)
  } else {
    console.log('\n全部断言通过 ✅')
  }
  db.close()
  process.exit(0)
}

void main()
