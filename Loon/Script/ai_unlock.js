/**
 * AI 解锁检测 · Loon
 * ------------------------------------------------------------------
 * 检测节点能否解锁 ChatGPT / Claude / Gemini，并把能解锁的节点
 * 重命名打上标记，配合 Loon 的「筛选节点(NameRegex)」自动汇聚到策略组。
 *
 * 同一个文件同时支持三种运行方式，靠环境变量自动判别：
 *   1) parser  —— 作为「资源解析器」挂在节点订阅上（$resourceType 存在）
 *                 订阅更新时给节点改名打标记，标记源可以是实时检测或缓存。
 *   2) cron    —— 定时任务，遍历指定策略组内的节点逐个检测，结果写入缓存，
 *                 可选自动把 AI 策略组切到最优节点。
 *   3) generic —— 在 App 内手动触发。作用于单个节点时只测该节点并弹出面板；
 *                 作用于策略组时等同 cron。
 *
 * 参考：
 *   https://github.com/Loon0x00/LoonExampleConfig  (官方 API / 解析器示例)
 *   https://raw.githubusercontent.com/mc2u/Loon/refs/heads/main/Scripts/loon_resource_parser.js
 *   https://raw.githubusercontent.com/IBL3ND/module/refs/heads/main/Unlock-Detection_Widget.JS
 *
 * Author: BlackCCCat
 */

/* ==================================================================
 * 0. 运行环境判别
 * ================================================================== */

var HAS_RESOURCE = typeof $resourceType !== "undefined" && $resourceType !== null;
var ENV_PARAMS =
  typeof $environment !== "undefined" && $environment && $environment.params
    ? $environment.params
    : null;
var SINGLE_NODE = ENV_PARAMS && ENV_PARAMS.node ? String(ENV_PARAMS.node) : "";

var MODE = HAS_RESOURCE ? "parser" : SINGLE_NODE ? "single" : "batch";

/* ==================================================================
 * 1. 参数
 * ================================================================== */

var ARG = typeof $argument === "object" && $argument !== null ? $argument : {};

function str(v, d) {
  if (v === undefined || v === null) return d === undefined ? "" : d;
  var s = String(v).trim();
  return s === "" ? (d === undefined ? "" : d) : s;
}

function bool(v, d) {
  if (v === undefined || v === null || v === "") return d;
  if (v === true || v === false) return v;
  var s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

function int(v, d) {
  var n = parseInt(v, 10);
  return isNaN(n) ? d : n;
}

var CFG = {
  // 要检测的服务
  chatgpt: bool(ARG.chatgpt, true),
  claude: bool(ARG.claude, true),
  gemini: bool(ARG.gemini, true),

  // lite = 只用出口地区判断（流量极小）；full = 请求各服务真实端点（准确，流量大）
  depth: str(ARG.depth, "full").toLowerCase(),
  // 严格模式：Cloudflare 人机验证 / OpenAI App 机房 IP 拦截也算未解锁
  strict: bool(ARG.strict, false),
  // 路由自检：抽样比对出口 IP，确认请求真的分别从各节点发出
  routeCheck: bool(ARG.routeCheck, true),
  // 追加的地区黑名单，逗号分隔的两位国家码，对三家服务同时生效
  extraBlockCC: str(ARG.extraBlockCC, ""),

  // 标记
  marker: str(ARG.marker, "⚡"),
  tagMode: str(ARG.tagMode, "any").toLowerCase(), // any = 命中任一服务就打标, all = 需全部命中

  // 并发与超时
  concurrency: int(ARG.concurrency, 5),
  timeout: int(ARG.timeout, 6000),
  budget: int(ARG.budget, 90) * 1000, // 整个脚本的检测预算(秒)
  cacheTTL: int(ARG.cacheTTL, 12) * 3600 * 1000,

  // 解析器行为
  source: str(ARG.source, "auto").toLowerCase(), // auto | test | cache
  dropFailed: bool(ARG.dropFailed, false),
  sortFirst: bool(ARG.sortFirst, true),

  // 批量检测行为
  group: str(ARG.group, ""),
  gptGroup: str(ARG.gptGroup, ""),
  cldGroup: str(ARG.cldGroup, ""),
  gmnGroup: str(ARG.gmnGroup, ""),
  notify: bool(ARG.notify, true)
};

if (CFG.concurrency < 1) CFG.concurrency = 1;
if (CFG.concurrency > 16) CFG.concurrency = 16;
if (CFG.timeout < 2000) CFG.timeout = 2000;

var SERVICES = [
  { key: "chatgpt", code: "GPT", name: "ChatGPT" },
  { key: "claude", code: "CLD", name: "Claude" },
  { key: "gemini", code: "GMN", name: "Gemini" }
];

var ACTIVE = SERVICES.filter(function (s) {
  return CFG[s.key];
});

var DEADLINE = Date.now() + CFG.budget;

function log(msg) {
  console.log("[AI解锁] " + msg);
}

/* ==================================================================
 * 2. 标记名工具
 * ================================================================== */

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

var CODES = SERVICES.map(function (s) {
  return s.code;
}).join("|");

// 形如 "  ⚡GPT+CLD+GMN" 的后缀
var MARKER_RE = new RegExp(
  "\\s*" + escapeRe(CFG.marker) + "(?:" + CODES + ")(?:\\+(?:" + CODES + "))*\\s*$"
);

function baseName(name) {
  var n = String(name === undefined || name === null ? "" : name);
  // 反复剥离，兼容历史上被重复打标的名字
  for (var i = 0; i < 4 && MARKER_RE.test(n); i++) n = n.replace(MARKER_RE, "");
  return n.trim();
}

function buildMarker(result) {
  if (!result || result.dead) return "";
  var hit = ACTIVE.filter(function (s) {
    return result[s.key] && result[s.key].ok;
  });
  if (!hit.length) return "";
  if (CFG.tagMode === "all" && hit.length !== ACTIVE.length) return "";
  return (
    CFG.marker +
    hit
      .map(function (s) {
        return s.code;
      })
      .join("+")
  );
}

function taggedName(name, result) {
  var base = baseName(name);
  var mk = buildMarker(result);
  return mk ? base + " " + mk : base;
}

/* ==================================================================
 * 3. 网络请求封装
 * ================================================================== */

var UA_WEB =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var UA_APP = "ChatGPT/1.2025.070 (iOS 18.3; iPhone17,1) Alamofire/5.10.2";

function request(params) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = null;
    var started = Date.now();

    function finish(r) {
      if (settled) return;
      settled = true;
      if (timer !== null && typeof clearTimeout === "function") clearTimeout(timer);
      r.elapsed = Date.now() - started;
      resolve(r);
    }

    // 兜底计时器：防止 $httpClient 在极端情况下不回调
    timer = setTimeout(function () {
      finish({ error: "timeout", status: 0, headers: {}, body: "" });
    }, (params.timeout || CFG.timeout) + 2000);

    try {
      $httpClient.get(params, function (error, response, data) {
        finish({
          error: error ? String(error) : null,
          status: response && response.status ? response.status : 0,
          headers: response && response.headers ? response.headers : {},
          body: data === undefined || data === null ? "" : String(data)
        });
      });
    } catch (e) {
      finish({ error: String(e), status: 0, headers: {}, body: "" });
    }
  });
}

