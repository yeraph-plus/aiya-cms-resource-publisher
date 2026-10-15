/**
 * The one piece of prompt text the tool itself owns: the JSON object the model
 * has to answer with.
 *
 * There are deliberately no preset prompt templates. What a 游戏 post or a
 * 同人音声 post should say is editorial knowledge that lives with the person
 * writing the posts, not with the tool — a shipped template would be rewritten
 * on the first use anyway, and an upgrade would then have to guess whether a
 * stored prompt was "still the built-in" or hand-edited. The window therefore
 * starts with an empty template list and offers this contract as one click
 * ("插入输出契约") so a self-written prompt can be completed mechanically.
 *
 * The shape below is what intake/parse.ts reads: title, content, and the two
 * term maps. Everything else about a row (status, author, date, file list) is
 * decided by the publishing tool's own settings.
 */

export const OUTPUT_CONTRACT = `【输出格式】只回一个 JSON 对象本体（可以整体放在 \`\`\`json 代码块里），不要任何解释文字：
{
  "title": "站内标题",
  "content": "正文 HTML",
  "terms": {
    "resource_category": ["分类"],
    "resource_original": ["原作"],
    "resource_character": ["角色"],
    "resource_author": ["社团或作者"],
    "resource_content": ["内容描述"],
    "resource_other": ["其他标记"]
  },
  "newTerms": {
    "resource_content": ["确实需要、但词表里没有的词"]
  }
}

【硬规则】
1. 六个词法里只能填【可用标签词表】里逐字出现过的词，照抄不要改写；确需新词时按词法写进 newTerms，不要混进 terms。
2. 分类是层级词法：词表给的是「父 / 子」路径，照抄整条路径（含斜杠），不要只写子分类名。
3. 正文里不要出现 <img>（图片由工具插入），不要写网盘链接、提取码、解压密码，也不要写"回复可见"之类站内机制。
4. 标题结构：[类型] [原作或社团] 名称（原文名）[版本·语言标记]。类型与语言标记优先从词表的分类/其他列里挑。
5. 正文骨架：先用一句话说明这是什么 → <blockquote> 官方简介或官方信息（照抄原文） → <hr /> → 你自己的说明（版本、安装、注意事项）。条目用 <ul><li>，来源用 <a href="…">。
6. 只输出上面列出的字段：状态、作者、发布时间、网盘与文件列表都由发帖器按自己的设置决定，不要输出这些字段。
7. 不确定的信息宁缺勿假：不要补全你没看到的字段，不要编造版本号、发售日、社团名。
8. terms 每列 0–6 个词，按相关度排序，不要堆砌。`;
