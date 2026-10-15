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

产物在 `release/`：NSIS 安装包 `AIYA发帖器 Setup <版本>.exe`（`oneClick: false` + `allowToChangeInstallationDirectory: true`，向导里可选安装目录）。**Windows 只打这一个安装包**：`portable` 单文件目标会让 makensis 把整份 `app-64.7z` 重新压进那个自解压 exe（portable 走 `portable.nsi`，electron-builder 的注释即「NSIS recompresses the archive」），这一趟压缩就是打包耗时的大头。**better-sqlite3 的双 ABI 由 `scripts/native-sync.mjs` 自动切换**（`.native/{node,electron}/better_sqlite3.node` 两份归档，node_modules 常态保持 Node ABI 供 vitest/tsx，打包窗口期临时换 Electron ABI）；下载 URL 由 `scripts/build-app.mjs` 钉死，保证缓存键稳定命中。整条打包链由 `scripts/app-build.mjs` 托管：**无论成功、失败还是中断，收尾时都会还原 Node ABI**（`finally` 语义），因此一次失败的 electron-builder（工具集拉不到、磁盘不足、Ctrl+C）不会把 `node_modules` 留在 Electron ABI 上而让后续 `npm test` 报 `NODE_MODULE_VERSION` 不匹配。若仍怀疑 ABI 状态，手工跑一次 `npm run native:node` 即可。首次打包要点：

- 服务端用 esbuild 打成单文件 `dist-server/index.js`（CJS 依赖需 `--banner:js` 注入 `createRequire`；`better-sqlite3` 保持 external），Electron 主进程 `electron/main.mjs` 用同一条 portguard 链路把它绑在**固定 5175**（与 dev/`npm start` 同端口——油猴脚本据此定位客户端）并开窗口加载；数据库落在 `%APPDATA%/aiya-publisher/data/publisher.db`。
- **electron 版本必须精确钉死**（`42.11.8`，范围值会让 electron-builder 拒绝工作），且 `npmRebuild: false`——本机没有 MSVC 工具链，better-sqlite3 用 **Electron ABI 的 prebuild**：进入 `node_modules/better-sqlite3` 执行 `npx prebuild-install --runtime electron --target <electron版本>`，GitHub 不通时从 npmmirror 手动取 `https://registry.npmmirror.com/-/binary/better-sqlite3/v<版本>/better-sqlite3-v<版本>-electron-v<ABI>-win32-x64.tar.gz` 解到包根（ABI 映射用 node-abi 查：electron 42 → 146；升级 electron 主版本必须重取对应 ABI）。
- **网络受限时的工具包下载**：electron-builder 首次打包要从 GitHub 拉 winCodeSign/nsis 工具集。TUN/系统代理只救得了 curl 救不了 node 时，用 curl 把 `winCodeSign-2.6.0.7z`、`nsis-3.0.4.1.7z`、`nsis-resources-3.4.1.7z` 下载到本地目录，`python -m http.server 80 --directory <目录>` 起本地镜像（**必须 80 端口**：缓存目录名取自 URL host:port，冒号在 Windows 非法），再以 `ELECTRON_BUILDER_BINARIES_ALLOW_HTTP=true ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL=http://localhost` 打包；三个 7z 同时平铺一份到目录根（两条取用路径都要能命中）。
- 渲染层依赖（react/ag-grid）在 devDependencies——只参与 vite 构建；打进安装包的 dependencies 仅剩 fastify/@fastify/static/better-sqlite3/undici。

首次使用：右上「设置」打开模态框 → 填站点地址 / 用户名 / 应用密码 → 「测试连接」（用表单当前值探测，不落库）→ 「保存」→「同步」。应用密码在 WP 后台（用户 → 资料 → 应用密码）生成；推荐编辑/管理员级账号（可代发任意作者，无该能力只能存草稿/署名自己）。

- **HTTP 代理**：设置里的「HTTP 代理」（如 `http://127.0.0.1:7890`，支持 `user:pass@host:port`）作用于发帖器的全部出站站点请求（连接测试/同步/推送），改完即生效；本地界面与数据库不受影响。智能摄取窗口的模型调用默认也走它（窗口里的开关可关掉改为直连），地址仍只在这里维护一份。
- **作者**：同步时从站点 `GET /users` 拉取全部可发帖账号（author 及以上），默认作者在设置里选，已有文章在详情面板随时切换（代发需账号有 `edit_others_posts`）。

