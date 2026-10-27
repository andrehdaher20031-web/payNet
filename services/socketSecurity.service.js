const { authenticateToken } = require('../middleware/authMiddleware');

const configureSocketSecurity = (io) => {
  io.use(async (socket, next) => {
    if (!socket.handshake.auth?.token) {
      socket.data.user = null;
      return next();
    }
    try { socket.data.user = await authenticateToken(socket.handshake.auth?.token); next(); }
    catch (error) { next(new Error(error.status === 503 ? 'AUTH_UNAVAILABLE' : 'UNAUTHORIZED')); }
  });
  io.on('connection', (socket) => {
    const joinOwnRooms = (user) => {
      if (!user) return;
      socket.join(`user:${user.id}`);
      if (user.email) socket.join(user.email);
      if (user.role === 'admin') socket.join('admins'); else socket.leave('admins');
    };
    joinOwnRooms(socket.data.user);
    socket.use(async (_packet, next) => {
      if (!socket.handshake.auth?.token) return next();
      try { socket.data.user = await authenticateToken(socket.handshake.auth?.token); joinOwnRooms(socket.data.user); next(); }
      catch { socket.disconnect(true); next(new Error('UNAUTHORIZED')); }
    });
    // Compatibility for existing clients; callers can join only their own room.
    socket.on('joinRoom', (email, acknowledge) => {
      const user = socket.data.user;
      const allowed = Boolean(user) && (email === user.email || email === `user:${user.id}`);
      if (allowed) socket.join(email);
      if (typeof acknowledge === 'function') acknowledge({ success: allowed });
    });
  });
  const timer = setInterval(async () => {
    const sockets = await io.fetchSockets().catch(() => []);
    await Promise.allSettled(sockets.map(async (socket) => {
      if (!socket.handshake.auth?.token) return;
      try {
        const user = await authenticateToken(socket.handshake.auth?.token);
        if (user.role !== 'admin') await socket.leave('admins');
      } catch { socket.disconnect(true); }
    }));
  }, 15000);
  timer.unref();
  const originalClose = io.close.bind(io);
  io.close = (...args) => { clearInterval(timer); return originalClose(...args); };
  return io;
};
module.exports = { configureSocketSecurity };
