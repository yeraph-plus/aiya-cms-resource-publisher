# 六个命令（一个前置 + 五个操作）

所有命令在仓库根目录执行，端点地址由脚本解析（`PUBLISHER_BASE` 环境变量优先，否则探 `127.0.0.1:5175` 并用 `/api/health` 的 `app` 字段确认「确实是发帖器」）。脚本会拒绝任何不认识的目标——它不是通用 HTTP 客户端。

```bash
node skills/aiya-post-writer/scripts/publisher.mjs <命令> [参数]
```

| 命令 | 底层端点 | 作用 | 写库 |
|---|---|---|---|
| `health` | `GET /api/health` | 探活、身份、配置状态 | 否 |
| `context` | `GET /api/ingest/context` | 词法 / 作者 / 默认值 / 上限 | 否 |
| `lookup` | `GET /api/state` | 本地查重（脚本只投影标题相关字段） | 否 |
| `stage` | `POST /api/images` | 图片复制进本地 images 目录 | 只写图片文件 |
| `preview` | `POST /api/ingest/preview` | 校验 + 归一化 | 否 |
| `ingest` | `POST /api/ingest` | 入队为待推送的脏行 | 是 |

退出码：`0` 成功；`1` 调用失败（连不上、HTTP 错误、参数不对）；`2` 调用成功但有行被拒——**看返回里的 `errors`**。

---

## health

```bash
node … health --pretty
```

```json
{
  "base": "http://127.0.0.1:5175",
  "app": "aiya-publisher",
  "version": "0.1.0",
  "port": 5175,
  "pid": 19312,
  "startedAt": "2026-11-03T03:12:41.008Z",
  "uptimeSec": 2741,
  "dataDir": "C:\\Users\\me\\AppData\\Roaming\\aiya-publisher\\data",
  "configured": true,
  "defaultStatus": "draft",
  "ingestMaxRows": 500
}
```

每次写操作之前跑。判断只看三件事：命令有没有退出 1、`app` 是不是 `aiya-publisher`、`configured` 是否 `true`。`dataDir` 是暂存图片的落点（`<dataDir>/images`），排查「图存哪了」时用它；`version` 是排障的第一手信息。

`configured: false` 不阻止起草，但推送时图片传不进图床——回报里要说明。`base` 只是这次的解析结果，不要写进 payload 或后续指令，下次端口可能不同。

## context

```bash
node … context --lines            # 推荐：文本形式，省上下文
node … context                    # 整份 JSON
node … context --taxonomy resource_category --pretty
```

`--lines` 输出：

```
# 站点 https://…｜默认作者 1｜默认状态 publish｜单次上限 500 行
# 分类是层级词法，用 id 引用…；其余词法 id 或名称都可以，优先 id
## resource_category（190 个，按使用次数）
500	漫画	167
534	单行本	154
…
## authors（作者账号，不是 resource_author 术语）
1	admin
```

`--lines` 默认每词法 300 条（`--limit` 可改）。JSON 形式的 `terms[slug][]` 每项是 `{ id, name, slug, parent, count, path }`，`path` 是 `父 / 子` 全路径，`count` 是本地已同步行的引用次数。

其他字段：`siteUrl`、`defaultAuthorId`、`defaultStatus`、`ingestMaxRows`、`authors`、`netdiskOptions`、`netdiskTodo`、`priceDefault`、`proxyUrl`、`lastSyncCursor`。

## lookup

```bash
node … lookup "美少女万华镜"
```

```json
{ "query": "美少女万华镜", "count": 1, "rows": [
  { "localId": 812, "postId": 4021, "status": "publish", "title": "[GALGAME][ωstar] 美少女万华镜 系列全 [汉硬合集]", "dirty": false, "missing": false, "lastError": null }
] }
```

只看本地库，不查站点。命中就有可能是重复发布——交给用户判断，不要自己另起标题绕过。`--limit` 默认 20。

## stage

```bash
node … stage --url "https://…/cover.jpg" [--name "封面.jpg"]
node … stage "D:/tmp/cover.png" [--name "封面.jpg"]
```

返回 `{ path, src, name }`。`path` 是这台机器上的真实绝对路径（`<数据目录>/images/<内容哈希>.<ext>`），`src` 是 `file:///…` 形式——**正文里引用 `src`**。

