# AIYA 发帖器（publisher）

本地发帖器：SQLite 为存储的表格化编辑界面，通过 `aiya-publish/v1` 与站点同步/推送 resource 帖子（含 `aiya_core_fileserve` 文件列表字段）。单进程本地 Web 应用，无外部服务依赖。

## 启动

```bash
npm install        # 首次；npm 11 若拦截 install 脚本：npm install-scripts approve better-sqlite3 esbuild
npm run dev        # 开发：本地 API(5175) + Vite(5173，代理 /api)
# 或生产形态：
npm run build && npm start   # 单进程 http://localhost:5175
```

## 桌面应用打包（Electron）

```bash
npm run app:win    # vite build + 服务端 esbuild bundle + 切换 electron ABI + electron-builder → release/ + 还原 node ABI
```

产物在 `release/`：NSIS 安装包（`AIYA发帖器 Setup <版本>.exe`）+ 便携版（`AIYA发帖器 <版本>.exe`）。**better-sqlite3 的双 ABI 由 `scripts/native-sync.mjs` 自动切换**（`.native/{node,electron}/better_sqlite3.node` 两份归档，node_modules 常态保持 Node ABI 供 vitest/tsx，打包窗口期临时换 Electron ABI）；下载 URL 由 `scripts/build-app.mjs` 钉死，保证缓存键稳定命中。首次打包要点：

- 服务端用 esbuild 打成单文件 `dist-server/index.js`（CJS 依赖需 `--banner:js` 注入 `createRequire`；`better-sqlite3` 保持 external），Electron 主进程 `electron/main.mjs` 启动它（随机本地端口）并开窗口加载；数据库落在 `%APPDATA%/aiya-publisher/data/publisher.db`。
- **electron 版本必须精确钉死**（`42.11.8`，范围值会让 electron-builder 拒绝工作），且 `npmRebuild: false`——本机没有 MSVC 工具链，better-sqlite3 用 **Electron ABI 的 prebuild**：进入 `node_modules/better-sqlite3` 执行 `npx prebuild-install --runtime electron --target <electron版本>`，GitHub 不通时从 npmmirror 手动取 `https://registry.npmmirror.com/-/binary/better-sqlite3/v<版本>/better-sqlite3-v<版本>-electron-v<ABI>-win32-x64.tar.gz` 解到包根（ABI 映射用 node-abi 查：electron 42 → 146；升级 electron 主版本必须重取对应 ABI）。
- **网络受限时的工具包下载**：electron-builder 首次打包要从 GitHub 拉 winCodeSign/nsis 工具集。TUN/系统代理只救得了 curl 救不了 node 时，用 curl 把 `winCodeSign-2.6.0.7z`、`nsis-3.0.4.1.7z`、`nsis-resources-3.4.1.7z` 下载到本地目录，`python -m http.server 80 --directory <目录>` 起本地镜像（**必须 80 端口**：缓存目录名取自 URL host:port，冒号在 Windows 非法），再以 `ELECTRON_BUILDER_BINARIES_ALLOW_HTTP=true ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL=http://localhost` 打包；三个 7z 同时平铺一份到目录根（两条取用路径都要能命中）。
- 渲染层依赖（react/ag-grid）在 devDependencies——只参与 vite 构建；打进安装包的 dependencies 仅剩 fastify/@fastify/static/better-sqlite3/undici。

首次使用：右上「设置」打开模态框 → 填站点地址 / 用户名 / 应用密码 → 「测试连接」（用表单当前值探测，不落库）→ 「保存」→「同步」。应用密码在 WP 后台（用户 → 资料 → 应用密码）生成；推荐编辑/管理员级账号（可代发任意作者，无该能力只能存草稿/署名自己）。

- **HTTP 代理**：设置里的「HTTP 代理」（如 `http://127.0.0.1:7890`，支持 `user:pass@host:port`）作用于发帖器的全部出站站点请求（连接测试/同步/推送），改完即生效；本地界面与数据库不受影响。
- **作者**：同步时从站点 `GET /users` 拉取全部可发帖账号（author 及以上），默认作者在设置里选，已有文章在详情面板随时切换（代发需账号有 `edit_others_posts`）。

## 使用语义

- **同步**：首次全量分页拉取，之后按 `lastSyncCursor`（远端 modified 游标）增量。词法术语表随同步整体刷新，作者从帖子里自动收录。
- **推送队列 = dirty 标记位**：任何编辑置 dirty；「推送全部」逐条顺序执行（无 post_id → 新建，有 → 更新），失败记录在行内并继续其余行。
- **快照（snapshot）**：每行保存最近一次站点确认的完整状态，支撑「还原到快照」与冲突判定——本地 dirty 且线上 modified 比快照新 → 冲突标记（不覆盖本地，处理方式：还原后重新同步，或直接推送覆盖）。
- **推送载荷是整行全字段**（标题/正文/状态/作者/术语/fileserve 整体写入）。日期只在「与快照不同」时携带：未改日期的行推送后，服务端的「fileserve 值变 → 发布时间刷当前」规则得以生效；显式改了日期则显式日期优先。
- **术语引用**：数字 = 线上既有 term id；`name:xxx` = 线上尚无的新标签（推送时由站点自动创建，需要 `manage_terms` 能力）。推送响应回填真实 id。
- **fileserve 编辑器**：组卡片 + 适配器下拉，字段表与归一化语义在 `shared/fileserve.ts` 逐字镜像 PHP 侧（未知键丢弃、缺省补默认、price 折非负 int）；空配置推送 = 清除线上文件列表（会触发刷时间）。
- 本地删行只删本地记录，**不删除线上帖子**。

## 数据（publisher.db，SQLite / WAL）

- `settings`：站点地址、用户名、应用密码（**本地明文**，本机工具可接受，勿把 db 文件提交或外传）、HTTP 代理、默认作者、同步游标
- `authors` / `terms`：作者登记表（同步自动收录 + 手工备注）、词法术语缓存
- `posts` + `post_terms`：行状态（含 dirty/conflict/missing 标记、last_error、快照 JSON）与术语引用

`PUBLISHER_DATA` 环境变量可重定向数据目录（默认进程工作目录）。

## 开发

```bash
npm run check   # tsc 双配置（server/tests 与 web）
npm test        # vitest：fileserve 模型与推送载荷构建
```

结构：`server/`（Fastify + better-sqlite3 + WP 客户端 + 同步/推送）、`src/`（React 19 + Tailwind 4 + AG Grid Community）、`shared/`（fileserve 数据模型，前后端共用）。