## 使用语义

- **同步**：首次全量分页拉取，之后按 `lastSyncCursor`（远端 modified 游标）增量。词法术语表随同步整体刷新，作者从帖子里自动收录。单个畸形条目会被跳过并在完成消息里计数（「跳过畸形 N 条」），不中断整轮。
- **推送队列 = dirty 标记位**：任何编辑置 dirty；「推送全部」逐条顺序执行（无 post_id → 新建，有 → 更新），行构建 + 站点调用 + 回写整体在逐行 try 内，单条坏行只损失自己。**连续 3 次传输层失败（站点不可达/代理死）熔断本轮**：剩余行保持待推送、不写错误，网络恢复后再推；4xx 证明链路可用，会重置计数、照常逐行试。
- **拉取/推送互斥**：服务端单执行槽，运行中的拉取/推送会让并发请求拿到 409（多标签页也生效）；界面上这两个操作运行期间，操作栏按钮全部失效。
- **快照（snapshot）**：每行保存最近一次站点确认的完整状态，支撑「还原到快照」与冲突判定——本地 dirty 且线上 modified 比快照新 → 冲突标记（不覆盖本地，处理方式：还原后重新同步，或直接推送覆盖）。
- **推送载荷是整行全字段**（标题/正文/状态/作者/术语/fileserve 整体写入）。日期只在「与快照不同」时携带：未改日期的行推送后，服务端的「fileserve 值变 → 发布时间刷当前」规则得以生效；显式改了日期则显式日期优先。**回写只覆盖没动过的行**：一次推送把该行快照握在手里跨过网络调用（最长 30 秒），期间若这行又被编辑，站点回执就不得覆盖更新的本地内容——站点事实（post_id / slug / modified / 快照 / last_pushed）照常落库，可编辑字段保持本地值且该行继续留在待推送队列，免得「推送期间的编辑既没保存、也再不推送」。
- **只服务本机**：服务端在任何路由之前校验 `Host` 与 `Origin`——Host 必须是 `127.0.0.1` / `localhost` / `::1`（挡 DNS rebinding），带 Origin 的请求必须同为本机。这一层挡的是「随便一个开着的网页就能驱动发帖器同步/推送」：Fastify 默认解析 `text/plain`，跨站 `fetch(..., { mode: "no-cors" })` 属简单请求、不经预检就能打到写路由。唯一例外是网盘回填的两个端点放行 `https://pan.baidu.com`。
- **表格（列表）**：每列带写死的 colId，列宽/列序/排序存在 `publisher.gridColumnState.v2` 并跨会话保留。列标识不随列定义重建漂移，保存的排布因此永远指向同一列（v1 是在 AG Grid 自动生成的列 id 上写的，读它会把列顺序搅乱，已弃读）。新建行落在 `ORDER BY local_id` 的自然末尾（没有排序时就是最后一行），建完自动选中并滚动到它；ID 与发布时间列的排序把「还没推送 / 还没有日期」的行当作最新一条（升序排最后、降序排最前），不再像默认比较器那样把空值浮到最前。
- **右侧编辑只改一行**：详情面板的防抖保存与表格单元格编辑都只把那一行写回列表，不重新拉取整份状态——只有拉取、设置保存、CSV 导入这类真会动多行的操作才整体刷新。
- **网盘回填与已打开的编辑器**：脚本把链接直接写进本地库（不经过界面），所以开着的标签页得自己发现它——客户端每 2 秒拉一次 `GET /api/netdisk/applied` 游标，把刚回填的行就地换掉，列表徽章与文件列表列随即更新。编辑器草稿同时记着「我是基于哪一版文件列表改的」（`fileserveBase`），保存时服务端按**组**做三方合并：库里被脚本动过的那一组保留库里的值，其余按草稿写。因此开着回填之前的旧草稿去改标题、或同时自己又加了一组，都不会把刚回填的链接冲掉；真发生这种合并时界面会明说并重新载入该行。
- **术语引用**：数字 = 线上既有 term id；`name:xxx` = 线上尚无的新标签（推送时由站点自动创建，需要 `manage_terms` 能力）。推送响应回填真实 id。
- **分类层级**：`resource_category` 是站点侧唯一的层级词法（同步缓存 `terms.parent`，插件 `/taxonomies` 提供该字段）。详情面板把它按**最外层父级分组渲染**：一组占一行（父在前、子在后带 `└`），组与组换行，因此子分类不会被误认成同级；其余五个词法保持平铺。表格「分类」列显示 `父 / 子` 全路径（平铺词法仍显示名字）。同名子分类（WP 允许）在摄取按名称折叠时取**本地引用次数最多**的那个，并在预览里给出「有 N 个同名术语」的提示。
- **CSV 导入**：「导入 CSV」批量建本地新行入待推送队列（不推送，推送走既有按钮）。首行表头，向导自动猜测列映射（标题/正文/状态/发布时间/发布者/六个术语列，可改）；标题必填、状态含中文别名（草稿/发布/定时）、发布时间折叠为 `YYYY-MM-DDTHH:mm`（future 必须带时间）；「发布者(账号)」按显示名匹配作者表（未匹配默认该行报错，可切换回落默认作者）——裸「作者」表头是 `resource_author` 术语列，不是账号；编码自动识别 UTF-8/GBK/UTF-16，单次上限 5000 行。好行单事务整体入队、坏行按行号报原因，重复导入同一文件会建重复行。向导里的预览计数与实际写入跑的是同一份 `shared/import.ts` 纯函数。
- **fileserve 编辑器**：组卡片 + 适配器下拉，字段表与归一化语义在 `shared/fileserve.ts` 逐字镜像 PHP 侧（未知键丢弃、缺省补默认、price 折非负 int）；空配置推送 = 清除线上文件列表（会触发刷时间）。
- **组级网盘字段（radio）**：每组（platform 适配器）一个「网盘」radio（百度网盘/夸克网盘，注册表在 `shared/fileserve.ts`），存本地字段 `netdisk`（推送前剥除、站点丢弃、同步/回写保留）；**标题跟随网盘自动填写**（手写标题不被覆盖），空标题不是合法状态。组没有草稿态；行级 dirty 是唯一推送触发。**空链接组不随推送上行**——它们是网盘管线的待办，留在本地等脚本回填（「可补」徽章因此常驻）；同步时站点删除已填组会传播，待办组不受影响。夸克已进注册表，管线接入只是再加一个换 `netdisk` 参数的脚本实例。
- **文件列表状态徽章**（标记列，说网盘管线的话）：行无文件列表 →「无文件挂载」；有空链接的 platform 组 →「可补：百度网盘」（按 netdisk 字段聚合，悬停列组号）——表达的是脚本可以来补这组，取代旧的推送向徽章；链接齐了无徽章（推送状态由「待推送」表达）。
- **本地目录（可选的本地暂存）**：已发布行的文件列表「+ 添加组」时，可在「本地目录创建根」（设置里配）自动创建暂存目录。本地暂存目录的命名规则（网盘目录另有一套，见「网盘分享回填」）：`{帖子ID补零6位}-{后缀}`，后缀在设置的「目录命名」里选 **ID-SLUG / ID-标题 / 仅 ID**（**SLUG 缺失回落标题**：slug 取自线上 permalink 末段；slug 捕获之前同步进来的历史行没有该字段，除非重新同步，否则一直回落标题）；非法字符净化、超长按码点截断。识别固定按补零 ID 段精确判定（仅 ID 模式即全名），目录不落库、文件系统即真源。**纯本地辅助**：网盘回填不读它、不依赖它——网盘侧目录由脚本自行创建；它只服务「想把待传文件先在本地归拢一份」的习惯。
- **正文插图**：详情面板正文上方的**拖放区**把本地图片经本地服务送进站点图床（`POST /api/uploads/image` → 插件 `POST /aiya-publish/v1/uploads/image`），**落盘路径与处理管线与 core 后台图床完全一致**（`wp-content/aiya_upload_pics/YYYY/MM/`，缩放/水印/格式走同一条 image-processor 管线），单张上限 10MB；可拖入或点选多张，按选择顺序把 `<img src>` **一律插到正文最前**（没有行内插入——线上程序取正文第一张生成封面，位置是发布契约的一部分），随正文一起走既有防抖保存与推送。失败的那一张单独报错，已上传的照常落地；窗口其他位置拖入文件会被忽略，免得浏览器把整个界面替换成那个文件。图片只进站点池、不落本地库：删本地行或删帖都不回收它（与后台图床现状一致）。
- **运行日志**：底部日志面板登记全部操作事件（同步/推送/目录/启动），按 id 增量轮询、可折叠、一键清空；服务端保留最近 2000 条滚动裁剪。表格的错误列已撤，行错误改为「标记」列的红色徽章（悬停看原文）。
- 本地删行只删本地记录，**不删除线上帖子**。
- **UI 约定**：无嵌套模态框——表格行内编辑 + 右侧详情面板承载主编辑面；弹层只允许单层（设置、CSV 导入等）。

