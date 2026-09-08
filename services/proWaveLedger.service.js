const ProWaveTransaction = require('../models/ProWaveTransaction');

const PROVIDER_DEBIT_TOLERANCE_USD =
  Number(process.env.PROWAVE_PROVIDER_DEBIT_TOLERANCE_USD) || 0.01;

const toNumber = (value, fallback = null) => {
  const normalized =
    typeof value === 'string'
      ? value.replace(/[^0-9.+-]/g, '')
      : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toRoundedNumber = (value, digits = 4) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Number(parsed.toFixed(digits));
};

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const getNestedPayload = (responseData) => {
  const candidates = [
    responseData?.message?.data,
    responseData?.data?.message?.data,
    responseData?.data?.data,
    responseData?.data,
    isPlainObject(responseData?.message) ? responseData.message : undefined,
    responseData,
  ];

  return candidates.find((value) => value !== undefined && value !== null) || {};
};

const normalizeKey = (key) => String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const balanceKeyScore = (key) => {
  const normalized = normalizeKey(key);
  if (!normalized.includes('balance')) return 0;
  if (normalized.includes('available')) return 4;
  if (normalized.includes('current')) return 3;
  if (normalized === 'balance') return 2;
  return 1;
};

const extractNumberByKey = (value, scorer, depth = 0) => {
  if (depth > 6 || value === null || value === undefined) return null;

  if (typeof value !== 'object') return null;

  let best = null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractNumberByKey(item, scorer, depth + 1);
      if (nested && (!best || nested.score > best.score)) best = nested;
    }
    return best;
  }

  for (const [key, raw] of Object.entries(value)) {
    const parsed = toNumber(raw);
    const score = scorer(key);

    if (score > 0 && parsed !== null) {
      const candidate = { score, value: parsed, key };
      if (!best || candidate.score > best.score) best = candidate;
    }

    const nested = extractNumberByKey(raw, scorer, depth + 1);
    if (nested && (!best || nested.score > best.score)) best = nested;
  }

  return best;
};

const extractProWaveBalanceUsd = (responseData) => {
  const payload = getNestedPayload(responseData);
  const directCandidates = [
    payload?.available_balance,
    payload?.available_balance_usd,
    payload?.current_balance,
    payload?.current_balance_usd,
    payload?.balance,
    payload?.balance_usd,
    payload?.total_balance,
    payload?.total_balance_usd,
    payload?.totalBalance,
  ];

  for (const candidate of directCandidates) {
    const parsed = toNumber(candidate);
    if (parsed !== null) return parsed;
  }

  return extractNumberByKey(payload, balanceKeyScore)?.value ?? null;
};

const collectArrays = (value, arrays = [], depth = 0) => {
  if (depth > 6 || value === null || value === undefined) return arrays;

  if (Array.isArray(value)) {
    if (value.some((item) => isPlainObject(item))) arrays.push(value);
    value.forEach((item) => collectArrays(item, arrays, depth + 1));
    return arrays;
  }

  if (typeof value === 'object') {
    Object.values(value).forEach((item) => collectArrays(item, arrays, depth + 1));
  }

  return arrays;
};

const getInvoiceName = (invoice = {}) =>
  invoice.sales_invoice ||
  invoice.invoice_name ||
  invoice.invoice ||
  invoice.name ||
  invoice.id ||
  '';

const getInvoiceAmountUsd = (invoice = {}) =>
  toNumber(
    invoice['Total Amount'] ??
      invoice.total_amount ??
      invoice.totalAmount ??
      invoice.grand_total ??
      invoice.rounded_total ??
      invoice.amount
  );

const extractProviderInvoices = (responseData) => {
  const payload = getNestedPayload(responseData);
  const directCandidates = [
    payload?.invoices,
    payload?.items,
    payload?.data,
    payload?.results,
    payload?.message,
  ];

  for (const candidate of directCandidates) {
    if (Array.isArray(candidate)) return candidate.filter(isPlainObject);
  }

  const arrays = collectArrays(payload);
  return arrays.sort((a, b) => b.length - a.length)[0]?.filter(isPlainObject) || [];
};

