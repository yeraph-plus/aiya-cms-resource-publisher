# skills/

给外部 agent 用的技能包，随仓库走。发帖器本体不含任何模型代码——这里只有「怎么把作品信息整理成一行草稿」的流程、格式契约，和六个通往本地接口的具名命令（一个前置探活 + 五个操作）。

```
skills/
├── aiya-post-writer/
│   ├── SKILL.md              入口：定位、前置探活、端点表、基础约束、输入分支、工作流
│   ├── references/
│   │   ├── api.md            六个命令的参数、payload 字段、返回与报错
│   │   ├── writing.md        标题语法、正文骨架、六词法取舍（基于站内 886 篇实证）
│   │   └── images.md         封面来源、合格线、暂存与首图规则
│   └── scripts/
│       └── publisher.mjs     六个具名命令的实现（Node 24，无依赖）
└── README.md
```

## 装到 agent 那边

技能目录本身可搬。WorkBuddy 从 `~/.workbuddy/skills/` 读用户级技能，所以要在会话里生效，把这个目录链过去（Windows 用目录联接，不需要管理员权限）：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.workbuddy\skills\aiya-post-writer" -Target "D:\WordPress_Dev\publisher\skills\aiya-post-writer"
```

联接之后只有一份文件：在仓库里改，agent 那边立刻是新版；回头 `git commit` 就是「备份到仓库」。要断开就删那个联接（`Remove-Item` 那个目录，不会删源文件）。

技能里的命令按**仓库根目录**相对路径写（`node skills/aiya-post-writer/scripts/publisher.mjs`），所以 agent 的工作目录得是仓库；或者用脚本的绝对路径。`scripts/publisher.mjs` 自身不依赖仓库任何文件。

## 为什么是具名命令而不是一套端点

发帖器的本地服务有同步、推送、删行、改设置的门，全都在同一个 host 上。技能只暴露具名动词，是为了让「agent 能做的事」在提示词层面就是封闭的：

| 允许 | 不允许 |
|---|---|
| 探活、读词法与默认值 | 推送（`/api/push`） |
| 查本地重复 | 删行（`DELETE /api/posts/:id`） |
| 暂存图片 | 改设置、改既有行 |
| 校验草稿 | 直接打站点 REST |
| 建新的待推送行 | 读写数据库文件 |

端口不写进文档也不写进 payload：`scripts/publisher.mjs` 自己解析（`PUBLISHER_BASE` 优先），并用 `/api/health` 的 `app` 字段确认身份。换端口、换机器都不需要改技能。

## 版本

当前 v0.1，按「前置 → 端点表 → 基础约束」的顺序先把骨架钉住，正文与配图规则先跑几版真实作品再收敛。迭代时只改这个目录，改完在仓库里提交一次即可。

## 扩展

分支子技能（解压包、启动程序实拍、整页抓取、网盘上传与杀毒验证）在 `SKILL.md` 末尾的「扩展位」登记触发条件，契约固定为「只产出事实或已暂存的图片，不碰发帖器状态」。主流程的六个命令与产出字段保持不变，这样新增分支不会让提示词和接口一起漂移。
