const Transaction = require('../models/ProWaveTransaction');
const protocol = require('./proWaveProtocol.service');
const { Decimal } = protocol;
const graceMs = Number(process.env.PROWAVE_INVOICE_MISSING_GRACE_MS) || 30 * 60000;
const round = (value) => new Decimal(value).toDecimalPlaces(4).toNumber();
function extractProWaveBalanceUsd(response) {
  const value = protocol.payload(response);
  if (value?.success === false || response?.success === false) return null;
  const keys = ['available_balance', 'available_balance_usd', 'current_balance', 'current_balance_usd', 'balance', 'balance_usd', 'total_balance', 'totalBalance'];
  for (const key of keys) { const parsed = protocol.money(value?.[key]); if (parsed !== null) return parsed; }
  return null;
}
function extractProviderInvoices(response) {
  const value = protocol.payload(response);
  if (response?.success === false || value?.success === false) throw Object.assign(new Error('Supplier invoice query failed'), { code: 'INVOICE_QUERY_FAILED', status: 502 });
  const rows = [value, value?.invoices, value?.items, value?.data, value?.results].find(Array.isArray);
  if (!rows) throw Object.assign(new Error('Unexpected supplier invoice schema'), { code: 'INVALID_INVOICE_RESPONSE', status: 502 });
  return rows.filter(protocol.plain);
}
const getInvoiceAmountUsd = protocol.invoiceAmount;
const invoiceId = (invoice) => protocol.invoiceName(invoice) || (typeof invoice?.name === 'string' ? invoice.name : '') || String(invoice?.id || '');
function calculateFinancials({ paynetAmountSyp, providerCostUsd, exchangeRate }) {
  if (providerCostUsd === null || providerCostUsd === undefined) return { actualCostSyp: null, profitSyp: null, profitPercent: null };
  const cost = new Decimal(providerCostUsd).mul(exchangeRate);
  const profit = new Decimal(paynetAmountSyp).minus(cost);
  return { actualCostSyp: round(cost), profitSyp: round(profit), profitPercent: paynetAmountSyp > 0 ? round(profit.div(paynetAmountSyp).mul(100)) : 0 };
}
function reviewFilter() {
  return { $and: [{ $or: [{ reviewResolvedAt: { $exists: false } }, { reviewResolvedAt: null }] }, { $or: [
    { internalReviewStatus: 'needs_review' }, { status: { $in: ['unknown', 'manual_review', 'mismatch', 'delivery_pending'] } },
    { invoiceMatchStatus: { $in: ['missing', 'mismatch'] } }, { providerBalanceStatus: 'mismatch' },
  ] }] };
}
function buildFilter(query = {}) {
  const clauses = [];
  const base = {};
  if (query.status && query.status !== 'mismatch') base.status = query.status;
  if (query.operationType) base.operationType = query.operationType;
  if (query.invoiceMatchStatus) base.invoiceMatchStatus = query.invoiceMatchStatus;
  if (query.providerBalanceStatus) base.providerBalanceStatus = query.providerBalanceStatus;
  if (query.date || query.fromDate || query.toDate) {
    base.createdAt = {};
    const from = query.date || query.fromDate, to = query.date || query.toDate;
    if (from) base.createdAt.$gte = new Date(from + 'T00:00:00.000+03:00');
    if (to) base.createdAt.$lte = new Date(to + 'T23:59:59.999+03:00');
    if (Object.values(base.createdAt).some((date) => Number.isNaN(date.getTime()))) throw Object.assign(new Error('Invalid report date'), { status: 400 });
  }
  if (query.search) {
    const escaped = String(query.search).slice(0, 256).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const search = new RegExp(escaped, 'i');
    base.$or = ['userEmail', 'itemCode', 'itemTitle', 'game', 'playerId', 'prowaveInvoice', 'prowaveRequestName', 'clientRequestId'].map((field) => ({ [field]: search }));
  }
  clauses.push(base);
  if (query.status === 'mismatch' || query.review === 'needs_review' || query.review === 'true') clauses.push(reviewFilter());
  return clauses.length === 1 ? base : { $and: clauses };
}
async function getReconciliationReport(query = {}) {
  const filter = buildFilter(query);
  const page = Math.max(1, Math.trunc(Number(query.page)) || 1), limit = Math.min(100, Math.max(1, Math.trunc(Number(query.limit)) || 20));
  const settled = { $in: ['$status', ['completed', 'mismatch']] };
  const [transactions, total, totals] = await Promise.all([
    Transaction.find(filter).populate('user', 'name email').populate('payment', 'status amount calculatedAmount createdAt').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Transaction.countDocuments(filter),
    Transaction.aggregate([{ $match: filter }, { $group: {
      _id: null, count: { $sum: 1 },
      saleAmountUsd: { $sum: { $cond: [settled, { $multiply: [{ $ifNull: ['$saleUnitPriceUsd', '$unitPriceUsd'] }, { $ifNull: ['$qty', 1] }] }, 0] } },
      providerDiscountUsd: { $sum: { $cond: [settled, { $multiply: [{ $ifNull: ['$providerDiscountUsd', 0] }, { $ifNull: ['$qty', 1] }] }, 0] } },
      paynetAmountSyp: { $sum: { $cond: [settled, '$paynetAmountSyp', 0] } },
      reservedAmountSyp: { $sum: { $cond: [{ $in: ['$status', ['pending', 'unknown', 'manual_review', 'delivery_pending']] }, '$paynetAmountSyp', 0] } },
      refundedAmountSyp: { $sum: { $ifNull: ['$paynetRefundedSyp', 0] } },
      expectedProviderDebitUsd: { $sum: { $cond: [settled, '$expectedProviderDebitUsd', 0] } },
      actualProviderDebitUsd: { $sum: { $cond: [settled, { $ifNull: ['$invoiceProviderDebitUsd', '$actualProviderDebitUsd'] }, 0] } },
      expectedCostSyp: { $sum: { $cond: [settled, '$expectedCostSyp', 0] } },
      actualCostSyp: { $sum: { $cond: [settled, { $cond: [{ $ne: [{ $ifNull: ['$invoiceProviderDebitUsd', null] }, null] }, '$actualCostSyp', 0] }, 0] } },
      profitSyp: { $sum: { $cond: [settled, { $cond: [{ $ne: [{ $ifNull: ['$invoiceProviderDebitUsd', null] }, null] }, '$profitSyp', 0] }, 0] } },
      estimatedProfitSyp: { $sum: { $cond: [settled, { $ifNull: ['$estimatedProfitSyp', { $subtract: ['$paynetAmountSyp', '$expectedCostSyp'] }] }, 0] } },
      costUnconfirmed: { $sum: { $cond: [{ $and: [settled, { $eq: [{ $ifNull: ['$invoiceProviderDebitUsd', null] }, null] }] }, 1, 0] } },
      mismatches: { $sum: { $cond: [{ $and: [{ $eq: [{ $ifNull: ['$reviewResolvedAt', null] }, null] }, { $or: [
        { $eq: ['$internalReviewStatus', 'needs_review'] }, { $in: ['$status', ['unknown', 'manual_review', 'mismatch', 'delivery_pending']] },
        { $in: ['$invoiceMatchStatus', ['missing', 'mismatch']] }, { $eq: ['$providerBalanceStatus', 'mismatch'] },
      ] }] }, 1, 0] } },
      failed: { $sum: { $cond: [{ $in: ['$status', ['failed', 'refunded']] }, 1, 0] } },
    } }]),
  ]);
  return { transactions, summary: totals[0] || { count: 0, saleAmountUsd: 0, providerDiscountUsd: 0, paynetAmountSyp: 0, reservedAmountSyp: 0, refundedAmountSyp: 0, expectedProviderDebitUsd: 0, actualProviderDebitUsd: 0, expectedCostSyp: 0, actualCostSyp: 0, profitSyp: 0, estimatedProfitSyp: 0, costUnconfirmed: 0, mismatches: 0, failed: 0 }, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}
async function reconcileTransactionsWithInvoices(response, { completeCoverage = false } = {}) {
  const invoices = extractProviderInvoices(response);
  const byName = new Map(invoices.map((invoice) => [invoiceId(invoice), invoice]).filter(([name]) => name));
  let cursor = null, matched = 0, missing = 0, mismatched = 0, scannedTransactions = 0;
  for (;;) {
    const filter = { prowaveInvoice: { $exists: true, $ne: '' }, status: { $in: ['pending', 'delivery_pending', 'completed', 'mismatch'] }, ...(cursor ? { _id: { $gt: cursor } } : {}) };
    const transactions = await Transaction.find(filter).sort({ _id: 1 }).limit(500);
    if (!transactions.length) break;
    for (const transaction of transactions) {
      scannedTransactions++;
      const invoice = byName.get(transaction.prowaveInvoice);
      if (!invoice) {
        if (!completeCoverage || transaction.invoiceMatchStatus === 'matched' && transaction.rawInvoice) continue;
        const date = transaction.completedAt || transaction.startedAt || transaction.createdAt;
        if (Date.now() - new Date(date).getTime() < graceMs) continue;
        await Transaction.updateOne({ _id: transaction._id, invoiceMatchStatus: { $ne: 'matched' } }, { $set: { invoiceMatchStatus: 'missing', internalReviewStatus: 'needs_review', internalReviewReason: 'الفاتورة غائبة عن سجل المزوّد الكامل', mismatchReason: 'الفاتورة غائبة عن سجل المزوّد الكامل' } });
        missing++; continue;
      }
      const cost = getInvoiceAmountUsd(invoice);
      const tolerance = transaction.operationType === 'direct_topup' ? Math.max(0.1, transaction.expectedProviderDebitUsd * 0.05) : 0.01;
      const invoiceMatchStatus = cost === null ? 'unavailable' : new Decimal(cost).minus(transaction.expectedProviderDebitUsd).abs().lte(tolerance) ? 'matched' : 'mismatch';
      const reason = invoiceMatchStatus === 'mismatch' ? 'تكلفة الفاتورة لا تطابق لقطة سعر الشراء' : invoiceMatchStatus === 'unavailable' ? 'تعذر قراءة تكلفة الفاتورة' : '';
      const update = { invoiceMatchStatus, rawInvoice: invoice, invoiceProviderDebitUsd: cost,
        internalReviewStatus: reason ? transaction.reviewResolvedAt && transaction.internalReviewReason === reason ? 'clear' : 'needs_review' : 'clear', internalReviewReason: reason, mismatchReason: reason };
      if (cost !== null && ['completed', 'mismatch'].includes(transaction.status)) Object.assign(update, calculateFinancials({ paynetAmountSyp: transaction.paynetAmountSyp, providerCostUsd: cost, exchangeRate: transaction.exchangeRate }));
      await Transaction.updateOne({ _id: transaction._id, status: transaction.status }, { $set: update });
      if (invoiceMatchStatus === 'matched') matched++;
      if (invoiceMatchStatus === 'mismatch') mismatched++;
    }
    cursor = transactions[transactions.length - 1]._id;
    if (transactions.length < 500) break;
  }
  return { providerInvoices: invoices.length, scannedTransactions, matched, missing, mismatched, completeCoverage };
}
module.exports = { calculateFinancials, extractProWaveBalanceUsd, extractProviderInvoices, getInvoiceAmountUsd, getReconciliationReport, reconcileTransactionsWithInvoices, buildFilter };
