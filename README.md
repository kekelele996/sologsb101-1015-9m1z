# 古树名木复壮养护档案（sologsb101-1015）

面向园林部门的古树名木保护岗：为一树一档建立检查、复壮、加固与长势复评的完整记录，
按检查周期自动提示加固件超期，长势为衰弱 / 濒危时强制填写后续措施。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22815**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbheritagetree` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3 | `<script setup>` 组合式 API |
| 语言 | TypeScript 5 | `strict` 模式，`vue-tsc --noEmit` 零错误 |
| UI 组件库 | Element Plus 2 | 表格、表单、弹窗、日期选择、时间线、消息提示 |
| 图标 | @element-plus/icons-vue | 入口统一全局注册 |
| 构建 | Vite 6 | 开发端口与宿主端口一致（22815） |
| 路由 | Vue Router 4 | `createWebHistory` + 路由懒加载 |
| 状态管理 | Pinia 2 | setup store，跨页状态集中在 store，页面只读 store |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbheritagetree`，含 v1 → v2 → v3 升级迁移（v3 班组 / 技术组两侧分账） |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1015/
├── README.md
├── docker-compose.yml          # name: gbheritagetree，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    ├── scripts/                 # 两侧分账运行时自检（verify-ledger.ts / verify-upgrade.ts）
    └── src/
        ├── main.ts             # 入口：Pinia + Router + Element Plus + 初始化数据库
        ├── App.vue             # 外壳：顶部导航（含对账角标）+ 当前古树上下文 + 页脚
        ├── env.d.ts
        ├── styles/main.css
        ├── types/              # tree.ts survey.ts measure.ts support.ts review.ts ledger.ts
        ├── stores/             # treeStore surveyStore measureStore supportStore reviewStore reconcileStore
        ├── components/common/  # VigorTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useTreeHistory.ts useIdbTable.ts
        ├── pages/              # TreeList TreeSurvey MeasureBoard SupportBoard ReviewView ReconcileView
        ├── router/index.ts     # 路由表 + ROUTES 常量（含 /reconcile）
        └── utils/              # dimension.ts db.ts sync.ts export.ts seed.ts id.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/trees` | `pages/TreeList.vue` | 古树一树一档：新建/编辑/级联删除、按保护级别与树种筛选、回显检查次数与最新长势等级 |
| `/trees/:id/surveys` | `pages/TreeSurvey.vue` | **班组侧**树体与立地检查：录树高/胸径/冠幅/倾斜/空洞并对比上次、年化生长量、时间线、同步状态 |
| `/measures` | `pages/MeasureBoard.vue` | **班组侧**复壮措施台账：筛选、行内草稿、批量改状态，完成即回写最近复壮日期、同步技术组 |
| `/supports` | `pages/SupportBoard.vue` | 加固件两侧分账：班组登记现场检查日期、技术组核定检查周期、同步/重试/重新对账、超期高亮 |
| `/reviews` | `pages/ReviewView.vue` | **技术组侧**长势复评：衰弱/濒危强制后续措施、历史时间线、JSON 导入导出（定级不被班组改写） |
| `/reconcile` | `pages/ReconcileView.vue` | 两侧台账对账页：对不上的记录写清编号/字段/两侧取值，待人裁定后按所选侧结案 |

`/` 重定向到 `/trees`，未匹配路径统一回落到 `/trees`。
**层级路由支持直接深链**：把 `http://localhost:22815/trees/tree-guozijian-0007/surveys` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「古树档案不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbheritagetree`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`。`version(1)` 建表；`version(2)` 补索引与回写字段；
  `version(3)` 实施「**两侧分账**」并执行 `.upgrade()` 迁移：
  * **先迁移、再启用**：打开旧库时先把全部历史记录分到两侧、回填 `owner` 与两侧时间戳 / 同步状态，
    最后才在 `meta` 表写入 `ledgerSplitEnabled=true`；迁移完成前页面不会读到未分账数据（`db.open()` 等 upgrade 结束才 resolve）。
  * **归属划分**：树体检查、复壮措施、加固件现场检查日期 → 班组（`owner=crew`）；
    加固件检查周期、长势复评定级 → 技术组（复评 `owner=tech`）。
  * 加固件历史 `lastCheckDate` 原样复制到技术组侧 `techCheckDate`，两侧初始一致、不凭空产生差异；
    旧复评回填 `techUpdatedAt`；新增 `discrepancies`（对账差异）与 `meta`（键值标记）两张表。
