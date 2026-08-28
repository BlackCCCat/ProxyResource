# Loon · AI 解锁检测插件

检测节点能否解锁 **ChatGPT / Claude / Gemini**，把能解锁的节点自动汇聚到策略组。

```
🇯🇵 日本03  ->  🇯🇵 日本03 ⚡GPT+CLD+GMN
🇺🇸 美国02  ->  🇺🇸 美国02 ⚡GPT+CLD
🇭🇰 香港01  ->  🇭🇰 香港01          （未解锁，不打标记）
```

---

## 一、先理解它为什么这么设计

Loon 的插件**只能**包含 `[General] [Rule] [Rewrite] [Host] [Script] [Mitm] [Argument]` 这几个段，
**不能**声明 `[Proxy Group]` 或 `[Remote Filter]`；脚本 API 里也**没有**任何"往策略组里增删节点"的方法
（`$config` 只能读取子策略、切换当前选中项）。

所以"把能解锁的节点保留到策略组"在 Loon 里只有一条可行路径：

```
解析器给节点改名打标记  →  [Remote Filter] 用 NameRegex 匹配标记  →  策略组引用这个筛选组
        (插件负责)                        (你在配置里加一次，之后全自动)
```

标记是写进节点名的，筛选节点组按正则动态匹配，**订阅每次更新后策略组成员自动跟着变**，不需要再手动维护。

## 二、文件

| 文件 | 作用 |
|---|---|
| `Script/ai_unlock.js` | 核心脚本。同一份代码按运行环境自动切换 parser / cron / generic 三种模式 |
| `Plugin/AI-Unlock-Parser.plx` | **解析器插件**（`#!type=parser`）。挂在节点订阅上，订阅更新时检测并改名 |
| `Plugin/AI-Unlock-Check.plugin` | **定时任务插件**。定期复检已导入的节点，写入缓存；可自动切换 AI 策略组；也可手动点单个节点看检测面板 |

> 插件里的 `script-path` 指向 `https://raw.githubusercontent.com/BlackCCCat/ProxyResource/main/Loon/Script/ai_unlock.js`。
> 如果你的仓库名/分支不是 `ProxyResource`/`main`，把两个插件里的这行 URL 改掉即可。

## 三、安装

### 1. 装解析器插件

Loon → 配置 → 插件 → `+` → 填入：

```
https://raw.githubusercontent.com/BlackCCCat/ProxyResource/main/Loon/Plugin/AI-Unlock-Parser.plx
```

装好后进入 **节点 → 你的订阅 → 解析器**，选择「AI 解锁检测 · 订阅解析器」。

### 2. 装定时任务插件（推荐，见下方"两种模式怎么选"）

```
https://raw.githubusercontent.com/BlackCCCat/ProxyResource/main/Loon/Plugin/AI-Unlock-Check.plugin
```

打开插件的参数设置，把 **待检测的策略组** 填成一个包含全部节点的策略组名（默认 `节点选择`）。

### 3. 在配置文件里加筛选组和策略组（只需一次）

Loon → 配置 → 编辑当前配置，把下面内容并入对应段落。
`机场A` 换成你 `[Remote Proxy]` 里的订阅别名，多个用逗号隔开。

```ini
[Remote Filter]
# 所有能解锁任一 AI 服务的节点
AI-可用      = NameRegex,机场A,FilterKey = "⚡"
# 按服务细分（标记里带对应代号的才会被选中）
ChatGPT-可用 = NameRegex,机场A,FilterKey = "⚡[A-Z+]*GPT"
Claude-可用  = NameRegex,机场A,FilterKey = "⚡[A-Z+]*CLD"
Gemini-可用  = NameRegex,机场A,FilterKey = "⚡[A-Z+]*GMN"

[Proxy Group]
AI          = select,AI-ChatGPT,AI-Claude,AI-Gemini,AI-可用
AI-ChatGPT  = url-test,ChatGPT-可用,url = http://www.gstatic.com/generate_204,interval = 600
AI-Claude   = url-test,Claude-可用, url = http://www.gstatic.com/generate_204,interval = 600
AI-Gemini   = url-test,Gemini-可用, url = http://www.gstatic.com/generate_204,interval = 600
```