function get(url, nodeRef, headers, timeout) {
  var p = {
    url: url,
    timeout: timeout || CFG.timeout,
    headers: headers || { "User-Agent": UA_WEB }
  };
  if (nodeRef) p.node = nodeRef;
  return request(p);
}

/* ==================================================================
 * 4. 解锁检测
 * ================================================================== */

// 三家在这些地区均明确不提供服务，用于 lite 模式与快速否决
var BLOCKED = {
  chatgpt: ["CN", "HK", "MO", "RU", "IR", "KP", "SY", "CU", "VE", "BY"],
  claude: ["CN", "HK", "MO", "RU", "IR", "KP", "SY", "CU", "VE", "BY"],
  gemini: ["CN", "HK", "MO", "RU", "IR", "KP", "SY", "CU", "BY"]
};

// 合并用户自定义的追加黑名单
(function mergeExtraBlock() {
  if (!CFG.extraBlockCC) return;
  var extra = CFG.extraBlockCC.split(/[,\s]+/)
    .map(function (c) {
      return c.trim().toUpperCase();
    })
    .filter(function (c) {
      return /^[A-Z]{2}$/.test(c);
    });
  if (!extra.length) return;
  ["chatgpt", "claude", "gemini"].forEach(function (k) {
    extra.forEach(function (c) {
      if (BLOCKED[k].indexOf(c) === -1) BLOCKED[k].push(c);
    });
  });
  log("追加地区黑名单: " + extra.join(","));
})();

function ok(cc, note) {
  return { ok: true, cc: cc || "", note: note || "" };
}
function no(note, cc) {
  return { ok: false, cc: cc || "", note: note || "未解锁" };
}

function inList(list, cc) {
  return !!cc && list.indexOf(cc) !== -1;
}

/** ChatGPT：以 OpenAI 合规接口为准，地区列表兜底 */
async function checkChatGPT(nodeRef, cc) {
  if (inList(BLOCKED.chatgpt, cc)) return no("地区不支持", cc);
  if (CFG.depth === "lite") return ok(cc);

  var r = await get(
    "https://api.openai.com/compliance/cookie_requirements",
    nodeRef,
    {
      "User-Agent": UA_WEB,
      authorization: "Bearer null",
      "content-type": "application/json"
    }
  );
  if (r.error) return no("请求失败", cc);
  if (/unsupported_country/i.test(r.body)) return no("地区不支持", cc);
  if (r.status !== 200) return no("HTTP " + r.status, cc);

  if (CFG.strict) {
    var a = await get("https://ios.chat.openai.com/", nodeRef, { "User-Agent": UA_APP });
    if (a.status === 403) {
      var t = a.body.match(/"type"\s*:\s*"(\w+)"/);
      return no("App 受限(" + (t ? t[1] : "cf") + ")", cc);
    }
  }
  return ok(cc);
}

/** Claude：claude.ai 全站在 Cloudflare 后面，区分「人机验证」和「真封禁」 */
async function checkClaude(nodeRef, cc) {
  if (inList(BLOCKED.claude, cc)) return no("地区不支持", cc);
  if (CFG.depth === "lite") return ok(cc);

  var t = await get("https://claude.ai/cdn-cgi/trace", nodeRef, { "User-Agent": UA_WEB });
  if (t.error || !t.body) return no("不可达", cc);
  var m = t.body.match(/loc=([A-Z]{2})/);
  var loc = m ? m[1] : cc;
  if (inList(BLOCKED.claude, loc)) return no("地区不支持", loc);

  var r = await get("https://claude.ai/login", nodeRef, {
    "User-Agent": UA_WEB,
    "accept-language": "en-US,en;q=0.9"
  });
  if (r.error) return no("不可达", loc);

  var challenged = /Just a moment|challenge-platform|cf-chl|_cf_chl_opt/i.test(r.body);
  if (r.status === 403 && challenged) {
    // 机房 IP 常见的人机验证。真实设备带 Cookie 时多数仍可用，非严格模式下判定为可用
    return CFG.strict ? no("需人机验证", loc) : ok(loc, "需人机验证");
  }
  if (
    r.status === 451 ||
    /error code: 1020|you have been blocked|not available in your/i.test(r.body)
  ) {
    return no("被封禁", loc);
  }
  if (r.status >= 200 && r.status < 400) return ok(loc);
  return no("HTTP " + r.status, loc);
}

/** Gemini：解析首页 WIZ 数据里的可用性标志位 [45631641,null,true] */
async function checkGemini(nodeRef, cc) {
  if (inList(BLOCKED.gemini, cc)) return no("地区不支持", cc);
  if (CFG.depth === "lite") return ok(cc);

  var r = await get(
    "https://gemini.google.com/app",
    nodeRef,
    { "User-Agent": UA_WEB, "accept-language": "en-US,en;q=0.9" },
    Math.max(CFG.timeout, 10000)
  );
  if (r.error) return no("不可达", cc);
  if (r.status !== 200) return no("HTTP " + r.status, cc);

  var g = r.body.match(/,2,1,200,"([A-Z]{3})"/);
  var region = g ? g[1] : cc;
  if (/45631641,null,true/.test(r.body)) return ok(region);
  if (/45631641,null,false/.test(r.body)) return no("地区不支持", region);
  return no("特征未命中", region);
}