* **两侧分账规则（v3 核心）**：
  * **字段级归属、互不整行覆盖**：班组写检查 / 措施 / `lastCheckDate`（`putCrewSurvey`、`putCrewMeasure`、
    `markCrewSupportChecked`）；技术组写 `checkCycleMon`（`setTechSupportCycle`）与复评定级（`putTechReview`）。
    班组新做的检查不改写技术组已定的周期 / 定级；技术组调整周期也不删班组已登记的现场记录。
  * **班组 → 技术组单向同步**（`src/utils/sync.ts`）：班组新登记的现场记录置 `pending` 推送；
    技术组确认后写 `techAckAt` / `techCheckDate`。**技术组定过的不回退**。
  * **同步失败按本侧重试**：可在加固件页打开「模拟离线」制造失败；失败记录保留班组值与原因（`failed`），
    在线后「同步到技术组」或单条「重试」即收敛，技术组侧在离线期间不被改动。
  * **对账不上摆档案页**：人工「重新对账」时，凡班组 `lastCheckDate` ≠ 技术组 `techCheckDate` 的加固件，
    写一条 `discrepancies`（含古树编号、记录 id、字段、两侧取值、发现时间），进 `/reconcile` 待人裁定；
    裁定前两侧原值都保留。可「按班组」（技术组对齐班组）或「按技术组」结案并留备注；
    长势定级为技术组专属，历史定级差异只能按技术组结案。
* **表结构（v3）**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `trees` | id | code, species, protectLevel, ageYears, createdAt, updatedAt, owner |
  | `surveys` | id | treeId, [treeId+date], date, siteNote, owner, syncState |
  | `measures` | id | treeId, type, state, date, operator, owner, syncState |
  | `supports` | id | treeId, type, installDate, lastCheckDate, techCheckDate, owner, syncState |
  | `reviews` | id | treeId, date, vigor, trend, owner |
  | `discrepancies` | id | entity, recordId, treeId, status, foundAt |
  | `meta` | key | （`ledgerSplitEnabled` / `simulateOffline` / `lastCrewSyncAt`） |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `trees` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **古树 → 树体检查 / 复壮措施 / 加固件 / 长势复评** 三层互相引用：
  * 3 株古树（京-01-0007 国槐 一级 / 京-02-0113 银杏 一级 / 京-05-0246 侧柏 二级）；
  * 9 条树体检查（每株 3 次，树高胸径随日期递增）、8 条复壮措施（覆盖计划 / 实施中 / 已完成）、
    5 件加固件（其中 **京-01-0007 支撑杆** 与 **京-05-0246 避雷** 故意超周期未检查，用于验证高亮与提醒）、
    7 条长势复评（含衰弱 / 濒危样本且均已填写后续措施）。
  * 固定 id 如 `tree-guozijian-0007`、`tree-xiangshan-0113`、`tree-ritan-0246` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的古树 id」这一界面偏好，不存业务数据。
* 删除古树会**级联清理**其下的树体检查、复壮措施、加固件、复评记录与待裁定差异（同一 Dexie 事务内完成）。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22815
```

其他命令：

```bash
npm run build        # vue-tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run preview      # 预览 dist 产物
```

两侧分账的运行时自检（Node + `fake-indexeddb`，验证互不覆盖 / 离线重试 / 对账裁定 / v2→v3 迁移）：

```bash
npx vite-node scripts/verify-ledger.ts    # 分账、同步、重试、对账规则
npx vite-node scripts/verify-upgrade.ts   # v2 旧库首启迁移到两侧再启用
```

---

## 七、核心业务规则

* **倾斜安全阈值**：< 5° 正常；5°–10° 需关注；> 10° 超限（`src/utils/dimension.ts`）。
* **空洞风险**：1–2 处需关注，≥ 3 处判定为高风险，建议立即安排树洞修补与防腐处理。
* **生长量年化**：由最近两次检查的差值按实际天数折算为「每年」增量，间隔不足 30 天时退回直接差值。
* **加固件超期**：`最近检查日期 + 检查周期（月）` 早于今天即为超期，列表自动高亮并在顶部汇总提醒；
  「登记本次检查」会把最近检查日期置为今天并解除高亮。
* **复评强制校验**：长势为「衰弱」或「濒危」时，后续措施为必填项，未填写无法保存。
* **措施回写**：复壮措施状态改为「已完成」时，若实施日期晚于古树现有最近复壮日期，则自动回写该日期。
* **两侧分账**：班组只写现场（树体检查 / 复壮措施 / 加固件检查日期），技术组只写判定（检查周期 / 长势定级）；
  班组现场记录推技术组、失败按本侧重试，技术组定级不回退；两侧对不上先进 `/reconcile` 挂账，写清编号等人裁定。