> **筛选组一个都没匹配到？** Loon 的 `NameRegex` 是按"包含"匹配的。
> 如果你的版本要求整串匹配，把正则写成 `".*⚡[A-Z+]*GPT.*"` 这种两头带 `.*` 的形式即可。
> 也可以先在 App 的「配置 → 筛选节点」界面里建组、边填边看命中结果，确认无误后再落到配置文件。

> `url-test` 组只对单个节点和订阅节点生效，把筛选组塞进去是可行的常见写法；
> 如果你的 Loon 版本表现异常，把这三个组改成 `select` 类型，再用定时任务插件的
> **自动切换** 参数（`gptGroup` / `cldGroup` / `gmnGroup`）让脚本帮你选最优节点。

最后把 AI 相关的分流规则指向 `AI` 组：

```ini
[Rule]
DOMAIN-SUFFIX,openai.com,AI
DOMAIN-SUFFIX,chatgpt.com,AI
DOMAIN-SUFFIX,anthropic.com,AI
DOMAIN-SUFFIX,claude.ai,AI
DOMAIN-SUFFIX,gemini.google.com,AI
```

## 四、两种模式怎么选

| | 解析器实测（`source=auto/test`） | 定时任务 + 解析器读缓存（`source=cache`） |
|---|---|---|
| 检测发生在 | 订阅更新时 | 后台定时 |
| 能测的订阅格式 | **仅 Loon 原生格式**（`名称 = 协议,服务器,端口,...`） | 任意格式 |
| 打标记时机 | 立即 | 下次订阅更新时 |
| 订阅更新耗时 | 长（几十秒到几分钟） | 几乎不变 |

**判断你的订阅是不是 Loon 原生格式**：机场给的链接如果带 `?flag=loon` / `&target=loon`，或者用 Loon 拉取时返回的是
`节点名 = Shadowsocks,1.2.3.4,443,...` 这种行，就是原生格式。Clash YAML 和 base64 分享链接列表**无法**在解析阶段实测
（Loon 的 `$httpClient` 只接受节点名、策略组名或 Loon 格式的节点描述作为出口），脚本会自动退回读缓存。

**推荐组合**：两个插件都装。
解析器保持默认 `source=auto`，定时任务每 6 小时复检一次并刷新缓存——
原生格式订阅两条路都走得通，非原生格式订阅则由定时任务兜底，解析器只负责改名。

## 五、检测口径

| 服务 | 判定方式 |
|---|---|
| **ChatGPT** | `GET api.openai.com/compliance/cookie_requirements`，响应含 `unsupported_country` 判为不支持；地区黑名单兜底。严格模式下额外检查 `ios.chat.openai.com`（会暴露机房 IP 拦截，`"type":"dc"`） |
| **Claude** | `claude.ai/cdn-cgi/trace` 取出口地区 + `claude.ai/login` 可达性。403 且页面是 Cloudflare 人机验证（`Just a moment...`）时，**非严格模式判为可用**（真机带 Cookie 通常能过），严格模式判为不可用；`error code: 1020` / 451 判为封禁 |
| **Gemini** | `GET gemini.google.com/app`，解析首页 WIZ 数据里的可用性标志位 `[45631641,null,true]`；地区码取自 `,2,1,200,"XXX"` |

每个节点先打一次 Cloudflare `cdn-cgi/trace`（响应仅几百字节）做连通性探测并取出口地区，
拿不到响应就直接判为节点不可达，不再浪费后续请求。

