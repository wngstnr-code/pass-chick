import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';

// 1. Load environment variables dari file .env
dotenv.config();

// 2. Inisialisasi Express & HTTP Server
const app = express();
const port = process.env.PORT || 3000;
const httpServer = createServer(app); // Membungkus Express dengan HTTP Server agar Socket.io bisa berjalan

// 3. Setup Socket.io untuk fitur Real-time
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || '*', // Nantinya ganti '*' dengan URL Frontend kamu demi keamanan
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// 4. Middlewares
app.use(helmet()); // Menambahkan header keamanan dasar (Wajib untuk produksi)
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
})); // Mengizinkan akses dari Frontend
app.use(express.json()); // Agar bisa membaca body request berformat JSON
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser()); // Agar bisa mengelola cookie (penting untuk SIWE/Autentikasi nanti)

// 5. REST API Routes Dasar
app.get('/', (req: Request, res: Response) => {
  res.json({
    status: 'success',
    message: '🚀 Welcome to Chicken Monad Backend API!'
  });
});

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 6. Socket.io Event Listeners
io.on('connection', (socket) => {
  console.log(`🟢 Client connected: ${socket.id}`);

  // Contoh mendengarkan pesan dari client
  socket.on('ping', () => {
    socket.emit('pong', { message: 'Hello from Chicken Monad Server!' });
  });

  socket.on('disconnect', () => {
    console.log(`🔴 Client disconnected: ${socket.id}`);
  });
});

// 7. Start Server
httpServer.listen(port, () => {
  console.log(`
===========================================
🚀 Server berjalan di: http://localhost:${port}
===========================================
  `);
});