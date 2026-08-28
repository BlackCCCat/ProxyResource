#!name=AI 解锁检测 · 订阅解析器
#!desc=订阅更新时逐个检测节点能否解锁 ChatGPT / Claude / Gemini，给通过的节点名追加标记（如 ⚡GPT+CLD+GMN），配合「筛选节点 → NameRegex」把它们自动汇聚到策略组。挂在「节点订阅」的解析器位置使用。
#!author=BlackCCCat[https://github.com/BlackCCCat]
#!homepage=https://github.com/BlackCCCat/ProxyResource
#!icon=https://raw.githubusercontent.com/Koolson/Qure/master/IconSet/Color/OpenAI.png
#!tag=解析器,AI,解锁检测
#!system=iOS,iPadOS,macOS,tvOS
#!loon_version=3.5.0(969)
#!type=parser

[Argument]
chatgpt = switch,true,tag=检测 ChatGPT,desc=以 OpenAI 合规接口判定，地区黑名单兜底
claude = switch,true,tag=检测 Claude,desc=claude.ai 可达性 + 出口地区判定
gemini = switch,true,tag=检测 Gemini,desc=解析 gemini.google.com 首页的可用性标志位（单节点约 800KB 流量）
depth = select,"full","lite",tag=检测深度,desc=full=请求各服务真实端点（准确、流量大）；lite=只按出口地区判断（几乎不耗流量）
strict = switch,false,tag=严格模式,desc=开启后 Cloudflare 人机验证、OpenAI App 机房 IP 拦截也算未解锁
routeCheck = switch,true,tag=路由自检,desc=抽样比对各节点的出口 IP。若全部相同说明请求没有真的分别走各节点，此时不改动任何节点名。除非你的机场确实全部单出口，否则不要关
extraBlockCC = input,"",tag=追加地区黑名单,desc=逗号分隔的两位国家码，如 TW,VN。对三家服务同时生效
marker = input,"⚡",tag=标记前缀,desc=打在节点名末尾，最终形如「节点名 ⚡GPT+CLD+GMN」。改这里要同步改筛选节点的正则
tagMode = select,"any","all",tag=打标条件,desc=any=命中任一服务即打标；all=需同时解锁所有已开启的服务
source = select,"auto","test","cache",tag=结果来源,desc=auto=能实测就实测（仅 Loon 原生格式订阅可实测）；test=强制实测；cache=只用定时任务写入的缓存
sortFirst = switch,true,tag=已解锁节点排在前面,desc=Clash YAML 格式下不生效
dropFailed = switch,false,tag=删除未解锁节点,desc=谨慎开启。只删除有明确检测结果且未解锁的节点，未测到的一律保留；Clash YAML 格式下不生效
concurrency = input,"5",tag=并发数,desc=1-16，节点多可调高，但太高容易互相干扰
timeout = input,"6000",tag=单次请求超时,desc=毫秒
budget = input,"90",tag=检测总预算,desc=秒。超时后剩余节点回退到缓存结果，须小于下面脚本的 timeout
cacheTTL = input,"12",tag=缓存有效期,desc=小时。此期限内的结果直接复用，不重复检测

[Script]
generic script-path=https://raw.githubusercontent.com/BlackCCCat/ProxyResource/main/Loon/Script/ai_unlock.js,tag=AIUnlockParser,timeout=150,argument=[{chatgpt},{claude},{gemini},{depth},{strict},{routeCheck},{extraBlockCC},{marker},{tagMode},{source},{sortFirst},{dropFailed},{concurrency},{timeout},{budget},{cacheTTL}]
