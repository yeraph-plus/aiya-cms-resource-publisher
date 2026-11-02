# GALGAME / 视觉小说

## 识别

正向：来源是 DLsite、Getchu、VNDB、批评空间、厂家官网（ωstar、Yuzu-Soft、Key、ILLUSION…）；语料里出现 `シナリオ` / `原画` / `ブランド` / `攻略`；作品以「读」为主、有分支或多结局。

排除：

- 有玩法的 RPG / SLG / 动作，即便同在一个商店页 → `game.md`。
- 只有音频没有画面 → `voice.md`。
- 全年龄乙女向仍是 GALGAME，只是 `resource_other` 加 `乙女向`。

## 情报源

1. 厂家官网 / 官方作品页——发售日、原题、社团以它为准。
2. VNDB——补原题、别名、系列关系。
3. 批评空间、DLsite 商店页——补官方简介；DLsite 的促销话术要删掉再抄。

## 标题

```
[GALGAME] [社团] 作品名（原文名）范围 [版本·语言标记]
```

实例：

```
[GALGAME][ωstar] 美少女万华镜 系列全 [汉硬合集]
[GALGAME][Yuzu-Soft] 千恋＊万花 [汉硬]
```

- `汉硬` 是站内习惯写法（汉化硬盘版），优先用它，不要写「汉化版整合硬盘版」。
- 系列全作写 `系列全`；只覆盖一部分就写实际范围 `1-3`。

## 正文

骨架 `quote`。官方文案照抄，别改写剧情。

```html
<img src="file:///…" alt="封面" />
<blockquote>官方剧情简介。照抄商店页或官网，第三人称，1–2 段，去掉促销话术。</blockquote>
<hr />
<p>版本与系列说明：是否汉化硬盘版、含不含补丁、系列内各作关系、DLC 情况。语料有据才写，没有就整段删。</p>
<p>系列目录：</p>
<ul><li>作品名（日文原名 / 中文译名）</li></ul>
```

系列目录是可选块：只在语料确实列出多作时写，按原作顺序排，不混入评价。

## 分类

| 词法 | 填什么 |
|---|---|
| `resource_category` | `GALGAME`，1 个就够 |
| `resource_other` | 硬盘版 · 机翻 · AI汉化 · 官方中文 · 合集 · 完结 |
| `resource_author` | 社团 / 品牌名（`ωstar`、`Yuzu-Soft`） |
| `resource_content` | 题材 0–6 个 |
| `resource_original` / `resource_character` | 改编作或角色名明确时才填 |

注意 `resource_author` 填的是**制作方**，不是脚本家或原画师个人；有明确署名作者且站内有这个词时才另加。
