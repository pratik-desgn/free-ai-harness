import assert from "node:assert/strict";
import test from "node:test";
import { adminLoginHtml, dashboardHtml, loginHtml, privacyHtml, termsHtml } from "../src/ui.js";

test("user login offers one universal authorization without exposing administrator credentials", () => {
  assert.match(loginHtml, /Continue with Universal AI/);
  assert.match(loginHtml, /https:\/\/js\.puter\.com\/v2\//);
  assert.match(loginHtml, /\/auth\/puter/);
  assert.doesNotMatch(loginHtml, /id="password"/);
  assert.doesNotMatch(loginHtml, /\/auth\/login/);
  assert.match(loginHtml, /href="\/privacy"/);
  assert.match(loginHtml, /href="\/terms"/);
});

test("administrator login is isolated from Puter and uses a password form", () => {
  assert.match(adminLoginHtml, /Administrator access/);
  assert.match(adminLoginHtml, /id="password" type="password"/);
  assert.match(adminLoginHtml, /\/auth\/login/);
  assert.doesNotMatch(adminLoginHtml, /js\.puter\.com|authToken|\/auth\/puter/);
});

test("dashboard exposes automatic routing and account controls without a model picker", () => {
  assert.match(dashboardHtml, /No model picker/);
  assert.match(dashboardHtml, /Export retained summary/);
  assert.match(dashboardHtml, /up to 200 recent retained workflows/);
  assert.match(dashboardHtml, /Disconnect Universal AI/);
  assert.match(dashboardHtml, /Delete account/);
  assert.doesNotMatch(dashboardHtml, /<select\b/i);
});

test("public legal pages disclose self-hosting, retention, provider, and billing boundaries", () => {
  assert.match(privacyHtml, /self-hosted AI gateway/);
  assert.match(privacyHtml, /encrypted backups remain/i);
  assert.match(privacyHtml, /automatically selected provider/);
  assert.match(termsHtml, /Do not automate account creation/);
  assert.match(termsHtml, /billing guarantees/);
});
