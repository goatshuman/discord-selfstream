
import { createServer } from "node:http";

const port = Number(process.env.PORT) || 10000;

const server = createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const pathname = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`
  ).pathname;

  if (req.method === "GET" && pathname === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8"
    });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8"
    });
    res.end("Service is running");
    return;
  }

  res.writeHead(404, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`HTTP server listening on port ${port}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