const getProviderDebitStatus = ({ expected, actual }) => {
  if (actual === null || actual === undefined) return 'unavailable';
  return Math.abs(Number(expected || 0) - Number(actual || 0)) <= PROVIDER_DEBIT_TOLERANCE_USD
    ? 'matched'
    : 'mismatch';
};

const calculateFinancials = ({
  paynetAmountSyp,
  providerCostUsd,
  exchangeRate,
}) => {
  const expectedCostSyp = toRoundedNumber(Number(providerCostUsd || 0) * Number(exchangeRate || 0));
  const profitSyp = toRoundedNumber(Number(paynetAmountSyp || 0) - Number(expectedCostSyp || 0));
  const profitPercent =
    Number(paynetAmountSyp || 0) > 0
      ? toRoundedNumber((Number(profitSyp || 0) / Number(paynetAmountSyp)) * 100)
      : 0;

  return {
    expectedCostSyp,
    actualCostSyp: expectedCostSyp,
    profitSyp,
    profitPercent,
  };
};

const buildMismatchReason = ({
  providerBalanceStatus,
  invoiceMatchStatus,
  expectedProviderDebitUsd,
  actualProviderDebitUsd,
  invoiceProviderDebitUsd,
  hasInvoice,
}) => {
  const reasons = [];

  if (!hasInvoice) reasons.push('لا توجد فاتورة ProWave محفوظة للعملية');
  if (invoiceMatchStatus === 'missing') reasons.push('فاتورة ProWave غير موجودة في كشف ProWave');
  if (invoiceMatchStatus === 'mismatch') {
    reasons.push(
      `قيمة الفاتورة لا تطابق المتوقع (${expectedProviderDebitUsd} / ${invoiceProviderDebitUsd})`
    );
  }
  if (providerBalanceStatus === 'mismatch') {
    reasons.push(
      `فرق رصيد ProWave لا يطابق المتوقع (${expectedProviderDebitUsd} / ${actualProviderDebitUsd})`
    );
  }

  return reasons.join('، ');
};

const resolveCompletedStatus = ({
  providerBalanceStatus,
  invoiceMatchStatus = 'pending',
  hasInvoice,
  expectedProviderDebitUsd,
  actualProviderDebitUsd,
  invoiceProviderDebitUsd,
}) => {
  const mismatchReason = buildMismatchReason({
    providerBalanceStatus,
    invoiceMatchStatus,
    expectedProviderDebitUsd,
    actualProviderDebitUsd,
    invoiceProviderDebitUsd,
    hasInvoice,
  });

  return {
    status: mismatchReason ? 'mismatch' : 'completed',
    mismatchReason,
  };
};

