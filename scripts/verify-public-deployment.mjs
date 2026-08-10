const origin = process.env.HARNESS_PUBLIC_ORIGIN?.replace(/\/$/, "");
const password = process.env.HARNESS_LOGIN_PASSWORD;
if (!origin || !password) throw new Error("HARNESS_PUBLIC_ORIGIN and HARNESS_LOGIN_PASSWORD are required");
if (!origin.startsWith("https://")) throw new Error("Public verification requires an HTTPS origin");

const ready = await fetch(`${origin}/health/ready`);
assert(ready.ok, `readiness returned ${ready.status}`);

const root = await fetch(`${origin}/`);
const rootHtml = await root.text();
const csp = root.headers.get("content-security-policy") ?? "";
assert(root.ok && rootHtml.includes("Continue with Universal AI"), "user login page is unavailable");
assert(rootHtml.includes("https://js.puter.com/v2/"), "user login page does not load the expected Puter SDK");
assert(/script-src 'nonce-[A-Za-z0-9_-]+'/.test(csp) && !csp.includes("unsafe-inline"), "user CSP is not nonce-restricted");

const admin = await fetch(`${origin}/admin/login`);
const adminHtml = await admin.text();
assert(admin.ok && !adminHtml.includes("js.puter.com"), "administrator login is not isolated from third-party scripts");

const hostile = await fetch(`${origin}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "https://hostile.invalid" },
  body: JSON.stringify({ password: "wrong" }),
});
assert(hostile.status === 403, `hostile Origin returned ${hostile.status}`);

const login = await fetch(`${origin}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ password }),
});
assert(login.ok, `administrator login returned ${login.status}`);
const setCookie = login.headers.get("set-cookie") ?? "";
assert(/HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), "session cookie flags are incomplete");
const cookie = setCookie.split(";", 1)[0];

const me = await fetch(`${origin}/auth/me`, { headers: { cookie } });
assert(me.ok && (await me.json()).authenticated === true, "authenticated identity check failed");
const providers = await fetch(`${origin}/v1/providers`, { headers: { cookie } });
const providerBody = await providers.json();
assert(providers.ok && Array.isArray(providerBody.data), "provider dashboard check failed");

let model;
if (process.env.HARNESS_SMOKE_MODEL === "true") {
  const started = Date.now();
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "Reply briefly that the harness is ready." }], max_tokens: 16 }),
    signal: AbortSignal.timeout(150_000),
  });
  const envelope = await response.json();
  assert(response.ok && typeof envelope.choices?.[0]?.message?.content === "string", `model smoke returned ${response.status}`);
  model = { provider: response.headers.get("x-harness-provider"), model: response.headers.get("x-harness-model"), latencyMs: Date.now() - started };
}

console.log(JSON.stringify({
  origin,
  ready: true,
  csp: true,
  adminIsolation: true,
  originDefense: true,
  secureSession: true,
  providerConnections: providerBody.data.length,
  ...(model ? { model } : {}),
}));

function assert(condition, message) {
  if (!condition) throw new Error(`public deployment verification failed: ${message}`);
}