/* ---------------- 出口探测 ---------------- */

var TRACE_URL = CFG.chatgpt
  ? "https://chatgpt.com/cdn-cgi/trace"
  : "https://www.cloudflare.com/cdn-cgi/trace";

function parseTrace(body) {
  var ip = body.match(/(?:^|\n)ip=([^\s]+)/);
  var loc = body.match(/(?:^|\n)loc=([A-Z]{2})/);
  return { ip: ip ? ip[1] : "", loc: loc ? loc[1] : "" };
}

/** 只探出口，用于路由自检。拿不到就返回 null */
async function probeExit(nodeRef) {
  var r = await get(TRACE_URL, nodeRef, { "User-Agent": UA_WEB });
  if (r.error || !r.body) return null;
  var t = parseTrace(r.body);
  if (!t.ip && !t.loc) return null;
  t.elapsed = r.elapsed;
  return t;
}

/**
 * 路由自检：Loon 的 node 参数如果没生效，所有请求都会从同一个默认出口发出，
 * 于是每个节点的检测结果完全一致——表现就是"所有节点都可用"。
 * 这里抽样几个相隔较远的节点比对出口 IP，一样就说明路由没生效。
 * @return {ok:boolean, reason:string, ip:string, samples:Array}
 */
async function routingPreflight(refs) {
  if (!CFG.routeCheck) return { ok: true, reason: "已关闭路由自检" };
  if (refs.length < 2) return { ok: true, reason: "节点不足 2 个，无法自检" };

  // 取首、中、尾三个，避开相邻节点常见的同机不同端口
  var picks = [refs[0], refs[Math.floor(refs.length / 2)], refs[refs.length - 1]];
  var seen = [];
  for (var i = 0; i < picks.length; i++) {
    var e = await probeExit(picks[i]);
    if (e) seen.push(e);
  }
  if (seen.length < 2) {
    return { ok: true, reason: "有效样本不足 2 个，跳过自检", samples: seen };
  }

  var ips = seen
    .map(function (x) {
      return x.ip;
    })
    .filter(Boolean);
  var uniq = {};
  ips.forEach(function (i) {
    uniq[i] = 1;
  });
  var distinct = Object.keys(uniq);

  if (ips.length < 2) {
    return { ok: true, samples: seen, reason: "样本未返回出口 IP，跳过比对" };
  }
  if (distinct.length === 1) {
    return { ok: false, ip: distinct[0], samples: seen, reason: "抽样节点的出口 IP 完全相同" };
  }
  return { ok: true, samples: seen, reason: ips.length + " 个样本 / " + distinct.length + " 个不同出口" };
}

/**
 * 检测单个节点。
 * @param nodeRef 节点名 / 策略组名 / 完整的 Loon 节点描述
 */
async function detect(nodeRef, label) {
  var result = {
    name: label || nodeRef,
    cc: "",
    ip: "",
    dead: false,
    latency: 0,
    ts: Date.now()
  };

  // 先用 Cloudflare trace 做连通性探测并拿到出口 IP / 地区，代价极小。
  // 开启 ChatGPT 检测时直接打 chatgpt.com，顺带验证 OpenAI 域名可达。
  var trace = await get(TRACE_URL, nodeRef, { "User-Agent": UA_WEB });
  if (trace.error || !trace.body) {
    result.dead = true;
    result.note = trace.error || "无响应";
    return result;
  }
  result.latency = trace.elapsed;
  var t = parseTrace(trace.body);
  result.ip = t.ip;
  result.cc = t.loc;

  // 拿不到出口地区就没有可信的判定基础：宁可判为"结论不确定"，
  // 也不要让地区黑名单静默失效、把所有节点都放行。
  if (!result.cc) {
    result.dead = true;
    result.note = "出口地区未知";
    return result;
  }

  for (var i = 0; i < ACTIVE.length; i++) {
    var s = ACTIVE[i];
    if (s.key === "chatgpt") result.chatgpt = await checkChatGPT(nodeRef, result.cc);
    else if (s.key === "claude") result.claude = await checkClaude(nodeRef, result.cc);
    else if (s.key === "gemini") result.gemini = await checkGemini(nodeRef, result.cc);
  }
  return result;
}

/* ==================================================================
 * 5. 并发池
 * ================================================================== */

async function pool(items, limit, worker) {
  var out = new Array(items.length);
  var cursor = 0;
  var runners = [];
  var n = Math.min(limit, items.length);

  for (var k = 0; k < n; k++) {
    runners.push(
      (async function () {
        for (;;) {
          var idx = cursor++;
          if (idx >= items.length) return;
          if (Date.now() > DEADLINE) {
            out[idx] = null; // 超预算，留给缓存兜底
            continue;
          }
          try {
            out[idx] = await worker(items[idx], idx);
          } catch (e) {
            out[idx] = null;
            log("检测异常: " + e);
          }
        }
      })()
    );
  }
  await Promise.all(runners);
  return out;
}

/* ==================================================================
 * 6. 结果缓存
 * ================================================================== */

var STORE_KEY = "AI_UNLOCK_RESULTS";

function loadStore() {
  try {
    var raw = $persistentStore.read(STORE_KEY);
    var o = raw ? JSON.parse(raw) : null;
    if (o && typeof o === "object" && o.nodes) return o;
  } catch (e) {}
  return { updated: 0, nodes: {} };
}

function saveStore(store) {
  try {
    store.updated = Date.now();
    $persistentStore.write(JSON.stringify(store), STORE_KEY);
  } catch (e) {
    log("写入缓存失败: " + e);
  }
}

