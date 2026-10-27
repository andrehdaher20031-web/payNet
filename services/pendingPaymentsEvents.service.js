// Anonymous clients receive only an invalidation signal. Payment details stay in
// authenticated administrator rooms and protected HTTP responses.
function publishPendingPayments(io, payments) {
  if (!io) return;
  io.to('admins').emit('pendingPaymentsUpdate', payments);
  io.emit('pendingPaymentsChanged');
}

module.exports = { publishPendingPayments };
