// Healthy fixture: answers every request with 200 and logs one line per request.
const http = require('http');
const port = Number(process.env.PORT) || 3000;
http
  .createServer((req, res) => {
    const started = Date.now();
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    console.log(`${req.method} ${req.url} 200 ${Date.now() - started}ms`);
  })
  .listen(port, () => console.log(`healthy fixture listening on port ${port}`));
