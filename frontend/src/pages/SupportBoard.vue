<script setup lang="ts">
/**
 * /supports 支撑加固与避雷件登记 —— 两侧分账
 * - 养护班组：登记加固件、登记「现场检查日期」、同步失败后按本侧重试
 * - 区技术组：核定「检查周期」，技术组定过的周期不被班组改写
 * 超周期未检查（班组检查日期 + 技术组周期）自动高亮并提醒。
 * 消费模型：Support、Tree；复用组件：<StatBadge>、<EmptyPanel>、<FilterBar>、<VigorTag>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import VigorTag from '@/components/common/VigorTag.vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useTreeStore } from '@/stores/treeStore'
import { useSupportStore } from '@/stores/supportStore'
import { db } from '@/utils/db'
import { retryOne } from '@/utils/sync'
import { SUPPORT_TYPE_OPTIONS, type Support, type SupportDraft, type SupportType } from '@/types/support'
import { isSupportOverdue, nextCheckDate, overdueDays } from '@/utils/dimension'
import { today } from '@/utils/id'
import { SYNC_STATE_LABEL, type SyncState } from '@/types/ledger'

const treeStore = useTreeStore()
const supportStore = useSupportStore()

const { rows, loading } = useIdbTable<Support>(db.supports, { sortByUpdatedAt: false })

const keyword = ref('')
const treeFilter = ref('all')
const typeFilter = ref<SupportType | 'all'>('all')
const overdueOnly = ref(false)

const dialogVisible = ref(false)
const submitting = ref(false)
const formRef = ref<FormInstance>()

// 班组「登记本次检查」弹窗
const checkVisible = ref(false)
const checkTarget = ref<Support | null>(null)
const checkDate = ref(today())

// 技术组「核定检查周期」弹窗
const cycleVisible = ref(false)
const cycleTarget = ref<Support | null>(null)
const cycleMonths = ref(12)

const form = reactive<SupportDraft>({
  treeId: '',
  type: '支撑杆',
  installDate: '',
  checkCycleMon: 12,
  lastCheckDate: '',
})

const rules: FormRules<SupportDraft> = {
  treeId: [{ required: true, message: '请选择古树', trigger: 'change' }],
  type: [{ required: true, message: '请选择加固件类型', trigger: 'change' }],
  installDate: [{ required: true, message: '请选择安装日期', trigger: 'change' }],
  checkCycleMon: [{ required: true, message: '请填写技术组核定的检查周期', trigger: 'blur' }],
}

const treeLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)

const filtered = computed<Support[]>(() => {
  const key = keyword.value.trim().toLowerCase()
  return rows.value
    .filter((row) => {
      if (treeFilter.value !== 'all' && row.treeId !== treeFilter.value) return false
      if (typeFilter.value !== 'all' && row.type !== typeFilter.value) return false
      if (overdueOnly.value && !isSupportOverdue(row.lastCheckDate, row.checkCycleMon)) return false
      if (key === '') return true
      return (
        (treeLabel.value[row.treeId] ?? '').toLowerCase().includes(key) ||
        row.type.toLowerCase().includes(key) ||
        row.lastCheckDate.includes(key)
      )
    })
    .sort((a, b) => a.installDate.localeCompare(b.installDate))
})

const overdueRows = computed<Support[]>(() =>
  rows.value.filter((row) => isSupportOverdue(row.lastCheckDate, row.checkCycleMon))
)

const coveredTrees = computed<number>(() => new Set(rows.value.map((row) => row.treeId)).size)
const failedRows = computed<Support[]>(() => rows.value.filter((row) => row.syncState === 'failed'))
const pendingRows = computed<Support[]>(() =>
  rows.value.filter((row) => row.syncState === 'pending' || row.syncState === 'failed')
)
/** 班组检查日期与技术组已确认值对不上的加固件（应挂对账页） */
const mismatchRows = computed<Support[]>(() =>
  rows.value.filter((row) => row.lastCheckDate !== row.techCheckDate)
)