**流量提醒**：Gemini 首页约 800KB，`depth=full` 下每个节点每轮检测约消耗 1MB。
50 个节点 ≈ 50MB。蜂窝网络下建议把 `depth` 改成 `lite`（只按出口地区判断，单节点几百字节），
或关掉 Gemini 检测。缓存有效期内（默认 12 小时）不会重复检测。

## 六、参数说明

两个插件共用同一套参数，在 Loon 的插件详情页里点开就能改。

| 参数 | 默认 | 说明 |
|---|---|---|
| `chatgpt` / `claude` / `gemini` | 全开 | 要检测哪些服务 |
| `depth` | `full` | `full` 请求真实端点；`lite` 只按出口地区判断 |
| `strict` | `false` | 人机验证 / 机房 IP 拦截是否算未解锁 |
| `marker` | `⚡` | 标记前缀。**改了要同步改 `[Remote Filter]` 的正则** |
| `tagMode` | `any` | `any` 命中任一服务就打标；`all` 需全部命中 |
| `source` | `auto` | 解析器专用。`auto`/`test`/`cache` |
| `sortFirst` | `true` | 已解锁节点排到订阅前面 |
| `dropFailed` | `false` | 直接删掉未解锁节点。**只删有明确检测结果且未解锁的**，没测到的一律保留 |
| `concurrency` | `5` | 并发数，1–16 |
| `timeout` | `6000` | 单次请求超时（毫秒） |
| `budget` | 90 / 240 | 检测总预算（秒），超时后剩余节点回退缓存。**必须小于插件里 `[Script]` 行的 `timeout`** |
| `cacheTTL` | `12` | 缓存有效期（小时） |
| `group` | `节点选择` | 定时任务专用，要遍历的策略组 |
| `gptGroup` / `cldGroup` / `gmnGroup` | 空 | 定时任务专用，填了就自动把该策略组切到延迟最低的可解锁节点 |

## 七、行为细节与限制

- **标记会被反复剥离再重打**。缓存以"去掉标记后的节点名"为键，所以定时任务测的是
  `日本03 ⚡GPT`、解析器看到的是 `日本03`，两边能对上。
- **结论不确定的节点一律保持原名不动**，包括上一轮打的标记。"不确定"含两种情况：没测到（缓存过期 / 超预算），
  以及节点本身连不通。这样一次网络抖动不会把整个订阅的标记全抹掉，`dropFailed` 也不会误删这类节点。
- **Clash YAML 订阅**只支持改名，不支持排序和删除节点（改动 YAML 结构风险太高）。
- **节点数量多时**注意 `budget` 和 `[Script]` 行 `timeout` 的关系。解析器插件默认 `budget=90` / `timeout=150`，
  定时任务默认 `budget=240` / `timeout=300`。100+ 节点建议调高并发到 8–10，或改用 `depth=lite`。
- **地区黑名单**（`CN/HK/MO/RU/IR/KP/SY/CU/VE/BY` 等）写在脚本的 `BLOCKED` 常量里，
  三家服务的可用地区变化时改那里。
- **手动查单个节点**：节点列表里左滑/长按某个节点 → 选「AI解锁检测」，会弹出该节点的检测面板。

## 参考

- [Loon 官方文档 · 脚本 API](https://nsloon.app/docs/Script/script_api/)（`$httpClient` 的 `node` 参数、`$config`）
- [Loon 官方文档 · 插件](https://loon0x00.github.io/docs/Plugin/)（插件段落与 `#!type=parser`）
- [LoonExampleConfig](https://github.com/Loon0x00/LoonExampleConfig)（`Plugin_Loon_Parser_Example.plx`、`example.conf`）
- [mc2u/loon_resource_parser.js](https://raw.githubusercontent.com/mc2u/Loon/refs/heads/main/Scripts/loon_resource_parser.js)（解析器骨架、多格式订阅解析）
- [IBL3ND/Unlock-Detection_Widget.JS](https://raw.githubusercontent.com/IBL3ND/module/refs/heads/main/Unlock-Detection_Widget.JS)（解锁检测思路）
