# aiya-publish

为外部发帖器提供 REST API 的 WordPress 插件，命名空间 `aiya-publish/v1`。**随发帖器仓库单仓库维护**：本目录是源码真身（`publisher/wordpress_plugins/aiya-cms-resource-publisher`），`wp-content/plugins/aiya-cms-publish` 只是 `npm run plugin:sync`（发帖器仓库）产出的部署副本；历史上的独立 git 仓库已 subtree 并入发帖器仓库。

**依赖 aiya-core**：不声明 `Requires Plugins` 头——该头按插件目录 slug 匹配依赖，而 core 插件本地 slug 为 `aiya-core`、线上为 `aiya-cms-core`，slug 头在两侧不可能同时成立（2026-09-29 摘除）。未安装/未启用 aiya-core 时由入口文件运行时兜底：显示管理提示且不注册任何路由；守卫在钩子回调内判定（WP 按选项顺序加载插件，加载期查 `AIYA_CORE_VERSION` 可能早于 core 而误判）。与 aiya-core 仍保持**零代码耦合**（不调用其类、不挂其内部过滤器），resource 文章类型由 core 注册，运行时以其启用为前提。

## 认证

- 全部路由要求 **WordPress 应用密码**（Basic auth）：WP 后台 → 用户 → 资料页 → 应用密码。
- 权限：读 = `edit_posts`；写 = `edit_posts` + 逐对象 `edit_post`；`status=publish` 需 `publish_posts`；`authorId` 代发他人需 `edit_others_posts`（编辑/管理员级账号满足）。
- 未登录 / 凭据无效的请求由本插件的 permission_callback 回 401；已登录但能力不足回 403。本插件把 `/aiya-publish/v1` 宣告进 `aiya_core_firstparty_rest_namespaces`，因此 aiya-core 的匿名锁（`lock_wp_v2`）不再把该命名空间剥成 404——各类会话都能拿到自己能力等级对应的确切错误。
- 纯 HTTP 环境使用应用密码需要 `WP_ENVIRONMENT_TYPE=local`（本地 compose 已设置）。

## 端点

| 路由 | 说明 |
|---|---|
| `GET /ping` | 连接测试：当前用户、关键能力、resource 类型是否存在 |
| `GET /users` | 可作为发帖署名的账号（`edit_posts` 及以上），`{id, login, name}` 裸数组 |
| `GET /taxonomies` | resource 六词法与全部术语（id/name/slug/count） |
| `GET /resource` | 同步列表：`page`/`per_page`(≤100)/`modified_after`(GMT，增量)；`X-WP-Total` 头 |
| `GET /resource/{id}` | 单条 |
| `POST /resource` | 新建：`title` 必填，`content`/`status`/`date`+`dateGmt`/`authorId`/`terms`/`fileserve` 可选 |
| `PUT /resource/{id}` | 更新：字段给了才写；`fileserve` 整体写入 |

条目形状：`{id, status, title, content(源码), date, dateGmt, modified, modifiedGmt, link, authorId, authorName, terms{词法:[{id,name,slug}]}, fileserve}`。

## 写入语义

- **术语**：`terms` 按词法整组替换；元素为 term id（不存在 → 400）或名字（不存在自动创建，需该词法 `manage_terms`）。
- **fileserve**：复刻 aiya-core `Domain/FileServe/Config` 的归一化语义——短 id 键、未知键丢弃、缺省补默认、price 折为非负 int、adapter 缺失/未知或组不可读 → 400 拒绝整次写入；空对象 → 删除 meta；落库为一条 JSON 字符串（与 metabox 相同的 `wp_json_encode` + `wp_slash` 路径）。
- **时间刷新**：`fileserve` 归一化后与现值深比较，**值有实际变化才把发布时间刷为当前**；载荷显式带 `date`/`dateGmt` 则显式优先；未带 `fileserve` 键绝不刷。
- 写入走 `wp_insert_post`/`wp_update_post`，aiya-core 既有 `save_post` 管线（缩略图调度等）自然生效。

## 本地开发

**源在本仓库**（`publisher/wordpress_plugins/aiya-publish`），改动后用发帖器仓库的 `npm run plugin:sync` 镜像到 `wp-content/plugins/aiya-publish` 再验证（目标侧 `vendor/` 与 `.git` 不参与同步）。

宿主机无需 PHP，全部在容器内执行（vendor 已随部署副本安装过一次；重建时先下载 composer.phar）：

```bash
docker compose run --rm --entrypoint sh wpcli \
  -c "curl -fsSL https://mirrors.cloud.tencent.com/composer/composer.phar -o composer.phar \
      && php composer.phar install"

docker compose run --rm --entrypoint sh wpcli \
  -c "cd /var/www/html/wp-content/plugins/aiya-publish \
      && php vendor/bin/parallel-lint --exclude .git --exclude vendor . \
      && php vendor/bin/phpunit \
      && php vendor/bin/phpstan analyse --memory-limit=1G --no-progress \
      && php vendor/bin/phpcs"
```

插件无设置页、无数据表、无 cron、无卸载清理（零自有持久化数据）。