const createPendingTransaction = async ({
  payment,
  user,
  userEmail,
  operationType = 'digital_card',
  itemCode,
  itemName,
  itemTitle,
  game,
  playerId,
  rechargeCategory,
  qty,
  currency,
  paynetAmountSyp,
  paynetUnitAmountSyp,
  paynetBalanceBeforeSyp,
  pricing,
  quote,
}) => {
  const quantity = Number(qty || 1);
  const saleUnitPriceUsd = toRoundedNumber(
    Number(pricing.saleUnitPriceUsd || pricing.unitPriceUsd || 0)
  );
  const providerUnitCostUsd = toRoundedNumber(
    Number(
      pricing.providerUnitCostUsd ||
        pricing.providerCostUsd ||
        pricing.providerUnitPriceUsd ||
        saleUnitPriceUsd ||
        0
    )
  );
  const providerDiscountUsd = toRoundedNumber(
    Math.max(0, Number(saleUnitPriceUsd || 0) - Number(providerUnitCostUsd || 0))
  );
  const providerDiscountPercent =
    Number(saleUnitPriceUsd || 0) > 0
      ? toRoundedNumber((Number(providerDiscountUsd || 0) / Number(saleUnitPriceUsd)) * 100)
      : 0;
  const expectedProviderDebitUsd = toRoundedNumber(Number(providerUnitCostUsd || 0) * quantity);
  const financials = calculateFinancials({
    paynetAmountSyp,
    providerCostUsd: expectedProviderDebitUsd,
    exchangeRate: pricing.exchangeRate,
  });

  return ProWaveTransaction.create({
    payment,
    user,
    userEmail,
    operationType,
    itemCode,
    itemName,
    itemTitle,
    game,
    playerId,
    rechargeCategory,
    qty,
    prowaveCurrency: currency,
    paynetAmountSyp,
    paynetUnitAmountSyp,
    paynetBalanceBeforeSyp,
    unitPriceUsd: saleUnitPriceUsd,
    saleUnitPriceUsd,
    providerUnitCostUsd,
    providerDiscountUsd,
    providerDiscountPercent,
    expectedProviderDebitUsd,
    exchangeRate: pricing.exchangeRate,
    marginPercent: pricing.marginPercent || 0,
    roundingStep: pricing.roundingStep || 1,
    ...financials,
    quote,
    startedAt: new Date(),
  });
};

const markPayNetReserved = (transactionId, { payment, paynetBalanceAfterSyp }) =>
  ProWaveTransaction.findByIdAndUpdate(
    transactionId,
    {
      payment,
      paynetBalanceAfterSyp,
    },
    { new: true }
  );

const markCompletedTransaction = async (
  transactionId,
  {
    prowaveInvoice,
    providerBalanceBeforeResponse,
    providerBalanceAfterResponse,
    purchaseResponse,
    codesResponse,
    invoiceProviderDebitUsd,
  }
) => {
  const transaction = await ProWaveTransaction.findById(transactionId);
  if (!transaction) return null;

  const balanceBefore = extractProWaveBalanceUsd(providerBalanceBeforeResponse);
  const balanceAfter = extractProWaveBalanceUsd(providerBalanceAfterResponse);
  const actualProviderDebitUsd =
    balanceBefore !== null && balanceAfter !== null
      ? toRoundedNumber(balanceBefore - balanceAfter)
      : null;
  const actualCostUsd = invoiceProviderDebitUsd || actualProviderDebitUsd || transaction.expectedProviderDebitUsd;
  const providerBalanceStatus = getProviderDebitStatus({
    expected: transaction.expectedProviderDebitUsd,
    actual: actualProviderDebitUsd,
  });
  const invoiceMatchStatus = invoiceProviderDebitUsd
    ? getProviderDebitStatus({
        expected: transaction.expectedProviderDebitUsd,
        actual: invoiceProviderDebitUsd,
      })
    : 'pending';
  const financials = calculateFinancials({
    paynetAmountSyp: transaction.paynetAmountSyp,
    providerCostUsd: actualCostUsd,
    exchangeRate: transaction.exchangeRate,
  });
  const resolved = resolveCompletedStatus({
    providerBalanceStatus,
    invoiceMatchStatus,
    hasInvoice: Boolean(prowaveInvoice),
    expectedProviderDebitUsd: transaction.expectedProviderDebitUsd,
    actualProviderDebitUsd,
    invoiceProviderDebitUsd,
  });

  transaction.prowaveInvoice = prowaveInvoice;
  transaction.prowaveBalanceBeforeUsd = balanceBefore;
  transaction.prowaveBalanceAfterUsd = balanceAfter;
  transaction.actualProviderDebitUsd = actualProviderDebitUsd;
  transaction.invoiceProviderDebitUsd = invoiceProviderDebitUsd || undefined;
  transaction.providerBalanceStatus = providerBalanceStatus;
  transaction.invoiceMatchStatus = invoiceMatchStatus;
  transaction.status = resolved.status;
  transaction.mismatchReason = resolved.mismatchReason;
  transaction.rawProviderBalanceBefore = providerBalanceBeforeResponse;
  transaction.rawProviderBalanceAfter = providerBalanceAfterResponse;
  transaction.rawPurchaseResponse = purchaseResponse;
  transaction.rawCodesResponse = codesResponse;
  transaction.completedAt = new Date();
  Object.assign(transaction, financials);

  return transaction.save();
};

