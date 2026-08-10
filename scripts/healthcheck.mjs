import { request } from "node:http";

const port = Number(process.env.HARNESS_PORT ?? 8790);

const check = request({ host: "127.0.0.1", port, path: "/health/ready", timeout: 4_000 }, (response) => {
  response.resume();
  process.exit(response.statusCode === 200 ? 0 : 1);
});
check.on("timeout", () => check.destroy(new Error("timeout")));
check.on("error", () => process.exit(1));
check.end();
