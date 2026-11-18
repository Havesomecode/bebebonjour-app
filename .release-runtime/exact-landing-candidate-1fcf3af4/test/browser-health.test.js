import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createServer } from "node:net";
import { after, before, test } from "node:test";

const routes = [
  { path: "/", title: "Bonjour Bébé" },
  { path: "/demo", title: "Démonstration synthétique" },
  { path: "/demo/announcements/amal/fr/", title: "Amal" },
  { path: "/demo/announcements/amal/ar/", title: "Amal" },
  { path: "/demo/announcements/bayane/fr/", title: "Bayane" },
  { path: "/demo/announcements/bayane/ar/", title: "Bayane" },
];

let browser;
let browserDebugOrigin;
let browserProfile;
let origin;
let vite;

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHttp(url, label) {
  const deadline = Date.now() + 10_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${label} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`${label} did not become ready: ${lastError?.message}`);
}

async function findBrowserExecutable() {
  const configured = process.env.BROWSER_EXECUTABLE_PATH;
  const candidates = [
    configured,
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ...["brave", "brave-browser", "chromium", "chromium-browser"].flatMap((name) =>
      (process.env.PATH || "").split(delimiter).map((directory) => join(directory, name)),
    ),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next approved Brave/Chromium executable.
    }
  }

  throw new Error(
    "Browser regression requires Brave or Chromium; set BROWSER_EXECUTABLE_PATH when it is not on PATH.",
  );
}

function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (${code ?? signal})\n${output}`));
    });
  });
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }

      for (const listener of this.listeners.get(message.method) || []) {
        listener(message.params || {});
      }
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CdpClient(socket);
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method, timeout = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeout);
      this.on(method, (params) => {
        clearTimeout(timer);
        resolve(params);
      });
    });
  }

  close() {
    this.socket.close();
  }
}

async function openTarget(url, viewport) {
  const created = await fetch(`${browserDebugOrigin}/json/new?${encodeURIComponent("about:blank")}`, {
    method: "PUT",
  });
  assert.equal(created.status, 200, "browser target creation must succeed");
  const target = await created.json();
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  const consoleErrors = [];
  const failedRequests = [];
  const httpErrors = [];
  const requestOrigins = new Set();
  let responseCount = 0;

  client.on("Network.requestWillBeSent", ({ request }) => {
    if (/^https?:/.test(request.url)) requestOrigins.add(new URL(request.url).origin);
  });
  client.on("Network.responseReceived", ({ response }) => {
    if (response.url.startsWith(origin)) {
      responseCount += 1;
      if (response.status >= 400) httpErrors.push(`${response.status} ${response.url}`);
    }
  });
  client.on("Network.loadingFailed", ({ errorText }) => failedRequests.push(errorText));
  client.on("Log.entryAdded", ({ entry }) => {
    if (entry.level === "error") consoleErrors.push(entry.text);
  });
  client.on("Runtime.consoleAPICalled", ({ args, type }) => {
    if (type === "error") consoleErrors.push(args.map((argument) => argument.value).join(" "));
  });
  client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    consoleErrors.push(exceptionDetails.exception?.description || exceptionDetails.text);
  });

  await Promise.all([
    client.send("Log.enable"),
    client.send("Network.enable"),
    client.send("Page.enable"),
    client.send("Runtime.enable"),
    client.send("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: viewport.deviceScaleFactor,
      height: viewport.height,
      mobile: viewport.mobile,
      width: viewport.width,
    }),
  ]);

  const loaded = client.waitFor("Page.loadEventFired");
  await client.send("Page.navigate", { url });
  await loaded;
  await new Promise((resolve) => setTimeout(resolve, 750));
  const title = await client.send("Runtime.evaluate", {
    expression: "document.title",
    returnByValue: true,
  });

  client.close();
  await fetch(`${browserDebugOrigin}/json/close/${target.id}`);

  return {
    consoleErrors,
    failedRequests,
    httpErrors,
    requestOrigins: [...requestOrigins],
    responseCount,
    title: title.result.value,
  };
}

before(async () => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await runProcess(npm, ["run", "build"]);

  const [vitePort, browserPort, browserExecutable] = await Promise.all([
    reservePort(),
    reservePort(),
    findBrowserExecutable(),
  ]);

  origin = `http://127.0.0.1:${vitePort}`;
  vite = spawn(
    npm,
    ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"],
    { stdio: "ignore" },
  );
  await waitForHttp(`${origin}/`, "Vite preview server");

  browserProfile = await mkdtemp(join(tmpdir(), "bebebonjour-browser-health-"));
  browserDebugOrigin = `http://127.0.0.1:${browserPort}`;
  browser = spawn(
    browserExecutable,
    [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-default-browser-check",
      "--no-first-run",
      `--remote-debugging-port=${browserPort}`,
      `--user-data-dir=${browserProfile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  await waitForHttp(`${browserDebugOrigin}/json/version`, "browser debugging endpoint");
});

after(async () => {
  stopProcess(browser);
  stopProcess(vite);
  if (browserProfile) await rm(browserProfile, { force: true, recursive: true });
});

test("all first-party routes load without same-origin HTTP or console errors", async (context) => {
  const landing = await fetch(`${origin}/`);
  const demo = await fetch(`${origin}/demo`);
  const favicon = await fetch(`${origin}/favicon.ico`);
  const faviconBytes = new Uint8Array(await favicon.arrayBuffer());

  assert.match(await landing.text(), /<link rel="icon"[^>]*href="\/favicon\.ico"/);
  assert.match(await demo.text(), /<link rel="icon"[^>]*href="\/favicon\.ico"/);
  assert.equal(favicon.status, 200, "/favicon.ico must return an icon instead of a 404 or HTML fallback");
  assert.match(favicon.headers.get("content-type") || "", /^image\//);
  assert.deepEqual([...faviconBytes.slice(0, 4)], [0, 0, 1, 0], "favicon must contain ICO bytes");

  const viewports = [
    { deviceScaleFactor: 1, height: 900, mobile: false, name: "desktop", width: 1440 },
    { deviceScaleFactor: 2, height: 844, mobile: true, name: "mobile", width: 390 },
  ];
  let responseCount = 0;

  for (const viewport of viewports) {
    for (const route of routes) {
      const result = await openTarget(`${origin}${route.path}`, viewport);
      responseCount += result.responseCount;
      assert.match(result.title, new RegExp(route.title, "i"), `${viewport.name} ${route.path} title`);
      assert.deepEqual(result.httpErrors, [], `${viewport.name} ${route.path} same-origin HTTP errors`);
      assert.deepEqual(result.failedRequests, [], `${viewport.name} ${route.path} failed requests`);
      assert.deepEqual(result.consoleErrors, [], `${viewport.name} ${route.path} console errors`);
      assert.deepEqual(result.requestOrigins, [origin], `${viewport.name} ${route.path} request origins`);
    }
  }

  context.diagnostic(
    `captured ${responseCount} same-origin responses and zero HTTP, request, or console errors across 12 desktop/mobile journeys`,
  );
});