const markFailedTransaction = async (
  transactionId,
  {
    failureStage,
    failureReason,
    error,
    refunded = false,
    paynetRefundedSyp,
    providerBalanceBeforeResponse,
    providerBalanceAfterResponse,
  }
) => {
  if (!transactionId) return null;

  const update = {
    status: refunded ? 'refunded' : 'failed',
    failureStage,
    failureReason,
    mismatchReason: failureReason || '',
    failedAt: new Date(),
  };

  if (refunded) {
    update.paynetRefundedSyp = paynetRefundedSyp;
    update.paynetRefundedAt = new Date();
  }

  if (error !== undefined) update.rawPurchaseResponse = error;
  if (providerBalanceBeforeResponse !== undefined) {
    update.rawProviderBalanceBefore = providerBalanceBeforeResponse;
  }
  if (providerBalanceAfterResponse !== undefined) {
    update.rawProviderBalanceAfter = providerBalanceAfterResponse;
  }

  return ProWaveTransaction.findByIdAndUpdate(transactionId, update, { new: true });
};

const buildTransactionFilter = (query = {}) => {
  const filter = {};

  if (query.status) filter.status = query.status;
  if (query.operationType) filter.operationType = query.operationType;
  if (query.invoiceMatchStatus) filter.invoiceMatchStatus = query.invoiceMatchStatus;
  if (query.providerBalanceStatus) filter.providerBalanceStatus = query.providerBalanceStatus;

  if (query.fromDate || query.toDate || query.date) {
    const from = query.date || query.fromDate;
    const to = query.date || query.toDate;
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = new Date(`${from}T00:00:00.000Z`);
    if (to) filter.createdAt.$lte = new Date(`${to}T23:59:59.999Z`);
  }

  if (query.search) {
    const search = new RegExp(String(query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [
      { userEmail: search },
      { itemCode: search },
      { itemTitle: search },
      { game: search },
      { playerId: search },
      { rechargeCategory: search },
      { prowaveInvoice: search },
      { prowaveRequestName: search },
      { mismatchReason: search },
    ];
  }

  return filter;
};

const getPagination = (query = {}) => {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(Math.max(1, Number(query.limit) || 20), 100);
  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
};

const getReconciliationReport = async (query = {}) => {
  const filter = buildTransactionFilter(query);
  const { page, limit, skip } = getPagination(query);

  const [transactions, total, totals] = await Promise.all([
    ProWaveTransaction.find(filter)
      .populate('user', 'name email')
      .populate('payment', 'status amount calculatedAmount createdAt')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ProWaveTransaction.countDocuments(filter),
    ProWaveTransaction.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          saleAmountUsd: {
            $sum: {
              $multiply: [
                { $ifNull: ['$saleUnitPriceUsd', '$unitPriceUsd'] },
                { $ifNull: ['$qty', 1] },
              ],
            },
          },
          providerDiscountUsd: {
            $sum: {
              $multiply: [
                { $ifNull: ['$providerDiscountUsd', 0] },
                { $ifNull: ['$qty', 1] },
              ],
            },
          },
          paynetAmountSyp: { $sum: '$paynetAmountSyp' },
          expectedProviderDebitUsd: { $sum: '$expectedProviderDebitUsd' },
          actualProviderDebitUsd: { $sum: { $ifNull: ['$actualProviderDebitUsd', 0] } },
          expectedCostSyp: { $sum: '$expectedCostSyp' },
          actualCostSyp: { $sum: '$actualCostSyp' },
          profitSyp: { $sum: '$profitSyp' },
          mismatches: {
            $sum: { $cond: [{ $eq: ['$status', 'mismatch'] }, 1, 0] },
          },
          failed: {
            $sum: { $cond: [{ $in: ['$status', ['failed', 'refunded']] }, 1, 0] },
          },
        },
      },
    ]),
  ]);

  return {
    transactions,
    summary: totals[0] || {
      count: 0,
      saleAmountUsd: 0,
      providerDiscountUsd: 0,
      paynetAmountSyp: 0,
      expectedProviderDebitUsd: 0,
      actualProviderDebitUsd: 0,
      expectedCostSyp: 0,
      actualCostSyp: 0,
      profitSyp: 0,
      mismatches: 0,
      failed: 0,
    },
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
};

