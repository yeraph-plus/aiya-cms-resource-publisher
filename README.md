# AIYA 发帖器（publisher）

本地发帖器：SQLite 为存储的表格化编辑界面，通过 `aiya-publish/v1` 与站点同步/推送 resource 帖子（含 `aiya_core_fileserve` 文件列表字段）。单进程本地 Web 应用，无外部服务依赖。

> 配套仓库：站点后端与契约提供方 [`aiya-cms-core`](https://github.com/yeraph-plus/aiya-cms-core)（`aiya/core/v1` 契约、resource 类型与术语注册；未装它本工具无数据可同步）；公开前台见 [`aiya-cms-station`](https://github.com/yeraph-plus/aiya-cms-station)。

## 启动

```bash
npm install        # 首次；npm 11 若拦截 install 脚本：npm install-scripts approve better-sqlite3 esbuild
npm run dev        # 开发：本地 API(5175) + Vite(5173，代理 /api)
# 或生产形态：
npm run build && npm start   # 单进程 http://localhost:5175
```

启动即接管：dev 与 start 若发现端口被**本工具的残留实例**占用（强杀遗留的孤儿），会自动结束它并占住端口（HTTP 指纹识别，双栈探测，只杀自家）；被其它进程占用则报出 PID 拒绝启动。dev 由 `scripts/dev.mjs` 托管：启动前驱逐 5173 上的自家 Vite 残留，Ctrl+C/子进程退出时树杀两个子树，不留 npm 中间层孤儿。

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

- **同步**：首次全量分页拉取，之后按 `lastSyncCursor`（远端 modified 游标）增量。词法术语表随同步整体刷新，作者从帖子里自动收录。单个畸形条目会被跳过并在完成消息里计数（「跳过畸形 N 条」），不中断整轮。
- **推送队列 = dirty 标记位**：任何编辑置 dirty；「推送全部」逐条顺序执行（无 post_id → 新建，有 → 更新），行构建 + 站点调用 + 回写整体在逐行 try 内，单条坏行只损失自己。**连续 3 次传输层失败（站点不可达/代理死）熔断本轮**：剩余行保持待推送、不写错误，网络恢复后再推；4xx 证明链路可用，会重置计数、照常逐行试。
- **拉取/推送互斥**：服务端单执行槽，运行中的拉取/推送会让并发请求拿到 409（多标签页也生效）；界面上这两个操作运行期间，操作栏按钮全部失效。
- **快照（snapshot）**：每行保存最近一次站点确认的完整状态，支撑「还原到快照」与冲突判定——本地 dirty 且线上 modified 比快照新 → 冲突标记（不覆盖本地，处理方式：还原后重新同步，或直接推送覆盖）。
- **推送载荷是整行全字段**（标题/正文/状态/作者/术语/fileserve 整体写入）。日期只在「与快照不同」时携带：未改日期的行推送后，服务端的「fileserve 值变 → 发布时间刷当前」规则得以生效；显式改了日期则显式日期优先。
- **术语引用**：数字 = 线上既有 term id；`name:xxx` = 线上尚无的新标签（推送时由站点自动创建，需要 `manage_terms` 能力）。推送响应回填真实 id。
- **CSV 导入**：「导入 CSV」批量建本地新行入待推送队列（不推送，推送走既有按钮）。首行表头，向导自动猜测列映射（标题/正文/状态/发布时间/发布者/六个术语列，可改）；标题必填、状态含中文别名（草稿/发布/定时）、发布时间折叠为 `YYYY-MM-DDTHH:mm`（future 必须带时间）；「发布者(账号)」按显示名匹配作者表（未匹配默认该行报错，可切换回落默认作者）——裸「作者」表头是 `resource_author` 术语列，不是账号；编码自动识别 UTF-8/GBK/UTF-16，单次上限 5000 行。好行单事务整体入队、坏行按行号报原因，重复导入同一文件会建重复行。向导里的预览计数与实际写入跑的是同一份 `shared/import.ts` 纯函数。
- **fileserve 编辑器**：组卡片 + 适配器下拉，字段表与归一化语义在 `shared/fileserve.ts` 逐字镜像 PHP 侧（未知键丢弃、缺省补默认、price 折非负 int）；空配置推送 = 清除线上文件列表（会触发刷时间）。
- **组级推送开关**：每组一个「推送」勾选（组表体末格）。勾选 = 随主推送写入站点（推送前剥除开关字段，线上 JSON 结构不变）；不勾 = 本地草稿，永不外发，且在推送回写、同步拉取、还原快照中都原样保留。开关是本地字段，站点归一化会剥掉它、不会回传；切换适配器保留开关状态。
- **文件列表比对徽章**：推送/同步成功后按站点确认的形状记摘要（`fileserve_pushed_digest`）；勾选组与摘要不一致 → 标记列「文件未推」，勾选组缺必填字段（链接/路径/关键词/文件夹 ID）→「文件缺项」（悬停点名组号），全部组均为草稿 →「文件草稿」（推送会发空配置、清空线上列表——这是它单独有徽章的原因）。徽章只是提示：缺项组照样推送，是否发出由勾选决定。「文件列表」列显示 `活跃/总数 组 · X 分/次`（价格只计勾选组）。
- **本地目录**：已发布行的文件列表「+ 添加组」时，自动在「自动创建文件夹位置」（设置里配）创建上传目录 `{帖子ID}-{文章标题}`，ID 段补零到 5 位（`00420-标题`，文件管理器按发帖顺序排列；非法字符净化、超长按码点截断）。目录不落库：识别只认补零后的 ID 段（`{ID}` 精确或 `{ID}-` 前缀），每次 ensure/open 即席扫描根目录——手动改名、改标题都不断链，删本地行目录原样保留，无任何可失真的第二真源。文件放进目录 → 网盘客户端上传分享 → 链接/提取码回填编辑器 → 勾选「推送」随主推送写入。
- **运行日志**：底部日志面板登记全部操作事件（同步/推送/目录/启动），按 id 增量轮询、可折叠、一键清空；服务端保留最近 2000 条滚动裁剪。表格的错误列已撤，行错误改为「标记」列的红色徽章（悬停看原文）。
- 本地删行只删本地记录，**不删除线上帖子**。
- **UI 约定**：无嵌套模态框——表格行内编辑 + 右侧详情面板承载主编辑面；弹层只允许单层（设置、CSV 导入等）。

## 数据（publisher.db，SQLite / WAL）

- `settings`：站点地址、用户名、应用密码（**本地明文**，本机工具可接受，勿把 db 文件提交或外传）、HTTP 代理、默认作者、同步游标、自动创建文件夹位置
- `authors` / `terms`：作者登记表（同步自动收录 + 手工备注）、词法术语缓存
- `posts` + `post_terms`：行状态（含 dirty/conflict/missing 标记、last_error、快照 JSON）、线上 slug（取自 permalink）、fileserve 比对摘要（`fileserve_pushed_digest`，取站点确认形状，只喂徽章）与术语引用
- `logs`：运行日志（level/scope/ref/message，滚动保留 2000 条）。本地目录不在 SQL 里——目录名可由帖子 ID 推导，文件系统即真源。

`PUBLISHER_DATA` 环境变量可重定向数据目录（默认进程工作目录）。

## 开发

```bash
npm run check   # tsc 双配置（server/tests 与 web）
npm test        # vitest：fileserve 模型、载荷构建、补完推送、暂存目录与日志等
```

结构：`server/`（Fastify + better-sqlite3 + WP 客户端 + 同步/推送）、`src/`（React 19 + Tailwind 4 + AG Grid Community）、`shared/`（fileserve 数据模型与 CSV 导入模型，前后端共用）。

## 网盘分享回填（netdisk/aiya-netdisk.user.js）

油猴脚本（Tampermonkey，百度网盘 web 端）负责「定位 → 分享 → 回填」：上传由网盘客户端人工完成，脚本在 `pan.baidu.com` 页内按目录名定位文件夹、创建分享（页内动作，无 cookie 出浏览器），把链接+提取码回填到发帖器文件列表并**自动勾选该组推送**。发帖器侧对接端点为 `GET /api/netdisk/queue` 与 `POST /api/netdisk/result`（CORS 钉死 `pan.baidu.com` 源）。使用：

1. Edge/Chrome 装 Tampermonkey → 新建脚本 → 粘贴 `netdisk/aiya-netdisk.user.js` 全文保存；
2. 打开 `pan.baidu.com`（已登录），右下角「AIYA」浮标展开面板，确认网盘根目录（客户端上传的同名目录所在位置）与发帖器地址；
3. 发帖器里给已上线行添加空链接的网盘组（默认不勾推送）→ 面板「刷新队列」→「开始处理」逐行定位/分享/回填（单行失败即停，面板显示 errno 提示）。

分享有效期默认 30 天；「永久」需网盘会员。回填后的组自动勾选推送并置 dirty，随正常推送写入站点。

## 配套 WP 插件（wordpress_plugins/aiya-cms-resource-publisher）

WP 侧配套插件（AIYA CMS - Resource Post Publisher）随本仓库单仓库维护，源码在 `wordpress_plugins/aiya-cms-resource-publisher/`（REST 命名空间 `aiya-publish/v1`，端点语义见其 `README.md`）。

- 不声明 `Requires Plugins` 头（该头按目录 slug 匹配依赖，core 插件本地 slug `aiya-core`、线上 `aiya-cms-core`，无法统一）：未安装/未启用 core 时入口文件运行时兜底——显示管理提示且不注册任何路由（resource 类型由 core 注册）。
- **部署**：`npm run plugin:sync` 把源码镜像到 `../wp-content/plugins/aiya-cms-publish`（跳过 `.git`/`vendor`；目标侧 `vendor/` 是容器内 QA 工具，装一次即可，不同步）。开发循环：改 `wordpress_plugins/aiya-cms-resource-publisher` → `npm run plugin:sync` → 容器内检查（见插件 README）。
- **发布包**：`npm run plugin:archive` 产出 `archives/aiya-cms-publish-<版本>.zip`（WP 安装器可直接上传；zip 内顶层目录为部署 slug，tests/QA 配置/composer 文件已剔除）。
- 该插件历史上是独立 git 仓库，已 subtree 并入本仓库（提交历史保留）。
