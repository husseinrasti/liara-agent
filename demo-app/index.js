const http = require('http');

const port = Number(process.env.PORT) || 3000;

http
  .createServer((req, res) => {
    const started = Date.now();
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>فروشگاه نمونه</title><h1>فروشگاه نمونه</h1><p>${new Date().toISOString()}</p>`);
    }
    console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
  })
  .listen(port, () => console.log(`demo app listening on port ${port}`));