onMounted(() => {
  void treeStore.loadAll()
  void supportStore.init()
})

function rowClassName({ row }: { row: Support }): string {
  return isSupportOverdue(row.lastCheckDate, row.checkCycleMon) ? 'row-overdue' : ''
}

function syncTagType(state: SyncState): 'info' | 'warning' | 'danger' | 'success' {
  if (state === 'synced') return 'success'
  if (state === 'syncing') return 'warning'
  if (state === 'failed') return 'danger'
  return 'info'
}

function syncLabel(state: SyncState): string {
  return SYNC_STATE_LABEL[state]
}

function openCreate(): void {
  const treeId =
    treeFilter.value !== 'all' ? treeFilter.value : (treeStore.currentTreeId ?? treeStore.trees[0]?.id ?? '')
  Object.assign(form, {
    treeId,
    type: '支撑杆' as SupportType,
    installDate: today(),
    checkCycleMon: 12,
    lastCheckDate: today(),
  })
  dialogVisible.value = true
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    await supportStore.createSupport({ ...form })
    ElMessage.success('加固件已登记（周期归技术组、检查日期归班组）')
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Support): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除「${row.type}」加固件记录？两侧台账与其对账差异会一并移除。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await supportStore.deleteSupport(row.id)
  ElMessage.success('加固件记录已删除')
}

function openCheck(row: Support): void {
  checkTarget.value = row
  checkDate.value = row.lastCheckDate || today()
  checkVisible.value = true
}

async function confirmCheck(): Promise<void> {
  if (checkTarget.value === null) return
  if (checkDate.value === '') {
    ElMessage.warning('请选择本次现场检查日期')
    return
  }
  await supportStore.markChecked(checkTarget.value.id, checkDate.value)
  checkVisible.value = false
  ElMessage.success(`班组已登记 ${treeLabel.value[checkTarget.value.treeId] ?? '该古树'} 的本次检查`)
}

function openCycle(row: Support): void {
  cycleTarget.value = row
  cycleMonths.value = row.checkCycleMon
  cycleVisible.value = true
}

async function confirmCycle(): Promise<void> {
  if (cycleTarget.value === null) return
  await supportStore.updateCycle(cycleTarget.value.id, cycleMonths.value)
  cycleVisible.value = false
  ElMessage.success('技术组已更新检查周期，班组现场检查记录保持不变')
}

async function handleSyncAll(): Promise<void> {
  const result = await supportStore.syncToTech()
  if (result.offline) {
    ElMessage.warning('技术组台账暂不可达（离线），记录已保留在班组侧，稍后可重试')
  } else if (result.discrepancies > 0) {
    ElMessage.warning(`已推送 ${result.pushed} 条；${result.discrepancies} 条两侧不一致，已挂到对账页等人裁定`)
  } else {
    ElMessage.success(`已把 ${result.pushed} 条班组现场记录同步到技术组台账`)
  }
}

async function handleRetry(row: Support): Promise<void> {
  const result = await retryOne({ id: row.id, kind: 'support' })
  if (result.offline) {
    ElMessage.warning('仍处离线，已继续按班组侧保留；连接恢复后再试')
  } else if (result.discrepancies > 0) {
    ElMessage.warning('两侧检查日期对不上，已挂到对账页等人裁定')
  } else {
    ElMessage.success('已按班组本侧重试成功，技术组台账已确认')
  }
  void supportStore.refreshPending()
}

async function handleReconcile(): Promise<void> {
  const opened = await supportStore.reconcile()
  if (opened > 0) ElMessage.warning(`重新对账发现 ${opened} 条不一致，已摆到对账页写清编号等人裁定`)
  else ElMessage.success('两侧加固件检查日期核对一致')
}

