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

/**
 * 检测单个节点。
 * @param nodeRef 节点名 / 策略组名 / 完整的 Loon 节点描述
 */
async function detect(nodeRef, label) {
  var result = { name: label || nodeRef, cc: "", dead: false, latency: 0, ts: Date.now() };

  // 先用 Cloudflare trace 做连通性探测并拿到出口地区，代价极小。
  // 开启 ChatGPT 检测时直接打 chatgpt.com，顺带验证 OpenAI 域名可达。
  var traceUrl = CFG.chatgpt
    ? "https://chatgpt.com/cdn-cgi/trace"
    : "https://www.cloudflare.com/cdn-cgi/trace";
  var trace = await get(traceUrl, nodeRef, { "User-Agent": UA_WEB });
  if (trace.error || !trace.body) {
    result.dead = true;
    result.note = trace.error || "无响应";
    return result;
  }
  result.latency = trace.elapsed;
  var m = trace.body.match(/loc=([A-Z]{2})/);
  result.cc = m ? m[1] : "";

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
  var rec = { cc: result.cc || "", ts: result.ts || Date.now(), latency: result.latency || 0 };
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
  var r = { name: name, cc: rec.cc || "", ts: rec.ts || 0, latency: rec.latency || 0, cached: true };
  if (rec.dead) r.dead = true;
  for (var i = 0; i < SERVICES.length; i++) {
    var s = SERVICES[i];
    if (rec[s.code] !== undefined) {
      r[s.key] = { ok: rec[s.code] === 1, cc: r.cc, note: rec[s.code + "_n"] || "" };
    }
  }
  return r;
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
      lines.push("  ✖ " + r.name + "  (不可达)");
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
    headline: head + "，不可达 " + dead + "，共 " + results.length
  };
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

  var subs = await getSubPolicies(target);
  var builtin = conf.all_buildin_nodes || ["DIRECT", "REJECT"];
  var nodes = subs.filter(function (n) {
    if (!n) return false;
    if (builtin.indexOf(n) !== -1) return false;
    if (/^REJECT/i.test(n) || n === "DIRECT") return false;
    if (groups.indexOf(n) !== -1) return false; // 跳过嵌套策略组
    return true;
  });

  if (!nodes.length) {
    log("策略组「" + target + "」内没有可检测的节点");
    notify("AI 解锁检测", "没有可检测的节点", target);
    return;
  }

  log(
    "开始检测：组=" + target + "，节点=" + nodes.length + "，并发=" + CFG.concurrency +
      "，模式=" + CFG.depth + (CFG.strict ? "(严格)" : "") +
      "，服务=" + ACTIVE.map(function (s) { return s.name; }).join("/")
  );

  var store = loadStore();
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
    store.nodes[baseName(nodes[i])] = toRecord(r);
    final.push(r);
  }
  saveStore(store);

  var sum = summarize(final);
  log("检测结果：\n" + sum.text);
  log("汇总：" + sum.headline);

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
      return detect(entries[idx].desc, baseName(entries[idx].name));
    });
    for (var j = 0; j < pending.length; j++) {
      var r = got[j];
      if (!r) continue;
      results[pending[j]] = r;
      store.nodes[baseName(entries[pending[j]].name)] = toRecord(r);
      tested++;
    }
    saveStore(store);
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

  var output = parsed.render(ordered, dropped);

  log(
    "完成：实测 " + tested + "，复用缓存 " + reused + "，无结果保持原样 " + unknownCount +
      "，打标 " + hitCount + "，" +
      (CFG.dropFailed ? "已删除 " + Object.keys(dropped).length + " 个未解锁节点" : "保留全部节点")
  );
  notify(
    "AI 解锁检测 · 订阅已更新",
    "打标 " + hitCount + " / " + entries.length,
    ACTIVE.map(function (s) { return s.name; }).join(" · ") + "｜标记：" + CFG.marker
  );

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
