import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// Used by docker-compose healthcheck / load balancers.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const server = http.createServer(app);
const io = new Server(server);

io.on('connection', (socket) => {
  console.log(`client connected ${socket.id}`);
});

server.listen(config.port, () => {
  console.log(`navigation game listening on http://localhost:${config.port}`);
});

// Graceful shutdown so containers stop cleanly.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    io.close();
    server.close(() => process.exit(0));
  });
}