const reconcileTransactionsWithInvoices = async (providerInvoicesResponse) => {
  const invoices = extractProviderInvoices(providerInvoicesResponse);
  const invoiceByName = new Map(
    invoices
      .map((invoice) => [String(getInvoiceName(invoice) || ''), invoice])
      .filter(([name]) => Boolean(name))
  );

  const transactions = await ProWaveTransaction.find({
    prowaveInvoice: { $exists: true, $ne: '' },
    status: { $in: ['pending', 'completed', 'mismatch'] },
  }).limit(1000);

  let matched = 0;
  let missing = 0;
  let mismatched = 0;

  for (const transaction of transactions) {
    const invoice = invoiceByName.get(String(transaction.prowaveInvoice || ''));

    if (!invoice) {
      transaction.invoiceMatchStatus = 'missing';
      transaction.status = 'mismatch';
      transaction.mismatchReason = buildMismatchReason({
        providerBalanceStatus: transaction.providerBalanceStatus,
        invoiceMatchStatus: 'missing',
        expectedProviderDebitUsd: transaction.expectedProviderDebitUsd,
        actualProviderDebitUsd: transaction.actualProviderDebitUsd,
        hasInvoice: Boolean(transaction.prowaveInvoice),
      });
      missing += 1;
      await transaction.save();
      continue;
    }

    const invoiceProviderDebitUsd = getInvoiceAmountUsd(invoice);
    const invoiceMatchStatus = getProviderDebitStatus({
      expected: transaction.expectedProviderDebitUsd,
      actual: invoiceProviderDebitUsd,
    });
    const financials = calculateFinancials({
      paynetAmountSyp: transaction.paynetAmountSyp,
      providerCostUsd: invoiceProviderDebitUsd || transaction.actualProviderDebitUsd || transaction.expectedProviderDebitUsd,
      exchangeRate: transaction.exchangeRate,
    });
    const resolved = resolveCompletedStatus({
      providerBalanceStatus: transaction.providerBalanceStatus,
      invoiceMatchStatus,
      hasInvoice: true,
      expectedProviderDebitUsd: transaction.expectedProviderDebitUsd,
      actualProviderDebitUsd: transaction.actualProviderDebitUsd,
      invoiceProviderDebitUsd,
    });

    transaction.invoiceProviderDebitUsd = invoiceProviderDebitUsd || undefined;
    transaction.invoiceMatchStatus = invoiceMatchStatus;
    transaction.status = resolved.status;
    transaction.mismatchReason = resolved.mismatchReason;
    transaction.rawInvoice = invoice;
    Object.assign(transaction, financials);
    await transaction.save();

    if (invoiceMatchStatus === 'matched') matched += 1;
    if (invoiceMatchStatus === 'mismatch') mismatched += 1;
  }

  return {
    providerInvoices: invoices.length,
    scannedTransactions: transactions.length,
    matched,
    missing,
    mismatched,
  };
};

module.exports = {
  calculateFinancials,
  createPendingTransaction,
  extractProWaveBalanceUsd,
  extractProviderInvoices,
  getInvoiceAmountUsd,
  getReconciliationReport,
  markCompletedTransaction,
  markFailedTransaction,
  markPayNetReserved,
  reconcileTransactionsWithInvoices,
};
