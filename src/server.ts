import { createServer } from "node:http";

const port = Number(process.env.PORT) || 3000;

const server = createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Service is running");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`HTTP server listening on port ${port}`);
});