`--url` 由脚本下载：跟随跳转、带浏览器 UA、要求 `content-type: image/*`、超过 10MB 直接拒。本地文件按扩展名判 MIME，不支持的格式（含 SVG）报错。

## preview

```bash
node … preview draft.json --pretty
node … ingest draft.json | node … preview -      # 也可以从 stdin 读
```

请求体 `{ rows: [...] }`，脚本也接受裸数组（自动包一层）。返回：

```json
{
  "count": 1,
  "rows": [{ "status": "publish", "title": "…", "content": "<img …>", "authorId": 1, "dateLocal": "", "terms": { "resource_category": ["501"] }, "fileserve": null }],
  "errors": [{ "row": 1, "title": "…", "error": "分类里没有 id 999 的术语" }],
  "warnings": [{ "row": 1, "title": "…", "warning": "内容描述「纯爱」有 2 个同名术语，已取使用最多的 #407" }]
}
```

- `rows[].terms` 是**归一化后的引用**：纯数字 = 命中既有术语，`name:xxx` = 推送时由站点创建。
- `errors` 非空必改，改完重跑。
- `warnings` 是提示不是错误，但要读：同名术语折叠、未知词法都从这里露出。
- 整个请求被拒（没有 rows、超过 500 行）时返回 HTTP 400，脚本退出码 1。

## ingest

```bash
node … ingest draft.json --source "agent/2026-11-batch"
```

```json
{ "imported": 1, "localIds": [901], "errors": [], "warnings": [] }
```

好行整体入队为 `dirty` 行，状态取行里的 `status`（不填 = 设置里的新行默认状态）。**只入队，不推送**：推送是人在发帖器里按的按钮。`source` 会进运行日志（截断 32 字），写清是哪个 agent/批次，方便回溯。

---

## payload 字段

```json
{
  "rows": [
    {
      "title": "[GALGAME][Yuzu-Soft] 千恋＊万花 [汉硬]",
      "content": "<img src=\"file:///C:/…/images/9f2c1a4e77b0d3c8.jpg\" alt=\"封面\" />\n<blockquote>…</blockquote>\n<hr />\n…",
      "terms": {
        "resource_category": ["534", "501"],
        "resource_author": ["1234"],
        "resource_original": ["原创"],
        "resource_content": ["纯爱", "日常"]
      }
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | 是 | 去掉首尾空格后不能为空 |
| `content` | 否 | HTML 片段。空正文能入队，但没意义——至少要有封面 + 信息块 |
| `terms` | 否 | 六个词法 → 名称或 id 的数组。未知词法名会报错 |
| `status` | 否 | `draft` / `publish` / `future`；不填用设置里的新行默认状态 |
| `dateLocal` | 否 | `YYYY-MM-DDTHH:mm` 墙钟时间，不做时区换算；`future` 必须带 |
| `authorId` | 否 | 账号 id 或显示名；不填用默认作者。**不是 `resource_author` 术语** |
| `fileserve` | 否 | 网盘文件列表。**省略** = 挂上设置里选定的待办组（对资源帖通常就是想要的）；显式 `null` = 这一行不要文件列表。一般不要碰这个字段 |

单次上限 500 行，但别一次塞满：先 1 行跑通 `preview` → `ingest`，用户认可标题与词法风格后再批量。

## 出错时

| 现象 | 原因 | 处理 |
|---|---|---|
| 「连不上发帖器」 | 桌面版没开 / 端口被改 | 让用户启动，或设 `PUBLISHER_BASE` |
| health 通了但 `app` 不对 | 那个端口被别的程序占着 | 报给用户，不要重试 |
| `errors` 里「分类里没有 id N 的术语」 | id 抄错或站点已删该词 | 回 `context` 重取 |
| `errors` 里「未知词法：xxx」 | 词法 key 拼错 | 只有那六个 key |
| `errors` 里「定时（future）行必须携带发布时间」 | `status: future` 没给 `dateLocal` | 补时间，或改成默认状态 |
| `stage` 报「不是图片」 | 地址返回的是 HTML（防盗链、登录页） | 换直链，或先本地存一份再 `stage <文件>` |
| `stage` 报「图片太大」 | 超过 10MB | 换小图，不要自己压缩后冒充官方图 |

任何一条错误都不要靠删字段糊过去——`errors` 说的是「这行现在写不进站点」，删掉字段只是把问题推给推送那一刻。