function toRecord(result) {
  var rec = {
    cc: result.cc || "",
    ip: result.ip || "",
    ts: result.ts || Date.now(),
    latency: result.latency || 0
  };
  for (var i = 0; i < SERVICES.length; i++) {
    var s = SERVICES[i];
    if (result[s.key]) {
      rec[s.code] = result[s.key].ok ? 1 : 0;
      if (result[s.key].note) rec[s.code + "_n"] = result[s.key].note;
    }
  }
  if (result.dead) rec.dead = 1;
  return rec;
}

function fromRecord(rec, name) {
  var r = {
    name: name,
    cc: rec.cc || "",
    ip: rec.ip || "",
    ts: rec.ts || 0,
    latency: rec.latency || 0,
    cached: true
  };
  if (rec.dead) r.dead = true;
  for (var i = 0; i < SERVICES.length; i++) {
    var s = SERVICES[i];
    if (rec[s.code] !== undefined) {
      r[s.key] = { ok: rec[s.code] === 1, cc: r.cc, note: rec[s.code + "_n"] || "" };
    }
  }
  return r;
}

/**
 * 订阅里的节点名是"原始名"，但配置里那个节点可能已经被上一轮打过标记。
 * 拿它当 node 参数路由时要用配置里的实际名字。
 */
function storedName(store, subName) {
  var base = baseName(subName);
  var rec = store.nodes[base];
  return rec && rec.lastName ? rec.lastName : base;
}

function cacheHit(store, base) {
  var rec = store.nodes[base];
  if (!rec) return null;
  if (!rec.ts || Date.now() - rec.ts > CFG.cacheTTL) return null;
  return fromRecord(rec, base);
}

/* ==================================================================
 * 7. 结果汇总输出
 * ================================================================== */

function flag(cc) {
  if (!cc || cc.length !== 2) return "";
  return String.fromCodePoint.apply(
    String,
    cc
      .toUpperCase()
      .split("")
      .map(function (c) {
        return 127397 + c.charCodeAt(0);
      })
  );
}

function summarize(results) {
  var lines = [];
  var counter = {};
  ACTIVE.forEach(function (s) {
    counter[s.key] = 0;
  });
  var dead = 0;

  results.forEach(function (r) {
    if (!r) return;
    if (r.dead) {
      dead++;
      lines.push("  ✖ " + r.name + "  (" + (r.note || "不可达") + ")");
      return;
    }
    var parts = ACTIVE.map(function (s) {
      var v = r[s.key];
      if (!v) return s.code + ":-";
      if (v.ok) {
        counter[s.key]++;
        return s.code + ":✅" + (v.note ? "(" + v.note + ")" : "");
      }
      return s.code + ":❌" + (v.note ? "(" + v.note + ")" : "");
    });
    lines.push(
      "  " +
        (r.cached ? "· " : "› ") +
        r.name +
        "  " +
        flag(r.cc) +
        (r.cc || "??") +
        (r.ip ? " " + r.ip : "") +
        "  " +
        parts.join("  ")
    );
  });

  var head = ACTIVE.map(function (s) {
    return s.name + " " + counter[s.key];
  }).join(" / ");

  return {
    text: lines.join("\n"),
    counter: counter,
    dead: dead,
    exits: exitReport(results),
    headline: head + "，不可达 " + dead + "，共 " + results.length
  };
}

/**
 * 统计出口 IP 分布。实测节点数 ≥2 却只有一个出口，
 * 基本可以断定 node 路由没生效，结果不可信。
 */
function exitReport(results) {
  var uniq = {};
  var n = 0;
  results.forEach(function (r) {
    if (!r || r.cached || !r.ip) return;
    n++;
    uniq[r.ip] = (uniq[r.ip] || 0) + 1;
  });
  var distinct = Object.keys(uniq);
  return {
    tested: n,
    distinct: distinct.length,
    suspicious: n >= 2 && distinct.length === 1,
    ip: distinct.length === 1 ? distinct[0] : ""
  };
}

/** 路由不可信时的统一告警文案 */
function routingWarning(detail) {
  return [
    "",
    "  ⚠️  路由自检未通过：" + detail,
    "  这说明 $httpClient 的 node 参数没有把请求分别送出各个节点，",
    "  所有请求其实都走了同一个出口 —— 此时每个节点拿到的结果完全一样，",
    "  \"所有节点都可用\" 或 \"所有节点都不支持\" 就是这么来的，实测结果不可信。",
    "  解析阶段拿不到可信结果时，本脚本会退回使用「定时任务」插件写入的缓存来改名。",
    "  所以请确认：",
    "    1) 已安装并跑过「AI 解锁检测 · 定时任务」插件（它按节点名检测，不依赖节点描述）；",
    "    2) 该插件的 group 参数填的是包含全部节点的策略组；",
    "    3) 解析器插件的 source 参数设为 cache，省掉这次无谓的实测。",
    ""
  ].join("\n");
}

function notify(title, subtitle, body) {
  if (!CFG.notify) return;
  try {
    if (typeof $notification !== "undefined" && $notification && $notification.post) {
      $notification.post(title, subtitle, body);
    }
  } catch (e) {}
}

/* ==================================================================
 * 8. 订阅内容解析（解析器模式）
 * ================================================================== */