## 智能摄取入口（/api/ingest，给外部整理器用）

「一段原始语料 → 一条结构化草稿」这段活由外部进程做，发帖器只留一个固定的结构化入口：它不含任何模型代码、不存任何密钥、不加任何依赖，收到的是已经成形的行。当前配套整理器是 `intake/`（独立进程 + 自己的窗口，见 `intake/README.md`，主窗口操作栏的「智能摄取」按钮直接开它），入口本身对任何本机客户端一视同仁——脚本、油猴也可以直接打。三个端点：

- `GET /api/ingest/context`：一次拿全做草稿要用的参照——六个词法的全部术语（**按本地已同步行的引用次数降序**，供「优先用站点已有的词」；层级词法另带 `parent` 与 `path`「父 / 子」）、作者名单、默认作者、新行默认状态、HTTP 代理地址、网盘注册表与「挂网盘待办组」当前选择、目标站点地址与同步游标、单次行数上限。刻意比 `/api/state` 小得多：不含任何行的正文，也不含应用密码。
- `POST /api/ingest/preview`：用同一份纯函数做校验与归一化，**不写库**；返回折叠后的行、逐行错误与逐行提示（`warnings`，目前用于「同名术语取哪一个」）。术语引用是原始 ref：纯数字 = 命中既有术语 id，`name:` 前缀 = 推送时由站点创建（需要 `manage_terms`）。
- `POST /api/ingest`：好行单事务整体入队为 `dirty`，状态取行里的 `status`、缺省用设置里的「新行默认状态」，坏行按序号报原因；**只入队，不推送**——推送仍是主窗口的动作（等网盘回填后再统一推）。日志 scope 是「摄取」，来源由请求里的 `source` 字段署名。

