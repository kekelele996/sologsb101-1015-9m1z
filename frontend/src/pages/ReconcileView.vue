<script setup lang="ts">
/**
 * /reconcile 两侧台账对账页（档案页）
 * 养护班组与区技术组对不上的记录先摆到这里：写清古树编号、记录 id、字段、
 * 两侧取值与发现时间，不自动覆盖，待人裁定后再按所选侧对齐并结案。
 * 复用组件：<StatBadge>、<EmptyPanel>
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useReconcileStore } from '@/stores/reconcileStore'
import { useTreeStore } from '@/stores/treeStore'
import { useSupportStore } from '@/stores/supportStore'
import { DISCREPANCY_STATUS_LABEL, type DiscrepancyStatus } from '@/types/ledger'
import type { LedgerDiscrepancy } from '@/types/ledger'

const router = useRouter()
const reconcileStore = useReconcileStore()
const treeStore = useTreeStore()
const supportStore = useSupportStore()

const noteVisible = ref(false)
const noteTarget = ref<LedgerDiscrepancy | null>(null)
const noteChoice = ref<'resolved-crew' | 'resolved-tech'>('resolved-crew')
const noteText = ref('')

const pending = computed(() => reconcileStore.pending)
const resolved = computed(() => reconcileStore.resolved)

onMounted(() => {
  void treeStore.loadAll()
  void reconcileStore.init()
  void supportStore.init()
})

function entityLabel(entity: LedgerDiscrepancy['entity']): string {
  return entity === 'support' ? '加固件' : '长势复评'
}

function statusLabel(status: DiscrepancyStatus): string {
  return DISCREPANCY_STATUS_LABEL[status]
}

function openResolve(row: LedgerDiscrepancy, choice: 'resolved-crew' | 'resolved-tech'): void {
  noteTarget.value = row
  noteChoice.value = choice
  noteText.value = ''
  noteVisible.value = true
}

async function confirmResolve(): Promise<void> {
  if (noteTarget.value === null) return
  // 长势定级为技术组专属：历史定级差异只能按技术组值结案
  if (noteTarget.value.entity === 'review' && noteChoice.value === 'resolved-crew') {
    ElMessage.warning('长势定级由区技术组作出，只能按技术组值结案')
    return
  }
  const choiceText = noteChoice.value === 'resolved-crew' ? '班组现场记录' : '技术组台账'
  try {
    await ElMessageBox.confirm(
      `确认对 ${noteTarget.value.treeCode} 的${entityLabel(noteTarget.value.entity)}（${noteTarget.value.field}）按「${choiceText}」结案？`,
      '裁定确认',
      { type: 'warning', confirmButtonText: '确认裁定', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const message = await reconcileStore.resolve(noteTarget.value, noteChoice.value, noteText.value)
  noteVisible.value = false
  await supportStore.refreshPending()
  ElMessage.success(message)
}

function goSupport(): void {
  void router.push('/supports')
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge
        label="待人裁定"
        :value="pending.length"
        suffix="条"
        :tone="pending.length > 0 ? 'danger' : 'success'"
        icon="Warning"
        hint="班组与技术组两侧取值对不上、等待人工裁定的记录"
      />
      <StatBadge label="已结案" :value="resolved.length" suffix="条" tone="info" icon="Histogram" />
      <StatBadge
        label="班组待同步"
        :value="treeStore.pendingCrewCount"
        suffix="条"
        :tone="treeStore.pendingCrewCount > 0 ? 'warning' : 'success'"
        icon="DataLine"
      />
      <StatBadge
        label="同步失败"
        :value="treeStore.failedCrewCount"
        suffix="条"
        :tone="treeStore.failedCrewCount > 0 ? 'danger' : 'success'"
        icon="Warning"
      />
    </div>

    <el-alert
      type="info"
      show-icon
      :closable="false"
      class="mb-14"
      title="对账规则：班组现场记录与技术组台账对不上时，两侧原值都保留、不自动覆盖，先摆到本页写清编号等人裁定。"
      description="加固件现场检查日期可选择「按班组」或「按技术组」结案；技术组定过的长势定级不回退，只能按技术组结案。裁定后回到加固件页可继续同步。"
    />

    <el-card shadow="never" class="mb-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">待人裁定（{{ pending.length }}）</span>
          <el-button @click="goSupport">返回加固件页</el-button>
        </div>
      </template>

      <EmptyPanel
        v-if="pending.length === 0"
        title="两侧台账当前一致，没有待裁定差异"
        description="班组登记的现场检查日期与技术组核定的周期 / 定级对得上。后续同步若发现不一致，会自动把记录摆到这里并写清古树编号。"
        action-text="去加固件页查看"
        @action="goSupport"
      />

      <el-table v-else :data="pending" row-key="id" stripe>
        <el-table-column label="古树编号" width="150">
          <template #default="{ row }">
            <strong>{{ row.treeCode }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="对象" width="90">
          <template #default="{ row }">{{ entityLabel(row.entity) }}</template>
        </el-table-column>
        <el-table-column label="记录编号" width="170">
          <template #default="{ row }"><span class="mono">{{ row.recordId }}</span></template>
        </el-table-column>
        <el-table-column prop="field" label="对不上的字段" width="130" />
        <el-table-column label="班组侧取值" min-width="130">
          <template #header><span class="th-crew">班组侧</span></template>
          <template #default="{ row }"><span class="val-crew">{{ row.crewValue }}</span></template>
        </el-table-column>
        <el-table-column label="技术组侧取值" min-width="130">
          <template #header><span class="th-tech">技术组侧</span></template>
          <template #default="{ row }"><span class="val-tech">{{ row.techValue }}</span></template>
        </el-table-column>
        <el-table-column prop="foundAt" label="发现时间" width="180">
          <template #default="{ row }">{{ row.foundAt.replace('T', ' ').slice(0, 19) }}</template>
        </el-table-column>
        <el-table-column label="裁定" width="240" fixed="right">
          <template #default="{ row }">
            <el-button type="warning" size="small" @click="openResolve(row, 'resolved-crew')">按班组</el-button>
            <el-button type="success" size="small" @click="openResolve(row, 'resolved-tech')">按技术组</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-if="resolved.length > 0" shadow="never">
      <template #header>
        <span class="card-header__title">已结案（{{ resolved.length }}）</span>
      </template>
      <el-table :data="resolved" row-key="id" stripe>
        <el-table-column label="古树编号" width="150">
          <template #default="{ row }"><strong>{{ row.treeCode }}</strong></template>
        </el-table-column>
        <el-table-column label="对象" width="90">
          <template #default="{ row }">{{ entityLabel(row.entity) }}</template>
        </el-table-column>
        <el-table-column prop="field" label="字段" width="130" />
        <el-table-column label="班组侧" min-width="120">
          <template #default="{ row }">{{ row.crewValue }}</template>
        </el-table-column>
        <el-table-column label="技术组侧" min-width="120">
          <template #default="{ row }">{{ row.techValue }}</template>
        </el-table-column>
        <el-table-column label="裁定结果" width="130">
          <template #default="{ row }">
            <el-tag :type="row.status === 'resolved-tech' ? 'success' : 'warning'">
              {{ statusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="180" />
        <el-table-column prop="resolvedAt" label="结案时间" width="180">
          <template #default="{ row }">{{ row.resolvedAt.replace('T', ' ').slice(0, 19) }}</template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="noteVisible" title="记录裁定意见" width="460px">
      <el-form label-width="90px">
        <el-form-item label="裁定方向">
          <el-tag :type="noteChoice === 'resolved-tech' ? 'success' : 'warning'">
            {{ noteChoice === 'resolved-tech' ? '按技术组台账结案' : '按班组现场记录结案' }}
          </el-tag>
        </el-form-item>
        <el-form-item label="裁定备注">
          <el-input v-model="noteText" type="textarea" :rows="3" placeholder="可写现场复核结论或裁定依据（选填）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="noteVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmResolve">确认裁定并结案</el-button>
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

.mono {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
  color: #6b6257;
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
  font-weight: 600;
}

.val-crew {
  color: #b9770e;
  font-weight: 600;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
