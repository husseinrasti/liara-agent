// Missing-env fixture: exits at startup when API_KEY is not configured.
const http = require('http');
const port = Number(process.env.PORT) || 3000;
if (!process.env.API_KEY) {
  console.error('Error: API_KEY is not set');
  process.exit(1);
}
http.createServer((req, res) => res.end('ok')).listen(port, () => console.log(`missing-env fixture listening on port ${port}`));
