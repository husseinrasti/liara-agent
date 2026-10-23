// Leak fixture: retains ~50 MB per second until the container is OOM-killed.
const http = require('http');
const port = Number(process.env.PORT) || 3000;
const retained = [];
setInterval(() => {
  retained.push(Buffer.alloc(50 * 1024 * 1024, 1));
}, 1000);
setInterval(() => {
  console.log(`memory usage: ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
}, 5000);
http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    console.log(`${req.method} ${req.url} 200`);
  })
  .listen(port, () => console.log(`leak fixture listening on port ${port}`));
