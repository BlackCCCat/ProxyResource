const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const script = fs.readFileSync(path.join(__dirname, "../Script/ai_unlock.js"), "utf8");
const storage = {};

function run(globals) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("script did not call $done")), 2000);
    const context = {
      console: globals.console || console,
      setTimeout,
      clearTimeout,
      $argument: globals.$argument || {},
      $persistentStore: {
        read(key) {
          return storage[key] || null;
        },
        write(value, key) {
          storage[key] = value;
          return true;
        }
      },
      $done(value) {
        clearTimeout(timer);
        resolve(value);
      }
    };
    Object.assign(context, globals);
    vm.runInNewContext(script, context, { filename: "ai_unlock.js" });
  });
}

async function register(url, lines) {
  await run({
    $resourceType: 1,
    $resourceUrl: url,
    $resource: lines.join("\n"),
    $argument: {
      source: "cache",
      chatgpt: true,
      claude: false,
      gemini: false,
      notify: false
    }
  });
}

(async () => {
  await register("https://a.example/sub?token=secret-a", [
    "US-A = Shadowsocks,1.1.1.1,443,aes-128-gcm,password",
    "JP-A = Shadowsocks,2.2.2.2,443,aes-128-gcm,password"
  ]);
  await register("https://b.example/sub?token=secret-b", [
    "SG-B = Shadowsocks,3.3.3.3,443,aes-128-gcm,password"
  ]);

  const registered = JSON.parse(storage.AI_UNLOCK_RESULTS);
  assert.strictEqual(Object.keys(registered.sources || {}).length, 2, "两份订阅都应写入登记表");

  const requestedNodes = [];
  const logs = [];
  await run({
    console: { log: (line) => logs.push(String(line)) },
    $argument: {
      depth: "lite",
      routeCheck: false,
      chatgpt: true,
      claude: false,
      gemini: false,
      notify: false
    },
    $httpClient: {
      get(params, callback) {
        requestedNodes.push(params.node);
        const last = params.node === "US-A" ? "1" : params.node === "JP-A" ? "2" : "3";
        callback(null, { status: 200, headers: {} }, "ip=203.0.113." + last + "\nloc=US\n");
      }
    }
  });

  assert.deepStrictEqual(
    requestedNodes.slice().sort(),
    ["JP-A", "SG-B", "US-A"],
    "定时任务应按登记的三个真实节点名检测"
  );
  assert(logs.some((line) => line.includes("2 份订阅") && line.includes("3 个节点")));
  assert(!logs.join("\n").includes("secret"), "日志不应泄露订阅 token");
  console.log("ok - parser registry supplies all subscription nodes to batch detection");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