行字段：`title`（必填）/ `content`（HTML）/ `status`（**可选**；缺省 = 设置里的新行默认状态；`future` 必须带 `dateLocal`）/ `dateLocal`（可选，墙钟 `YYYY-MM-DDTHH:mm`，不做时区换算；不填就不携带日期，站点的刷时间规则照旧）/ `authorId`（可选，id 或显示名，缺省用默认作者）/ `terms`（六个词法 → 名称或 id 数组）/ `fileserve`（组对象，与详情面板同一套归一化：未知键丢弃、缺省补默认、price 折非负 int；**省略该字段 = 挂上设置里的网盘待办组，显式 `null` = 这一行不要文件列表**）。单次上限 500 行，与 CSV 导入共用同一批归一化函数（`shared/import.ts` + `shared/ingest.ts`），预览显示的就是写入会得到的东西。

**图片不走这个入口**：正文图片由主窗口的拖放区上传并插到正文最前（见「正文插图」），摄取入口只收文字与标签；本机守卫照旧作用于这三个端点：跨站页面既过不了 Host/Origin 校验，也拿不到 CORS 头；因此配套整理器把发帖器调用**在自己进程里重新发出**，浏览器只与整理器同源通信。

## 数据（publisher.db，SQLite / WAL）

- `settings`：站点地址、用户名、应用密码（**本地明文**，本机工具可接受，勿把 db 文件提交或外传）、HTTP 代理、默认作者、同步游标、本地目录创建根、目录命名后缀、**新行默认状态**（草稿/发布，作用于智能摄取与「新建行」）、**挂网盘待办组**（开关 + 白名单多选，作用于摄取 / CSV 导入 / 新建行三条新建路径：新行会带上所选网盘的空链接组，等脚本回填；空链接组不随推送上行）
- `authors` / `terms`：作者登记表（同步自动收录 + 手工备注）、词法术语缓存（含层级词法的 `parent`，老库缺列由启动时的守卫式迁移补 0，下次同步回填真实父级）
- `posts` + `post_terms`：行状态（含 dirty/conflict/missing 标记、last_error、快照 JSON、`date_gmt` 站点回执时间戳）、线上 slug（取自 permalink）、fileserve 整份 JSON 与术语引用（`fileserve_pushed_digest` 已随徽章改版退役：老库残留列 inert，不再读写）
- `logs`：运行日志（level/scope/ref/message，滚动保留 2000 条）。本地目录不在 SQL 里——目录名可由帖子 ID 推导，文件系统即真源。

