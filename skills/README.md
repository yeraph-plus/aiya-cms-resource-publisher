# skills/

给外部 agent 用的技能包，随仓库走。发帖器本体不含任何模型代码——这里只有「怎么把作品信息整理成一行草稿」的流程、格式契约，和五个通往本地接口的具名命令。

```
skills/
├── aiya-post-writer/
│   ├── SKILL.md              入口：边界、五个命令、输入分支、工作流
│   ├── references/
│   │   ├── api.md            命令参数、payload 字段、返回与报错
│   │   ├── writing.md        标题语法、正文骨架、六词法取舍（基于站内 886 篇实证）
│   │   └── images.md         封面来源、合格线、暂存与首图规则
│   └── scripts/
│       └── publisher.mjs     五个具名命令的实现（Node 24，无依赖）
└── README.md
```

## 装到 agent 那边

技能目录本身可搬。要让它在一个 agent 会话里生效，把整个目录复制或链接到该 agent 的技能目录：

```bash
# WorkBuddy 用户级技能
ln -s /d/WordPress_Dev/publisher/skills/aiya-post-writer ~/.workbuddy/skills/aiya-post-writer

# 或者复制（改完要重新复制）
cp -r skills/aiya-post-writer ~/.workbuddy/skills/
```

用软链时注意：技能里的命令按**仓库根目录**相对路径写（`node skills/aiya-post-writer/scripts/publisher.mjs`），所以 agent 得在仓库里跑——或者把 `PUBLISHER_BASE` 与脚本绝对路径换成它自己的约定。软链到别处时，`scripts/publisher.mjs` 自身不依赖仓库任何文件，只有调用方的工作目录需要是这个仓库。

## 为什么是五个具名命令而不是一套端点

发帖器的本地服务有同步、推送、删行、改设置的门，全都在同一个 host 上。技能只暴露五个动词，是为了让「agent 能做的事」在提示词层面就是封闭的：

| 允许 | 不允许 |
|---|---|
| 读词法与默认值 | 推送（`/api/push`） |
| 查本地重复 | 删行（`DELETE /api/posts/:id`） |
| 暂存图片 | 改设置、改既有行 |
| 校验草稿 | 直接打站点 REST |
| 建新的待推送行 | 读写数据库文件 |

端口不写进文档也不写进 payload：`scripts/publisher.mjs` 自己解析（`PUBLISHER_BASE` 优先），文档里只有命令名。换端口、换机器都不需要改技能。

## 扩展

分支子技能（解压包、启动程序实拍、整页抓取）在 `SKILL.md` 末尾的「扩展位」登记触发条件，契约固定为「只产出事实或已暂存的图片，不碰发帖器状态」。主流程的五个命令与产出字段保持不变，这样新增分支不会让提示词和接口一起漂移。