function normalizeText(s) {
  s = String(s === undefined || s === null ? "" : s);
  if (s && s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function base64Decode(s) {
  try {
    var binary = atob(s);
    var bytes = [];
    for (var i = 0; i < binary.length; i++) {
      bytes.push("%" + ("00" + binary.charCodeAt(i).toString(16)).slice(-2));
    }
    return decodeURIComponent(bytes.join(""));
  } catch (e) {
    return null;
  }
}

function looksLikeBase64(text) {
  var s = String(text).replace(/\s+/g, "");
  if (!s || s.length < 24) return false;
  if (/^[A-Za-z0-9+/=]+$/.test(s) === false) return false;
  return true;
}

var LOON_LINE_RE = /^([^=#][^=]*?)\s*=\s*([A-Za-z0-9_-]+\s*,.*)$/;

/**
 * 把订阅内容拆成 { kind, entries, render }：
 *   entries: [{ name, testable, desc, apply(newName) }]
 * render(entries) 负责按新名字重新拼回原格式。
 */
function parseResource(raw) {
  var text = normalizeText(raw).trim();
  if (!text) return null;

  // ---- 1. base64 分享链接列表 ----
  if (looksLikeBase64(text)) {
    var decoded = base64Decode(text.replace(/\s+/g, ""));
    if (decoded && /:\/\//.test(decoded)) {
      return parseUriList(decoded);
    }
  }
  if (/^[a-z0-9]+:\/\//i.test(text)) return parseUriList(text);

  // ---- 2. Clash YAML ----
  if (/^\s*proxies\s*:/m.test(text)) return parseClashYaml(text);

  // ---- 3. Loon 原生格式 ----
  return parseLoonList(text);
}

function parseLoonList(text) {
  var lines = normalizeText(text).split("\n");
  var entries = [];
  var slots = []; // 记录节点在原文中的行号，便于排序/删除

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var t = line.trim();
    if (!t || t.charAt(0) === "#" || t.charAt(0) === "[") continue;
    var m = t.match(LOON_LINE_RE);
    if (!m) continue;
    var name = m[1].trim();
    var value = m[2].trim();
    entries.push({
      lineIndex: i,
      name: name,
      testable: true,
      // 节点描述用去标记的原名，避免把标记写进 Loon 内部节点名
      desc: baseName(name) + " = " + value,
      value: value
    });
    slots.push(i);
  }

  return {
    kind: "loon",
    entries: entries,
    reorderable: true,
    render: function (list, dropped) {
      // 非节点行（注释、段头）原样保留在前，节点整体排在后面
      var head = [];
      for (var j = 0; j < lines.length; j++) {
        if (slots.indexOf(j) !== -1) continue;
        head.push(lines[j]);
      }
      var nodeBlock = [];
      list.forEach(function (e) {
        if (dropped && dropped[e.lineIndex]) return;
        nodeBlock.push(e.newName + " = " + e.value);
      });
      var headText = head.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
      return (headText ? headText + "\n" : "") + nodeBlock.join("\n");
    }
  };
}

function parseUriList(text) {
  var lines = normalizeText(text).split("\n");
  var entries = [];

  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (!t || !/:\/\//.test(t)) continue;
    var hash = t.lastIndexOf("#");
    var name = "";
    var left = t;
    if (hash > -1 && hash < t.length - 1) {
      left = t.slice(0, hash + 1);
      var frag = t.slice(hash + 1);
      try {
        name = decodeURIComponent(frag);
      } catch (e) {
        name = frag;
      }
    } else {
      var rm = t.match(/[?&]remark=([^&#]*)/);
      if (rm) {
        try {
          name = decodeURIComponent(rm[1]);
        } catch (e) {
          name = rm[1];
        }
        left = t + "#";
      } else {
        continue;
      }
    }
    entries.push({
      lineIndex: i,
      name: name,
      testable: false, // 分享链接无法直接作为 Loon 节点描述使用
      left: left
    });
  }

  return {
    kind: "uri",
    entries: entries,
    reorderable: true,
    render: function (list, dropped) {
      var byLine = {};
      list.forEach(function (e) {
        byLine[e.lineIndex] = e;
      });
      var passthrough = [];
      for (var j = 0; j < lines.length; j++) {
        if (byLine[j] === undefined && lines[j].trim()) passthrough.push(lines[j]);
      }
      var nodes = [];
      list.forEach(function (e) {
        if (dropped && dropped[e.lineIndex]) return;
        nodes.push(e.left + encodeURIComponent(e.newName));
      });
      return passthrough.concat(nodes).join("\n");
    }
  };
}

function parseClashYaml(text) {
  var lines = normalizeText(text).split("\n");
  var entries = [];
  var inProxies = false;
  var baseIndent = -1;

  function readName(s) {
    var m = s.match(/(^|[,{\s])name\s*:\s*("([^"]*)"|'([^']*)'|([^,}\n]+))/);
    if (!m) return null;
    var v = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
    return { value: String(v).trim(), quote: m[3] !== undefined ? '"' : m[4] !== undefined ? "'" : "" };
  }

  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    var t = raw.trim();
    if (!t || t.charAt(0) === "#") continue;
    var indent = (raw.match(/^\s*/) || [""])[0].length;

    if (!inProxies) {
      if (/^proxies\s*:\s*$/.test(t)) {
        inProxies = true;
        baseIndent = indent;
      }
      continue;
    }
    if (indent <= baseIndent && /^[A-Za-z0-9_-]+\s*:/.test(t)) break;

    var got = readName(raw);
    if (got) {
      entries.push({
        lineIndex: i,
        name: got.value,
        testable: false,
        quote: got.quote
      });
    }
  }

  return {
    kind: "yaml",
    entries: entries,
    reorderable: false,
    render: function (list) {
      var out = lines.slice();
      list.forEach(function (e) {
        var q = e.quote || '"';
        var replacement = "name: " + q + e.newName + q;
        out[e.lineIndex] = out[e.lineIndex].replace(
          /name\s*:\s*("[^"]*"|'[^']*'|[^,}\n]+)/,
          replacement
        );
      });
      return out.join("\n");
    }
  };
}

/* ==================================================================
 * 9. Loon 配置 API 封装
 * ================================================================== */

function getConfigObject() {
  try {
    var raw = $config.getConfig();
    return typeof raw === "string" ? JSON.parse(raw) : raw || {};
  } catch (e) {
    return {};
  }
}

function getSubPolicies(group) {
  return new Promise(function (resolve) {
    var settled = false;
    function done(v) {
      if (settled) return;
      settled = true;
      resolve(v);
    }
    setTimeout(function () {
      done([]);
    }, 5000);
    try {
      $config.getSubPolicies(group, function (subs) {
        if (typeof subs === "string") {
          try {
            subs = JSON.parse(subs);
          } catch (e) {
            subs = [];
          }
        }
        done(Array.isArray(subs) ? subs : []);
      });
    } catch (e) {
      done([]);
    }
  });
}

/**
 * 把策略组递归展开成真实节点名。
 *
 * 直接取 getSubPolicies(组) 只能拿到"直接成员"——如果用户的组里装的是
 * 香港/美国/日本这类筛选节点组，拿到的就是一堆组名而不是节点名，
 * 测出来的结果也存不进能和订阅节点名对上的缓存。
 *
 * 判断依据：对叶子节点调用 getSubPolicies 返回空数组，对组则返回成员。
 * 每一层并发探测，所以整层只花一个超时的时间，不是 N 个。
 */
async function expandGroup(root, builtin, maxDepth) {
  var seen = {};
  var leaves = [];
  var viaGroups = [];
  seen[root] = 1;

  function skippable(n) {
    return !n || seen[n] || builtin.indexOf(n) !== -1 || n === "DIRECT" || /^REJECT/i.test(n);
  }

  var frontier = await getSubPolicies(root);
  var depth = 0;

  while (frontier.length && depth < maxDepth) {
    var candidates = [];
    for (var i = 0; i < frontier.length; i++) {
      if (skippable(frontier[i])) continue;
      seen[frontier[i]] = 1;
      candidates.push(frontier[i]);
    }
    if (!candidates.length) break;

    var subs = await Promise.all(
      candidates.map(function (n) {
        return getSubPolicies(n);
      })
    );

    var next = [];
    for (var j = 0; j < candidates.length; j++) {
      if (subs[j] && subs[j].length) {
        viaGroups.push(candidates[j]);
        next = next.concat(subs[j]);
      } else {
        leaves.push(candidates[j]);
      }
    }
    frontier = next;
    depth++;
  }

  return { nodes: leaves, groups: viaGroups, depth: depth };
}

function setSelectPolicy(group, policy) {
  try {
    if ($config.setSelectPolicy) return $config.setSelectPolicy(group, policy);
    // 官方文档里这个方法被写成了 getConfig(policyName, selectName)
    return $config.getConfig(group, policy);
  } catch (e) {
    log("切换策略组失败 " + group + " -> " + policy + ": " + e);
    return false;
  }
}

/* ==================================================================
 * 10. 批量检测（cron / generic 作用于策略组）
 * ================================================================== */

async function runBatch() {
  var conf = getConfigObject();
  var groups = conf.all_policy_groups || [];

  var target = CFG.group;
  if (!target) {
    log("未配置待检测的策略组，请在插件参数 group 中填写。当前配置中的策略组：");
    log("  " + groups.join(" | "));
    notify("AI 解锁检测", "未配置策略组", "请在插件参数中填写 group（要检测的策略组名）");
    return;
  }
  if (groups.indexOf(target) === -1) {
    log("策略组「" + target + "」不存在。可用：" + groups.join(" | "));
    notify("AI 解锁检测", "策略组不存在", target);
    return;
  }

  var builtin = conf.all_buildin_nodes || ["DIRECT", "REJECT"];
  var expanded = await expandGroup(target, builtin, 4);
  var nodes = expanded.nodes;

  if (!nodes.length) {
    log("策略组「" + target + "」内没有可检测的节点");
    notify("AI 解锁检测", "没有可检测的节点", target);
    return;
  }
  log(
    "展开策略组「" + target + "」：递归 " + expanded.depth + " 层，得到 " + nodes.length +
      " 个真实节点" + (expanded.groups.length ? "（途经子组：" + expanded.groups.join("、") + "）" : "")
  );

  log(
    "开始检测：组=" + target + "，节点=" + nodes.length + "，并发=" + CFG.concurrency +
      "，模式=" + CFG.depth + (CFG.strict ? "(严格)" : "") +
      "，服务=" + ACTIVE.map(function (s) { return s.name; }).join("/")
  );

  var store = loadStore();

  var pre = await routingPreflight(nodes);
  if (!pre.ok) {
    log(routingWarning(pre.reason + "，出口 " + pre.ip));
    notify("AI 解锁检测 · 结果不可信", "路由自检未通过", "所有节点出口 IP 相同，本次未检测");
    return;
  }
  log("路由自检通过：" + pre.reason);

  var results = await pool(nodes, CFG.concurrency, function (name) {
    return detect(name, name);
  });

  var final = [];
  for (var i = 0; i < nodes.length; i++) {
    var r = results[i];
    if (!r) {
      // 超出预算未测到，退回缓存
      var c = cacheHit(store, baseName(nodes[i]));
      if (c) {
        c.name = nodes[i];
        final.push(c);
      }
      continue;
    }
    final.push(r);
  }

  var sum = summarize(final);
  log("检测结果：\n" + sum.text);
  log("汇总：" + sum.headline);
  log("出口分布：实测 " + sum.exits.tested + " 个节点，" + sum.exits.distinct + " 个不同出口 IP");

  // 全量跑完后再复核一次：抽样可能蒙混过关，全量不会。
  // 结果不可信时绝不写缓存，否则会污染解析器后续的改名。
  if (sum.exits.suspicious) {
    log(routingWarning("全部 " + sum.exits.tested + " 个节点出口 IP 均为 " + sum.exits.ip));
    notify("AI 解锁检测 · 结果不可信", "路由自检未通过", "所有节点出口 IP 相同，结果未写入缓存");
    return sum;
  }

  for (var w = 0; w < nodes.length; w++) {
    if (results[w]) store.nodes[baseName(nodes[w])] = toRecord(results[w]);
  }
  saveStore(store);

  await autoSwitch(final);

  notify(
    "AI 解锁检测完成",
    target + " · " + CFG.depth + (CFG.strict ? " · 严格" : ""),
    sum.headline
  );
  return sum;
}

async function autoSwitch(results) {
  var map = [
    { key: "chatgpt", group: CFG.gptGroup },
    { key: "claude", group: CFG.cldGroup },
    { key: "gemini", group: CFG.gmnGroup }
  ];
  for (var i = 0; i < map.length; i++) {
    var it = map[i];
    if (!it.group || !CFG[it.key]) continue;
    var cands = results
      .filter(function (r) {
        return r && !r.dead && r[it.key] && r[it.key].ok;
      })
      .sort(function (a, b) {
        return (a.latency || 99999) - (b.latency || 99999);
      });
    if (!cands.length) {
      log("「" + it.group + "」没有可用节点，保持原选择");
      continue;
    }
    var current = "";
    try {
      current = $config.getSelectedPolicy(it.group) || "";
    } catch (e) {}
    if (current && current === cands[0].name) {
      log("「" + it.group + "」当前已是最优节点：" + current);
      continue;
    }
    var okSet = setSelectPolicy(it.group, cands[0].name);
    log(
      "「" + it.group + "」切换到 " + cands[0].name +
        " (" + cands[0].latency + "ms) " + (okSet === false ? "✗" : "✓")
    );
  }
}

/* ==================================================================
 * 11. 单节点检测（generic 作用于某个节点）
 * ================================================================== */

function htmlPanel(result) {
  var rows = ACTIVE.map(function (s) {
    var v = result[s.key];
    var val = !v
      ? "—"
      : v.ok
      ? "✅ 已解锁" + (v.cc ? " · " + flag(v.cc) + v.cc : "") + (v.note ? " · " + v.note : "")
      : "❌ " + (v.note || "未解锁");
    return "<b>" + s.name + "</b> ： " + val;
  });
  var head = result.dead
    ? "🛑 节点不可达" + (result.note ? "（" + result.note + "）" : "")
    : "出口 " + flag(result.cc) + " " + (result.cc || "未知") + " · " + result.latency + "ms";
  var body =
    "------------------------------</br>" +
    head +
    "</br>------------------------------</br>" +
    rows.join("</br>") +
    "</br>------------------------------</br><font color=#6959CD><b>节点</b> ➟ " +
    result.name +
    "</font>";
  return (
    '<p style="text-align: center; font-family: -apple-system; font-size: medium;">' +
    body +
    "</p>"
  );
}

async function runSingle() {
  log("单节点检测：" + SINGLE_NODE);
  var r = await detect(SINGLE_NODE, SINGLE_NODE);
  var store = loadStore();
  store.nodes[baseName(SINGLE_NODE)] = toRecord(r);
  saveStore(store);
  log(summarize([r]).text);
  $done({ title: "🤖 AI 解锁检测", htmlMessage: htmlPanel(r) });
}

/* ==================================================================
 * 12. 解析器模式
 * ================================================================== */

async function runParser() {
  var content = typeof $resource !== "undefined" && $resource !== null ? String($resource) : "";

  // 只处理节点资源，其余原样返回
  if ($resourceType !== 1) {
    log("资源类型 " + $resourceType + "，非节点列表，原样返回");
    $done(content);
    return;
  }

  var parsed = parseResource(content);
  if (!parsed || !parsed.entries.length) {
    log("未能从订阅中识别出节点，原样返回（长度 " + content.length + "）");
    $done(content);
    return;
  }

  log(
    "订阅格式=" + parsed.kind + "，节点数=" + parsed.entries.length +
      "，标记=" + CFG.marker + "，tagMode=" + CFG.tagMode + "，source=" + CFG.source
  );

  var store = loadStore();
  var entries = parsed.entries;

  // 决定是否在解析阶段实测
  var canTest = entries.some(function (e) {
    return e.testable;
  });
  var doTest =
    CFG.source === "test" ? true : CFG.source === "cache" ? false : canTest;

  if (doTest && !canTest) {
    log("当前订阅格式（" + parsed.kind + "）无法在解析阶段实测，改用缓存结果");
    doTest = false;
  }

  // ---- 路由自检 ----
  // 解析阶段是拿"节点描述"当出口的，这条路径不保证在所有 Loon 版本上生效。
  // 先抽样确认请求真的分别从各节点发出，否则宁可什么都不改。
  var useName = false;
  if (doTest) {
    var testable = entries.filter(function (e) {
      return e.testable;
    });
    var pre = await routingPreflight(
      testable.map(function (e) {
        return e.desc;
      })
    );
    if (!pre.ok) {
      log("按节点描述路由失败（" + pre.reason + "，出口 " + pre.ip + "），改用节点名重试");
      // 订阅不是第一次导入时，节点已经在配置里了，可以直接用节点名当出口。
      // 上一轮打过标记的话，配置里的名字是带标记的，所以两种都要试。
      var pre2 = await routingPreflight(
        testable.map(function (e) {
          return storedName(store, e.name);
        })
      );
      if (pre2.ok && pre2.samples && pre2.samples.length >= 2) {
        useName = true;
        log("按节点名路由可用（" + pre2.reason + "），改用节点名检测");
      } else {
        // 两条路都不通。不要放弃——定时任务插件写的缓存是按节点名测出来的，
        // 那份结果是可信的，退回去用它改名，比什么都不做有用得多。
        log("按节点名路由同样不可用（" + pre2.reason + "），本次不实测，改用缓存结果");
        log(routingWarning(pre.reason + "，出口 " + pre.ip));
        doTest = false;
      }
    } else {
      log("路由自检通过：" + pre.reason);
    }
  }

  var results = new Array(entries.length);
  var tested = 0;
  var reused = 0;

  if (doTest) {
    // 先用缓存填掉新鲜的，剩下的才实测
    var pending = [];
    for (var i = 0; i < entries.length; i++) {
      var base = baseName(entries[i].name);
      var c = cacheHit(store, base);
      if (c) {
        results[i] = c;
        reused++;
      } else if (entries[i].testable) {
        pending.push(i);
      }
    }
    log("缓存命中 " + reused + "，待实测 " + pending.length + "，预算 " + CFG.budget / 1000 + "s");

    var got = await pool(pending, CFG.concurrency, function (idx) {
      var ref = useName ? entries[idx].name : entries[idx].desc;
      return detect(ref, baseName(entries[idx].name));
    });
    for (var j = 0; j < pending.length; j++) {
      if (got[j]) results[pending[j]] = got[j];
    }

    // 逐节点结果 + 出口分布，全量跑完后再复核一次路由
    var sum = summarize(results.filter(Boolean));
    log("逐节点结果：\n" + sum.text);
    log(
      "出口分布：实测 " + sum.exits.tested + " 个节点，" + sum.exits.distinct + " 个不同出口 IP"
    );
    // 全量结果不可信：丢掉这批实测，退回缓存，而不是整个放弃
    if (sum.exits.suspicious) {
      log(routingWarning("全部 " + sum.exits.tested + " 个节点出口 IP 均为 " + sum.exits.ip));
      for (var z = 0; z < pending.length; z++) results[pending[z]] = null;
      for (var z2 = 0; z2 < entries.length; z2++) {
        if (results[z2]) continue;
        var zc = cacheHit(store, baseName(entries[z2].name));
        if (zc) {
          results[z2] = zc;
          reused++;
        }
      }
      log("已丢弃本次实测结果，改用缓存：命中 " + reused + " / " + entries.length);
    } else {
      for (var j2 = 0; j2 < pending.length; j2++) {
        if (!got[j2]) continue;
        store.nodes[baseName(entries[pending[j2]].name)] = toRecord(got[j2]);
        tested++;
      }
      saveStore(store);
    }
  } else {
    for (var k = 0; k < entries.length; k++) {
      var cc = cacheHit(store, baseName(entries[k].name));
      if (cc) {
        results[k] = cc;
        reused++;
      }
    }
    log("使用缓存结果：命中 " + reused + " / " + entries.length);
  }

  // ---- 缓存覆盖率诊断 ----
  // "一个标记都没打上" 绝大多数是订阅里的节点名和缓存里的键对不上，
  // 把两边的样本都打出来，一眼就能看出是不是名字问题。
  if (reused === 0 && tested === 0) {
    var storedKeys = Object.keys(store.nodes || {});
    log("");
    log("  ⚠️  本次没有任何可用的检测结果，所有节点都不会被打标记。");
    if (!storedKeys.length) {
      log("  缓存是空的 —— 「AI 解锁检测 · 定时任务」插件还没成功跑过。");
      log("  请先打开该插件手动触发一次，或等它的 cron 到点，再更新订阅。");
    } else {
      log("  缓存里有 " + storedKeys.length + " 条记录，但和本订阅的节点名一条都对不上：");
      log("    订阅节点名样本： " + entries.slice(0, 3).map(function (e) {
        return JSON.stringify(baseName(e.name));
      }).join("  "));
      log("    缓存键名样本：   " + storedKeys.slice(0, 3).map(function (k) {
        return JSON.stringify(k);
      }).join("  "));
      log("  两边对不上通常是因为定时任务插件的 group 填的不是这个订阅所在的策略组，");
      log("  或者缓存已经过期（cacheTTL 默认 12 小时）。");
    }
    log("");
    notify("AI 解锁检测 · 无可用结果", "没有节点被打标记", storedKeys.length
      ? "缓存与订阅节点名对不上，详见日志"
      : "定时任务插件还没跑过，请先手动触发一次");
  } else if (reused + tested < entries.length) {
    log("覆盖率：" + (reused + tested) + " / " + entries.length + " 个节点有结果，其余保持原名");
  }

  // 应用新名字
  var dropped = {};
  var hitCount = 0;
  var unknownCount = 0;
  for (var n = 0; n < entries.length; n++) {
    var e = entries[n];
    var res = results[n];
    // 没结果、或节点本身不可达，都属于"结论不确定"：保持原名不动。
    // 绝不因为一次网络抖动就抹掉上一轮的标记，也绝不删这类节点。
    if (!res || res.dead) {
      e.newName = String(e.name).trim();
      e.hit = MARKER_RE.test(e.newName);
      unknownCount++;
      continue;
    }
    e.newName = taggedName(e.name, res);
    e.hit = !!buildMarker(res);
    if (e.hit) hitCount++;
    else if (CFG.dropFailed) dropped[e.lineIndex] = true;
  }

  if (CFG.dropFailed && parsed.kind === "yaml") {
    log("YAML 格式下不支持删除节点，dropFailed 已忽略");
    dropped = {};
  }

  var ordered = entries.slice();
  if (CFG.sortFirst && parsed.reorderable) {
    ordered.sort(function (a, b) {
      var am = a.hit ? 0 : 1;
      var bm = b.hit ? 0 : 1;
      if (am !== bm) return am - bm;
      return a.lineIndex - b.lineIndex;
    });
  }

  // 记下这一轮实际写进订阅的名字。下次解析时配置里的节点就叫这个，
  // 按节点名路由要用它，不能用订阅里的原始名。
  var touched = false;
  for (var q = 0; q < entries.length; q++) {
    var qb = baseName(entries[q].name);
    if (store.nodes[qb] && store.nodes[qb].lastName !== entries[q].newName) {
      store.nodes[qb].lastName = entries[q].newName;
      touched = true;
    }
  }
  if (touched) saveStore(store);

  var output = parsed.render(ordered, dropped);

  log(
    "完成：实测 " + tested + "，复用缓存 " + reused + "，无结果保持原样 " + unknownCount +
      "，打标 " + hitCount + "，" +
      (CFG.dropFailed ? "已删除 " + Object.keys(dropped).length + " 个未解锁节点" : "保留全部节点")
  );
  // 没有任何结果时上面已经发过告警了，别再补一条"已更新"把它盖掉
  if (reused + tested > 0) {
    notify(
      "AI 解锁检测 · 订阅已更新",
      "打标 " + hitCount + " / " + entries.length,
      ACTIVE.map(function (s) { return s.name; }).join(" · ") + "｜标记：" + CFG.marker
    );
  }

  $done(output);
}

/* ==================================================================
 * 13. 入口
 * ================================================================== */

(async function main() {
  var started = Date.now();
  try {
    if (!ACTIVE.length) {
      log("三项服务全部关闭，无事可做");
      if (MODE === "parser") $done(typeof $resource !== "undefined" ? $resource : "");
      else $done();
      return;
    }

    if (MODE === "parser") {
      await runParser();
      return;
    }
    if (MODE === "single") {
      await runSingle();
      return;
    }
    await runBatch();
    log("耗时 " + ((Date.now() - started) / 1000).toFixed(1) + "s");
    $done();
  } catch (e) {
    log("执行出错: " + (e && e.stack ? e.stack : e));
    if (MODE === "parser") $done(typeof $resource !== "undefined" ? $resource : "");
    else if (MODE === "single") $done({ title: "🤖 AI 解锁检测", htmlMessage: "执行出错：" + e });
    else $done();
  }
})();