`PUBLISHER_DATA` 环境变量可重定向数据目录（默认进程工作目录）。

## 开发

```bash
npm run check   # tsc 双配置（server/tests 与 web）
npm test        # vitest：fileserve 模型、载荷构建、补完推送、暂存目录与日志等
```

结构：`server/`（Fastify + better-sqlite3 + WP 客户端 + 同步/推送）、`src/`（React 19 + Tailwind 4 + AG Grid Community）、`shared/`（fileserve 数据模型与 CSV 导入模型，前后端共用）。

## 网盘分享回填（netdisk/aiya-netdisk.user.js）

油猴脚本（Tampermonkey，百度网盘 web 端）负责「建目录 → 分享 → 回填」：文件上传由网盘客户端人工完成，脚本在 `pan.baidu.com` 页内按队列项在配置的网盘根目录下**定位或直接创建** `CA{帖子ID补零6位}` 目录（脚本自己拼这个形状，**不跟随「目录命名」设置**；新栈 `/api/create`，页面实测取证；识别按补零 ID 段，`CA003276` 与旧的 `003276-标题` 都认，已上传的目录永远复用），创建分享（页内动作，无 cookie 出浏览器；文件夹分享是实时视图，之后客户端传进来的文件自动出现在链接里），把链接回填到发帖器文件列表——**回填的链接自带 `?pwd=` 提取码**（脚本 `withPwd`：已有 `pwd` 参数则不动，带查询串用 `&`，片段留在最后），**提取码同时单独写进组的「提取码」字段**；回填只认领 `netdisk=baidu` 的空链接组，跨管线拒绝写入。发帖器侧对接端点为 `GET /api/netdisk/queue?netdisk=baidu`、`POST /api/netdisk/result`（CORS 钉死 `pan.baidu.com` 源）与**给界面用的** `GET /api/netdisk/applied`。脚本默认连 `http://127.0.0.1:5175`（脚本内 `GM_getValue("publisher", …)` 的默认值），**dev 与打包版都绑这个端口**，因此同一时刻只跑一个。使用：

1. Edge/Chrome 装 Tampermonkey → 新建脚本 → 粘贴 `netdisk/aiya-netdisk.user.js` 全文保存；
2. 打开 `pan.baidu.com`（已登录），顶栏 LOGO 旁的「AIYA 挂钩」显示发帖器地址与连接状态，点开面板确认网盘根目录（默认 `/`）；
3. 发帖器里给已上线行添加空链接的网盘组（默认不勾推送）→ 面板「刷新队列」→「开始处理」逐行建目录/分享/回填（单行失败即停，面板显示 errno 中文提示）。

工作顺序自由：先「处理」建好目录与链接、再往里传文件也可以（推送时机自己掌握，别在内容落地前推上线）。分享有效期默认永久（需会员，errno -70 时换 30/7 天）。回填置 dirty，随正常推送写入站点（空标题的组回填时按网盘名兜底）。

## 配套 WP 插件（wordpress_plugins/aiya-cms-resource-publisher）

WP 侧配套插件（AIYA CMS - Resource Post Publisher）随本仓库单仓库维护，源码在 `wordpress_plugins/aiya-cms-resource-publisher/`（REST 命名空间 `aiya-publish/v1`，端点语义见其 `README.md`）。

- 不声明 `Requires Plugins` 头（该头按目录 slug 匹配依赖，core 插件本地 slug `aiya-core`、线上 `aiya-cms-core`，无法统一）：未安装/未启用 core 时入口文件运行时兜底——显示管理提示且不注册任何路由（resource 类型由 core 注册）。
- **部署**：`npm run plugin:sync` 把源码镜像到 `../wp-content/plugins/aiya-cms-publish`（跳过 `.git`/`vendor`；目标侧 `vendor/` 是容器内 QA 工具，装一次即可，不同步）。开发循环：改 `wordpress_plugins/aiya-cms-resource-publisher` → `npm run plugin:sync` → 容器内检查（见插件 README）。
- **发布包**：`npm run plugin:archive` 产出 `archives/aiya-cms-publish-<版本>.zip`（WP 安装器可直接上传；zip 内顶层目录为部署 slug，tests/QA 配置/composer 文件已剔除）。
- 该插件历史上是独立 git 仓库，已 subtree 并入本仓库（提交历史保留）。