function goReconcile(): void {
  void window.dispatchEvent(new CustomEvent('goto-reconcile'))
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'treeId') treeFilter.value = value
  if (key === 'type') typeFilter.value = value as SupportType | 'all'
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="加固件总数" :value="rows.length" suffix="件" tone="primary" icon="Histogram" />
      <StatBadge
        label="超期未检查"
        :value="overdueRows.length"
        suffix="件"
        :tone="overdueRows.length > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="班组检查日期 + 技术组周期：超过下次检查日期仍未登记"
      />
      <StatBadge
        label="班组待同步"
        :value="pendingRows.length"
        suffix="件"
        :tone="pendingRows.length > 0 ? 'warning' : 'success'"
        icon="DataLine"
        hint="班组新登记、尚未推送到技术组台账的检查记录"
      />
      <StatBadge
        label="同步失败"
        :value="failedRows.length"
        suffix="件"
        :tone="failedRows.length > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="离线等原因未推送到技术组，可按班组本侧重试"
      />
      <StatBadge
        label="两侧对不上"
        :value="mismatchRows.length"
        suffix="件"
        :tone="mismatchRows.length > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="班组检查日期与技术组已确认值不一致，需到对账页裁定"
      />
      <StatBadge label="覆盖古树" :value="coveredTrees" suffix="株" tone="info" icon="PieChart" size="small" />
    </div>

    <!-- 班组 → 技术组 同步工具条 -->
    <el-card shadow="never" class="sync-bar">
      <div class="sync-bar__row">
        <div class="sync-bar__group">
          <el-tag :type="supportStore.offline ? 'danger' : 'success'" effect="dark">
            {{ supportStore.offline ? '技术组台账：离线' : '技术组台账：在线' }}
          </el-tag>
          <span class="sync-bar__hint">班组现场检查日期只从班组侧推送；技术组定过的周期与定级不退回。</span>
        </div>
        <div class="sync-bar__group">
          <el-switch
            :model-value="supportStore.offline"
            active-text="模拟离线"
            inline-prompt
            @update:model-value="(v: boolean) => supportStore.setOffline(v)"
          />
          <el-button type="primary" :disabled="pendingRows.length === 0" @click="handleSyncAll">
            班组台账同步到技术组
          </el-button>
          <el-button @click="handleReconcile">重新对账</el-button>
          <el-button
            v-if="treeStore.pendingDiscrepancyCount > 0"
            type="danger"
            plain
            @click="goReconcile"
          >
            前往对账页（{{ treeStore.pendingDiscrepancyCount }} 条待裁定）
          </el-button>
        </div>
      </div>
      <el-alert
        v-for="row in failedRows"
        :key="row.id"
        type="error"
        :closable="false"
        show-icon
        class="sync-err"
        :title="`${treeLabel[row.treeId] ?? '（古树已删除）'} · ${row.type}：${row.syncError || '同步失败'}`"
      >
        <template #default>
          <el-button size="small" type="danger" @click="handleRetry(row)">按班组本侧重试</el-button>
        </template>
      </el-alert>
    </el-card>

    <el-alert
      v-if="overdueRows.length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`有 ${overdueRows.length} 件加固件超过检查周期未检查`"
    >
      <template #default>
        <div class="overdue-list">
          <div v-for="row in overdueRows" :key="row.id">
            {{ treeLabel[row.treeId] ?? '（古树已删除）' }} · {{ row.type }}：班组最近检查
            {{ row.lastCheckDate || '未记录' }}，技术组周期 {{ row.checkCycleMon }} 个月，已超期
            {{ overdueDays(row.lastCheckDate, row.checkCycleMon) }} 天
          </div>
        </div>
      </template>
    </el-alert>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">支撑加固与避雷件登记（班组检查 / 技术组周期）</span>
          <el-button type="primary" @click="openCreate" :disabled="treeStore.trees.length === 0">
            <el-icon><Plus /></el-icon>
            <span>登记加固件</span>
          </el-button>
        </div>
      </template>

      <FilterBar
        :keyword="keyword"
        :fields="[
          {
            key: 'treeId',
            label: '古树',
            options: treeStore.trees.map((tree) => tree.id),
            optionLabels: treeLabel,
          },
          { key: 'type', label: '类型', options: SUPPORT_TYPE_OPTIONS as unknown as string[] },
        ]"
        :values="{ treeId: treeFilter, type: typeFilter }"
        :result-text="`命中 ${filtered.length} / ${rows.length} 件`"
        @update:keyword="(value: string) => (keyword = value)"
        @change="handleFilterChange"
        @reset="
          () => {
            keyword = ''
            treeFilter = 'all'
            typeFilter = 'all'
            overdueOnly = false
          }
        "
      >
        <template #extra>
          <el-checkbox v-model="overdueOnly" border size="small">只看超期未检查</el-checkbox>
        </template>
      </FilterBar>

      <EmptyPanel
        v-if="rows.length === 0 && !loading"
        title="还没有加固件记录"
        description="登记支撑杆、拉纤与避雷件：技术组核定检查周期、班组登记现场检查日期，两侧分开互不覆盖，超期自动高亮提醒。"
        action-text="登记第一件加固件"
        @action="openCreate"
      />

      <el-table v-else v-loading="loading || !treeStore.ready" :data="filtered" row-key="id" stripe :row-class-name="rowClassName">
        <el-table-column label="古树" min-width="190">
          <template #default="{ row }">
            <div class="cell-stack">
              <span>{{ treeLabel[row.treeId] ?? '（古树已删除）' }}</span>
              <VigorTag
                :vigor="treeStore.statOf(row.treeId).latestVigor"
                :trend="treeStore.statOf(row.treeId).latestTrend"
                size="small"
              />
            </div>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag :type="row.type === '避雷' ? 'warning' : row.type === '拉纤' ? 'info' : 'success'">
              {{ row.type }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="installDate" label="安装日期" width="110" />
        <el-table-column label="技术组周期" width="120" align="right">
          <template #header>
            <span class="th-tech">技术组周期</span>
          </template>
          <template #default="{ row }">
            <span class="val-tech">{{ row.checkCycleMon }} 个月</span>
          </template>
        </el-table-column>
        <el-table-column label="班组最近检查" width="130">
          <template #header>
            <span class="th-crew">班组最近检查</span>
          </template>
          <template #default="{ row }">
            <span v-if="row.lastCheckDate === ''" class="cell-warn">未记录</span>
            <span v-else class="val-crew">{{ row.lastCheckDate }}</span>
          </template>
        </el-table-column>
        <el-table-column label="技术组已确认" width="130">
          <template #default="{ row }">
            <span v-if="row.techCheckDate === ''" class="cell-sub">未确认</span>
            <span v-else :class="{ 'cell-warn': row.techCheckDate !== row.lastCheckDate }">{{ row.techCheckDate }}</span>
          </template>
        </el-table-column>
        <el-table-column label="下次检查" width="120">
          <template #default="{ row }">{{ nextCheckDate(row.lastCheckDate, row.checkCycleMon) || '—' }}</template>
        </el-table-column>
        <el-table-column label="检查状态" width="130">
          <template #default="{ row }">
            <el-tag v-if="isSupportOverdue(row.lastCheckDate, row.checkCycleMon)" type="danger" effect="dark">
              超期 {{ overdueDays(row.lastCheckDate, row.checkCycleMon) }} 天
            </el-tag>
            <el-tag v-else type="success" effect="light">周期内</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="同步状态" width="150">
          <template #default="{ row }">
            <el-tag :type="syncTagType(row.syncState)" size="small">{{ syncLabel(row.syncState) }}</el-tag>
            <el-tooltip v-if="row.syncError !== ''" :content="row.syncError" placement="top">
              <el-icon class="sync-err-icon"><WarningFilled /></el-icon>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="330" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              :type="isSupportOverdue(row.lastCheckDate, row.checkCycleMon) ? 'danger' : 'primary'"
              size="small"
              @click="openCheck(row)"
            >
              班组登记检查
            </el-button>
            <el-button link type="success" size="small" @click="openCycle(row)">技术组定周期</el-button>
            <el-button v-if="row.syncState === 'failed'" link type="danger" size="small" @click="handleRetry(row)">
              重试
            </el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 登记新加固件（共享登记信息） -->
    <el-dialog v-model="dialogVisible" title="登记加固件" width="600px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="130px">
        <el-form-item label="古树" prop="treeId">
          <el-select v-model="form.treeId" filterable style="width: 100%">
            <el-option
              v-for="tree in treeStore.trees"
              :key="tree.id"
              :value="tree.id"
              :label="`${tree.code} · ${tree.species} · ${tree.location}`"
            />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="类型" prop="type">
              <el-select v-model="form.type" style="width: 100%">
                <el-option v-for="item in SUPPORT_TYPE_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="安装日期" prop="installDate">
              <el-date-picker v-model="form.installDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="技术组周期（月）" prop="checkCycleMon">
              <el-input-number v-model="form.checkCycleMon" :min="1" :max="120" :step="1" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="班组最近检查日期">
              <el-date-picker v-model="form.lastCheckDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-alert
          type="info"
          show-icon
          :closable="false"
          :title="`下次检查日期：${nextCheckDate(form.lastCheckDate, form.checkCycleMon) || '请先填写班组检查日期'}`"
          description="登记后：检查周期只由技术组调整，现场检查日期只由班组登记，两侧改同一棵树也不会互相覆盖。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 班组：登记本次现场检查（只写班组侧） -->
    <el-dialog v-model="checkVisible" title="班组登记本次现场检查" width="420px">
      <el-form label-width="110px">
        <el-form-item label="加固件">
          <span>{{ checkTarget ? `${treeLabel[checkTarget.treeId] ?? ''} · ${checkTarget.type}` : '' }}</span>
        </el-form-item>
        <el-form-item label="现场检查日期">
          <el-date-picker v-model="checkDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
      </el-form>
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="仅写入班组侧检查日期，技术组核定的检查周期不会被改动；保存后推送到技术组对账。"
      />
      <template #footer>
        <el-button @click="checkVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmCheck">保存并待同步</el-button>
      </template>
    </el-dialog>

    <!-- 技术组：核定检查周期（只写技术组侧） -->
    <el-dialog v-model="cycleVisible" title="技术组核定检查周期" width="420px">
      <el-form label-width="110px">
        <el-form-item label="加固件">
          <span>{{ cycleTarget ? `${treeLabel[cycleTarget.treeId] ?? ''} · ${cycleTarget.type}` : '' }}</span>
        </el-form-item>
        <el-form-item label="检查周期（月）">
          <el-input-number v-model="cycleMonths" :min="1" :max="120" :step="1" style="width: 100%" />
        </el-form-item>
      </el-form>
      <el-alert
        type="success"
        :closable="false"
        show-icon
        title="仅更新技术组侧周期；班组已登记的现场检查日期保留，不会因调整周期而消失。"
      />
      <template #footer>
        <el-button @click="cycleVisible = false">取消</el-button>
        <el-button type="success" @click="confirmCycle">保存周期</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.sync-bar {
  margin-bottom: 14px;
}

.sync-bar :deep(.el-card__body) {
  padding: 12px 14px;
}

.sync-bar__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.sync-bar__group {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.sync-bar__hint {
  font-size: 12px;
  color: #8c8479;
}

.sync-err {
  margin-top: 10px;
}

.sync-err-icon {
  margin-left: 6px;
  color: #c0392b;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #2f2a24;
}

.overdue-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.8;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cell-warn {
  color: #c0392b;
  font-weight: 600;
}

.cell-sub {
  font-size: 12px;
  color: #8c8479;
}

.th-tech {
  color: #1e7e34;
  font-weight: 600;
}

.th-crew {
  color: #b9770e;
  font-weight: 600;
}

.val-tech {
  color: #1e7e34;
}

.val-crew {
  color: #b9770e;
  font-weight: 600;
}

.mb-14 {
  margin-bottom: 14px;
}

:deep(.row-overdue) {
  --el-table-tr-bg-color: #fdf3f2;
}
</style>
