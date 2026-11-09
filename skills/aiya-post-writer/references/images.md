# 封面与配图

## 为什么第一张图必须是封面

站点生成卡片和封面时，先看特色图，没有就取**正文里的第一张图**，而且只认站点自己托管的图（远程地址解析不到本地文件，直接跳过，退化成纯色/纹理底）。发帖器在推送这一行时才把暂存图传进站点图床，所以：

- 正文第一张 = 封面，不能在前面插任何东西（引言、标题、空行都不行）
- 图必须经 `stage` 落到本地，正文里是 `file:///…` 引用；推送后会被自动替换成站点 URL
- 远程直链即使能显示，也不会成为封面

## 找什么样的图

优先级从高到低：

1. **官方竖版封面 / 主视觉（key visual）** —— 官网、商店页（Steam、DLsite、FANZA、BOOTH）、官方 SNS 发布图
2. **官方横版主视觉 / 宣传图** —— 没有竖版封面时用
3. **数据库站的封面** —— VNDB、Bangumi、DLsite 作品页的主图（这些站本身就是官方图的镜像）
4. **官方截图 / 标题画面** —— 只作补充，不作封面

合格线：

- 宽度 ≥ 800px，能到 1200px 以上更好（站点会按版式裁剪，源图太小会糊）
- 单张，不是拼接长图、不是带页眉页脚的网页截图
- 无第三方水印、无字幕条、无「预览」「sample」压字（官方 watermarked 宣传图可以接受，但要判断是否影响主体）
- 不是 AI 放大过的图（边缘发糊、纹理糊成一片）

不合格的例子：搜索引擎结果页的缩略图、贴吧/微博转载带水印的图、把多张图拼在一起的贩售页头图、带价格标签和购买按钮的商店页整屏截图。

## 操作

拿到直链直接暂存，脚本会下载、校验 content-type 与 10MB 上限：

```bash
node skills/aiya-post-writer/scripts/publisher.mjs stage --url "https://…/cover.jpg" --name "封面.jpg"
```

本地已有文件（用户给的、子技能产出的截图）：

```bash
node skills/aiya-post-writer/scripts/publisher.mjs stage "D:/tmp/keyvisual.png"
```

**图床直连不通时**：`stage --url` 是脚本内裸 `fetch`，不读系统代理，所以 itch.io 的 `img.itch.zone`、Steam 的 CDN 在直连失败时它只会报「下载失败」。先用取页脚本把图落盘（它会自动换代理），再暂存本地路径：

```bash
node skills/aiya-post-writer/scripts/fetch-url.mjs "https://img.itch.zone/…/original/xxxx.png" --out cover.png
node skills/aiya-post-writer/scripts/publisher.mjs stage cover.png --name "cover.png"
```

代理与先后顺序见 `verify.md`「网络」。

itch.io 的图同一张有多个尺寸，路径里那一段是**外接框**不是尺寸：`/347x500/`、`/794x1000/`、`/original/`。页面首屏给的是小图，换 `794x1000` 或 `original` 再暂存——宽图塞进 794×1000 的框里出来仍是原比例的 794×446，不是竖版。

返回：

```json
{ "path": "C:\\…\\images\\9f2c1a4e77b0d3c8.jpg", "src": "file:///C:/…/images/9f2c1a4e77b0d3c8.jpg", "name": "封面.jpg" }
```

正文里用 `src`。同一张图重复暂存不会多存一份（按内容哈希命名），所以放心重跑。

只接受 PNG / JPEG / GIF / WebP / AVIF / BMP。**SVG 会被拒**（它会在本地源上执行脚本）。

## 放进正文

封面在最前。确实要加图时，放到对应小节：

```
<img src="file:///C:/…/images/9f2c1a4e77b0d3c8.jpg" alt="封面" />

<blockquote>…</blockquote>

<hr />

<h3>图集样张</h3>

<img src="file:///C:/…/images/1b7e…jpg" alt="样张" />

<ul><li>…</li></ul>
```

- `alt` 写「封面」或作品名（`图片1` 这种编号读者读不出内容）
- 加不加图看**图本身有没有信息量**：图集样张、整合包安装界面、曲目表、角色立绘对照，加了读者就少读一段话；装饰性插图只会把正文稀释。存量帖里 544/558 只有封面一张，那是手写时代的常态——有几个信息点就配几张，不必向这个数字看齐
- 图片之间、图片与段落之间空一行；间距靠空行，不用 `<br>` 堆

## 找不到合格封面时

两条路：

1. 请用户提供——他手上往往就有；
2. 不写图，其余字段照常提交，回报里说明「没有可用封面，卡片会走纯色底」。

外链图和自造图都替代不了封面：站点只认自己托管的图，外链会让封面静默失效，并随图源失效变成裂图。缺图是可见的瑕疵，破封面是看不见的失效。
