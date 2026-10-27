const mongoose = require('mongoose');
const { createHash, randomUUID } = require('node:crypto');
const Transaction = require('../models/ProWaveTransaction');
const Quote = require('../models/ProWavePriceQuote');
const Payment = require('../models/Payment');
const User = require('../models/User');
const provider = require('./proWaveProvider.service');
const protocol = require('./proWaveProtocol.service');
const ledger = require('./proWaveLedger.service');
const { cache } = require('./cache.service');
const { recordPaymentStats } = require('./dailyStats.service');
const { normalizeDirectTopUpGame } = require('../config/prowaveDirectTopupCatalog');
const { Decimal } = protocol;
const ACTIVE = ['pending', 'unknown', 'manual_review', 'delivery_pending'];
const FINAL = ['completed', 'failed', 'refunded'];
const fail = (code, message, status = 400) => { const error = new Error(message); error.code = code; error.status = status; throw error; };
const objectId = (value) => mongoose.Types.ObjectId.isValid(value);
const scalar = (value, max = 256) => typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
function normalizeInput(input, operationType) {
  const clientRequestId = scalar(input.client_request_id || input.clientRequestId || input.idempotency_key || input.idempotencyKey, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(clientRequestId)) fail('REQUEST_ID_REQUIRED', 'معرّف محاولة الشراء مطلوب؛ حدّث الصفحة وأعد المحاولة');
  const currency = scalar(input.currency || 'USD', 3).toUpperCase();
  if (currency !== 'USD') fail('UNSUPPORTED_CURRENCY', 'الشراء من هذا المزوّد يدعم الدولار فقط');
  const itemCode = scalar(input.item_code || input.itemCode || input.recharge_category || input.rechargeCategory);
  if (!itemCode) fail('ITEM_REQUIRED', 'معرّف المنتج مطلوب');
  const quantity = operationType === 'direct_topup' ? 1 : Number(input.qty ?? input.quantity ?? 1);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) fail('INVALID_QUANTITY', 'الكمية يجب أن تكون عدداً صحيحاً بين 1 و100');
  const game = operationType === 'direct_topup' ? normalizeDirectTopUpGame(scalar(input.game, 64)) : '';
  const playerId = scalar(input.player_id || input.playerId, 128);
  if (operationType === 'direct_topup' && (!game || !playerId)) fail('PLAYER_REQUIRED', 'اللعبة ومعرّف اللاعب مطلوبان');
  const customerContact = scalar(input.customer_contact || input.customer_identifier || playerId, 128);
  const quoteId = scalar(input.quote_id || input.quoteId, 24);
  if (quoteId && !objectId(quoteId)) fail('INVALID_QUOTE', 'معرّف عرض السعر غير صالح');
  const fingerprintData = { operationType, itemCode, quantity, currency, game, playerId, customerContact };
  const displayedAmount = input.paynet_amount_syp ?? input.amount_syp;
  if (displayedAmount !== undefined && (!Number.isSafeInteger(Number(displayedAmount)) || Number(displayedAmount) <= 0)) fail('INVALID_PRICE', 'السعر المعروض غير صالح');
  return { ...fingerprintData, clientRequestId, quoteId, displayedAmount: displayedAmount === undefined ? undefined : Number(displayedAmount), requestFingerprint: createHash('sha256').update(JSON.stringify(fingerprintData)).digest('hex'), paymentType: input.paymentType === 'credit' ? 'credit' : 'cash' };
}
function createOrderService({ client = provider, readContext = (input) => require('../controllers/proWave').getProWavePurchaseContext(input), purchasingGate = (name) => require('./providerOperations.service').assertPurchasingAllowed(name), onChange = async () => {} } = {}) {
  let scheduler;
  let running = false;
  async function changed() {
    await Promise.all(['payments:', 'report:', 'users:', 'balance:'].map((prefix) => cache.delByPrefix(prefix)));
    await onChange();
  }
  async function atomic(task) {
    const session = await mongoose.startSession();
    try { return await session.withTransaction(() => task(session)); } finally { await session.endSession(); }
  }
  async function owned(id, { actorId, isAdmin = false } = {}) {
    if (!objectId(id)) fail('INVALID_TRANSACTION', 'معرّف العملية غير صالح');
    const transaction = await Transaction.findById(id);
    if (!transaction) fail('TRANSACTION_NOT_FOUND', 'العملية غير موجودة', 404);
    if (!isAdmin && String(transaction.user) !== String(actorId)) fail('FORBIDDEN', 'لا يمكنك الوصول إلى هذه العملية', 403);
    return transaction;
  }
  async function view(transaction, duplicate = false, admin = false) {
    const [payment, user] = await Promise.all([Payment.findById(transaction.payment).lean(), User.findById(transaction.user).select('balance').lean()]);
    const request = { name: transaction.prowaveRequestName, request_name: transaction.prowaveRequestName, recharge_status: transaction.rechargeStatus, sales_invoice: transaction.prowaveInvoice, game: transaction.game, player_id: transaction.playerId, recharge_category: transaction.rechargeCategory };
    return { transaction_id: String(transaction._id), payment_id: transaction.payment, status: transaction.status, stage: transaction.stage,
      payment_status: payment?.status, customer_status: payment?.status, payment: admin ? payment : protocol.customerPayment(payment),
      transaction: admin ? transaction : protocol.customerTransaction(transaction), request, ...request,
      invoice_name: transaction.prowaveInvoice, digital_codes: transaction.digitalCodes || payment?.extra?.digital_codes || [],
      paynet_currency: 'SYP', paynet_amount_syp: transaction.paynetAmountSyp, newBalance: user?.balance,
      duplicate, needs_review: transaction.internalReviewStatus === 'needs_review',
      warning: ['unknown', 'manual_review'].includes(transaction.status) ? 'نتيجة المزوّد قيد التحقق؛ احتفظ بمعرّف المحاولة ولا تنشئ شراءً جديداً' : undefined };
  }
  async function findAttempt(userId, key, operationType) {
    const filter = { user: userId, clientRequestId: key, ...(operationType ? { operationType } : {}) };
    const rows = await Transaction.find(filter).limit(2);
    if (!rows.length) fail('TRANSACTION_NOT_FOUND', 'محاولة الشراء غير موجودة', 404);
    if (rows.length > 1) fail('OPERATION_TYPE_REQUIRED', 'حدّد نوع العملية لاستعادة محاولة الشراء', 409);
    return view(rows[0], true);
  }
  async function reserve(userId, input, context) {
    const pricing = context.pricing;
    if (!pricing || !Number.isSafeInteger(pricing.totalAmountSyp) || pricing.totalAmountSyp <= 0) fail('INVALID_PRICE', 'تعذر حساب السعر');
    if (input.displayedAmount !== undefined && input.displayedAmount !== pricing.totalAmountSyp) fail('PRICE_CHANGED', 'تغير السعر؛ حدّث المنتج وأعد المحاولة', 409);
    return atomic(async (session) => {
      const config = await require('../models/ProWaveProductConfig').findOne({ itemCode: context.itemCode || input.itemCode, operationType: input.operationType, currency: 'USD' }).session(session).lean();
      if (config?.purchaseEnabled === false) fail('PRODUCT_DISABLED', 'شراء هذا المنتج متوقف مؤقتاً', 503);
      if ((config?.revision || 0) !== (pricing.productConfigRevision || 0)) fail('PRICE_CHANGED', 'تغيرت إعدادات سعر المنتج؛ حدّثه وأعد المحاولة', 409);
      let quote;
      if (input.quoteId) {
        quote = await Quote.findOne({ _id: input.quoteId, user: userId, itemCode: input.itemCode, currency: input.currency, qty: input.quantity, usedAt: { $exists: false }, expiresAt: { $gt: new Date() } }).session(session);
        if (!quote) fail('QUOTE_EXPIRED', 'عرض السعر منتهي أو مستخدم؛ حدّث المنتج', 409);
        if (!new Decimal(quote.unitPriceUsd).eq(pricing.saleUnitPriceUsd) || !new Decimal(quote.providerUnitCostUsd ?? quote.unitPriceUsd).eq(pricing.providerUnitCostUsd) || quote.totalAmountSyp !== pricing.totalAmountSyp || (quote.productConfigRevision || 0) !== (pricing.productConfigRevision || 0)) fail('PRICE_CHANGED', 'تغير السعر؛ حدّث المنتج وأعد المحاولة', 409);
      }
      const user = await User.findOneAndUpdate({ _id: userId, balance: { $gte: pricing.totalAmountSyp } }, { $inc: { balance: -pricing.totalAmountSyp } }, { new: true, session });
      if (!user) fail('INSUFFICIENT_BALANCE', 'الرصيد غير كافٍ', 400);
      const now = new Date();
      const [payment] = await Payment.create([{ user: userId, landline: input.playerId || input.customerContact || user.number || user.email,
        company: context.itemTitle || input.itemCode, speed: context.itemCode || input.itemCode, email: user.email,
        amount: pricing.totalAmountSyp, calculatedAmount: pricing.totalAmountSyp, paymentType: input.paymentType,
        status: 'قيد التنفيذ', note: 'بانتظار نتيجة المزوّد', extra: {
          provider: 'prowave', operation_type: input.operationType, prowave_operation_type: input.operationType,
          item_code: context.itemCode || input.itemCode, item_title: context.itemTitle, qty: input.quantity, currency: 'USD',
          game: input.game, player_id: input.playerId, client_request_id: input.clientRequestId,
          paynet_currency: 'SYP', paynet_amount_syp: pricing.totalAmountSyp, paynet_unit_amount_syp: pricing.unitAmountSyp,
        } }], { session });
      const expectedDebit = new Decimal(pricing.providerUnitCostUsd).mul(input.quantity);
      const [transaction] = await Transaction.create([{ payment: payment._id, user: userId, userEmail: user.email,
        clientRequestId: input.clientRequestId, requestFingerprint: input.requestFingerprint, operationType: input.operationType,
        itemCode: context.itemCode || input.itemCode, itemTitle: context.itemTitle, game: input.game, playerId: input.playerId,
        rechargeCategory: context.itemCode || input.itemCode, qty: input.quantity, prowaveCurrency: 'USD', paynetCurrency: 'SYP',
        paynetAmountSyp: pricing.totalAmountSyp, paynetUnitAmountSyp: pricing.unitAmountSyp,
        paynetBalanceBeforeSyp: new Decimal(user.balance).plus(pricing.totalAmountSyp).toNumber(), paynetBalanceAfterSyp: user.balance,
        unitPriceUsd: pricing.saleUnitPriceUsd, saleUnitPriceUsd: pricing.saleUnitPriceUsd, providerUnitCostUsd: pricing.providerUnitCostUsd,
        providerDiscountUsd: pricing.providerDiscountUsd, providerDiscountPercent: pricing.providerDiscountPercent,
        expectedProviderDebitUsd: expectedDebit.toNumber(), exchangeRate: pricing.exchangeRate, marginPercent: pricing.marginPercent,
        roundingStep: pricing.roundingStep, expectedCostSyp: expectedDebit.mul(pricing.exchangeRate).toNumber(),
        actualCostSyp: null, profitSyp: null, profitPercent: null,
        estimatedProfitSyp: new Decimal(pricing.totalAmountSyp).minus(expectedDebit.mul(pricing.exchangeRate)).toNumber(),
        quote: quote?._id, productConfigRevision: pricing.productConfigRevision || 0,
        providerRequest: input.operationType === 'direct_topup' ? { game: input.game, player_id: input.playerId, recharge_category: context.itemCode || input.itemCode, currency: 'USD' } : { item_code: input.itemCode, qty: input.quantity, currency: 'USD', immediate_code_view: true },
        status: 'pending', stage: 'reserved', reservedAt: now, startedAt: now, nextCheckAt: now,
        deliveryStatus: input.operationType === 'direct_topup' ? 'not_applicable' : 'pending',
      }], { session });
      payment.extra = { ...payment.extra, prowave_transaction_id: transaction._id };
      await payment.save({ session });
      if (quote) { quote.usedAt = now; quote.payment = payment._id; await quote.save({ session }); }
      await recordPaymentStats(payment, 1, session);
      return transaction;
    });
  }
  async function purchase(userId, body, operationType) {
    const input = normalizeInput(body, operationType);
    const existing = await Transaction.findOne({ user: userId, operationType, clientRequestId: input.clientRequestId });
    if (existing) {
      if (!existing.requestFingerprint) fail('HISTORICAL_REQUEST_REVIEW', 'هذه محاولة قديمة؛ استعد نتيجتها أو راجع الإدارة قبل أي شراء جديد', 409);
      if (existing.requestFingerprint !== input.requestFingerprint) fail('REQUEST_ID_CONFLICT', 'معرّف المحاولة مستخدم لطلب مختلف', 409);
      return view(existing, true);
    }
    await purchasingGate('prowave');
    const context = await readContext(input);
    await purchasingGate('prowave');
    let transaction;
    try { transaction = await reserve(userId, input, context); }
    catch (error) {
      if (error.code !== 11000) throw error;
      transaction = await Transaction.findOne({ user: userId, operationType, clientRequestId: input.clientRequestId });
      if (!transaction || transaction.requestFingerprint !== input.requestFingerprint) fail('REQUEST_ID_CONFLICT', 'معرّف المحاولة مستخدم لطلب مختلف', 409);
      return view(transaction, true);
    }
    transaction = await sendReserved(transaction._id);
    await changed();
    return view(transaction);
  }
  async function releaseLease(id, owner) { await Transaction.updateOne({ _id: id, leaseOwner: owner }, { $unset: { leaseOwner: 1, leaseUntil: 1 } }); }
  async function uncertain(id, code, raw, owner) {
    const settings = await require('./providerOperations.service').getSettings('prowave');
    const transaction = await Transaction.findById(id);
    if (!transaction || FINAL.includes(transaction.status)) return transaction;
    const aged = Date.now() - new Date(transaction.startedAt || transaction.createdAt).getTime() >= (settings.reviewAfterMinutes || 30) * 60000;
    const updated = await Transaction.findOneAndUpdate({ _id: id, status: { $in: ACTIVE }, ...(owner ? { leaseOwner: owner } : {}) }, {
      $set: { status: aged ? 'manual_review' : 'unknown', stage: 'checking', lastErrorCode: code, internalReviewStatus: aged ? 'needs_review' : 'pending',
        internalReviewReason: aged ? 'نتيجة المزوّد غير مؤكدة؛ تحتاج مراجعة بشرية' : '', rawPurchaseResponse: raw,
        nextCheckAt: new Date(Date.now() + (aged ? 15 * 60000 : 60000)) }, $inc: { __v: 1 },
      $push: { errorHistory: { $each: [{ at: new Date(), code, phase: 'checking', outcome: 'unknown' }], $slice: -30 } },
    }, { new: true });
    return updated || transaction;
  }
  async function settle(id, inspected, raw, owner, { forceFailure = false, audit, expectedRevision } = {}) {
    return atomic(async (session) => {
      const transaction = await Transaction.findById(id).session(session);
      if (audit && transaction && FINAL.includes(transaction.status)) fail('ALREADY_SETTLED', 'تغيرت تسوية العملية؛ حدّث الصفحة', 409);
      if (!transaction || FINAL.includes(transaction.status) || owner && transaction.leaseOwner !== owner) return transaction;
      if (expectedRevision !== undefined && transaction.__v !== expectedRevision) fail('REVISION_CONFLICT', 'تغيرت العملية؛ حدّث الصفحة وأعد المحاولة', 409);
      const payment = await Payment.findById(transaction.payment).session(session);
      if (!payment) fail('PAYMENT_MISSING', 'البيان المالي غير موجود', 500);
      const previousPayment = payment.toObject();
      transaction.rawPurchaseResponse = raw;
      transaction.lastCheckedAt = new Date();
      if (inspected.requestName) transaction.prowaveRequestName = inspected.requestName;
      if (inspected.invoice) transaction.prowaveInvoice = inspected.invoice;
      if (inspected.requestName || inspected.invoice) transaction.requestBinding = `${transaction.operationType}:${inspected.requestName || inspected.invoice}`;
      if (inspected.providerCostUsd !== null && inspected.providerCostUsd !== undefined) transaction.invoiceProviderDebitUsd = inspected.providerCostUsd;
      if (inspected.digitalCodes?.length) transaction.digitalCodes = inspected.digitalCodes;
      if (transaction.operationType === 'digital_card' && inspected.digitalCodes?.length < transaction.qty) inspected.completed = false;
      if (inspected.rechargeStatus) transaction.rechargeStatus = inspected.rechargeStatus;
      const failed = forceFailure || inspected.definitiveRejection;
      if (failed) {
        if (!transaction.paynetRefundedAt && (transaction.reservedAt || transaction.paynetBalanceAfterSyp !== undefined && transaction.paynetBalanceAfterSyp !== null)) {
          const user = await User.findByIdAndUpdate(transaction.user, { $inc: { balance: transaction.paynetAmountSyp } }, { new: true, session });
          if (!user) fail('REFUND_USER_MISSING', 'تعذر إرجاع الرصيد', 500);
          transaction.paynetRefundedAt = new Date(); transaction.paynetRefundedSyp = transaction.paynetAmountSyp;
        }
        transaction.status = transaction.paynetRefundedAt ? 'refunded' : 'failed'; transaction.stage = 'settled'; transaction.failedAt = new Date();
        transaction.failureReason = inspected.rejectionReason || 'المزوّد أكد رفض العملية';
        transaction.profitSyp = 0; transaction.actualCostSyp = 0; transaction.profitPercent = 0; transaction.internalReviewStatus = 'clear';
        payment.status = 'غير مسددة'; payment.note = transaction.failureReason;
      } else if (inspected.completed) {
        transaction.status = 'completed'; transaction.stage = 'settled'; transaction.completedAt ||= new Date();
        transaction.deliveryStatus = transaction.operationType === 'digital_card' ? 'delivered' : 'not_applicable';
        transaction.digitalCodes = inspected.digitalCodes || transaction.digitalCodes;
        const cost = inspected.providerCostUsd ?? transaction.invoiceProviderDebitUsd;
        transaction.invoiceProviderDebitUsd = cost;
        transaction.invoiceMatchStatus = cost === null || cost === undefined ? 'pending' : Math.abs(cost - transaction.expectedProviderDebitUsd) <= 0.01 ? 'matched' : 'mismatch';
        if (cost !== null && cost !== undefined) {
          transaction.actualCostSyp = new Decimal(cost).mul(transaction.exchangeRate).toNumber();
          transaction.profitSyp = new Decimal(transaction.paynetAmountSyp).minus(transaction.actualCostSyp).toNumber();
          transaction.profitPercent = new Decimal(transaction.profitSyp).div(transaction.paynetAmountSyp).mul(100).toNumber();
        }
        transaction.internalReviewStatus = transaction.invoiceMatchStatus === 'mismatch' || !transaction.prowaveInvoice ? 'needs_review' : 'pending';
        transaction.mismatchReason = transaction.invoiceMatchStatus === 'mismatch' ? 'تكلفة فاتورة المزوّد لا تطابق لقطة سعر الشراء' : !transaction.prowaveInvoice ? 'لا توجد فاتورة للمزوّد' : '';
        transaction.internalReviewReason = transaction.mismatchReason;
        payment.status = 'تم التسديد'; payment.note = '';
      } else {
        transaction.status = transaction.operationType === 'digital_card' && inspected.invoice ? 'delivery_pending' : 'pending';
        transaction.stage = transaction.status === 'delivery_pending' ? 'delivering' : 'checking';
        transaction.nextCheckAt = new Date(Date.now() + 30000);
        payment.status = 'قيد التنفيذ'; payment.note = transaction.status === 'delivery_pending' ? 'بانتظار تسليم رموز المنتج' : 'بانتظار نتيجة المزوّد';
      }
      if (FINAL.includes(transaction.status)) transaction.nextCheckAt = undefined;
      payment.extra = { ...payment.extra, prowave_request_name: transaction.prowaveRequestName, name: transaction.prowaveRequestName,
        sales_invoice: transaction.prowaveInvoice, prowave_sales_invoice: transaction.prowaveInvoice, recharge_status: transaction.rechargeStatus,
        digital_codes: transaction.digitalCodes || [], paynet_refunded_syp: transaction.paynetRefundedSyp,
        completed_at: transaction.completedAt?.toISOString(), failed_at: transaction.failedAt?.toISOString() };
      transaction.increment();
      await transaction.save({ session }); await payment.save({ session });
      if (audit) await require('./providerOperations.service').recordAudit({ ...audit, after: protocol.customerTransaction(transaction) }, session);
      if (previousPayment.status !== payment.status) { await recordPaymentStats(previousPayment, -1, session); await recordPaymentStats(payment, 1, session); }
      return transaction;
    });
  }
  async function sendReserved(id) {
    const owner = randomUUID();
    const transaction = await Transaction.findOneAndUpdate({ _id: id, status: 'pending', stage: 'reserved', $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date() } }] },
      { $set: { stage: 'sending', leaseOwner: owner, leaseUntil: new Date(Date.now() + 120000), nextCheckAt: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } }, { new: true });
    if (!transaction) return Transaction.findById(id);
    let response;
    try {
      response = await client.purchase(transaction.operationType, transaction.providerRequest);
      const inspected = protocol.inspect(response, transaction.operationType);
      if (!inspected.accepted && !inspected.definitiveRejection) return await uncertain(id, 'PROVIDER_RESPONSE_UNCONFIRMED', response, owner);
      const references = { rawPurchaseResponse: response, stage: 'checking' };
      if (inspected.requestName) references.prowaveRequestName = inspected.requestName;
      if (inspected.invoice) references.prowaveInvoice = inspected.invoice;
      if (inspected.requestName || inspected.invoice) references.requestBinding = `${transaction.operationType}:${inspected.requestName || inspected.invoice}`;
      await Transaction.updateOne({ _id: id, leaseOwner: owner, status: { $in: ACTIVE } }, { $set: references });
      return await settle(id, inspected, response, owner);
    } catch (error) {
      const inspected = protocol.inspect(error.response?.data || {}, transaction.operationType);
      if (inspected.definitiveRejection) return await settle(id, inspected, error.response.data, owner);
      return await uncertain(id, 'PROVIDER_OUTCOME_UNKNOWN', response || error.response?.data || { code: error.code || 'NETWORK_ERROR' }, owner);
    } finally { await releaseLease(id, owner); }
  }
  async function checkTransaction(id, access = {}) {
    const existing = await owned(id, access);
    // Completed top-ups can still contain a historical premature completion; only verified final provider states are terminal.
    if (FINAL.includes(existing.status) && !(existing.status === 'completed' && existing.operationType === 'direct_topup' && existing.prowaveRequestName && !protocol.inspect({ recharge_status: existing.rechargeStatus }, 'direct_topup').completed)) return view(existing, false, access.isAdmin);
    if (existing.stage === 'reserved' && existing.providerRequest) return view(await sendReserved(id), false, access.isAdmin);
    const owner = randomUUID();
    const transaction = await Transaction.findOneAndUpdate({ _id: id, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: null }, { leaseUntil: { $lte: new Date() } }] },
      { $set: { leaseOwner: owner, leaseUntil: new Date(Date.now() + 120000), lastCheckedAt: new Date() }, $inc: { checkAttempts: 1 } }, { new: true });
    if (!transaction) return view(existing, false, access.isAdmin);
    try {
      if (transaction.operationType === 'direct_topup' && transaction.prowaveRequestName) {
        const response = await client.check(transaction.prowaveRequestName);
        const inspected = protocol.inspect(response, 'direct_topup');
        if (inspected.requestName && inspected.requestName !== transaction.prowaveRequestName) return view(await uncertain(id, 'PROVIDER_REFERENCE_MISMATCH', {}, owner), false, access.isAdmin);
        if (!inspected.requestName || !inspected.accepted) return view(await uncertain(id, 'PROVIDER_STATUS_UNCONFIRMED', response, owner), false, access.isAdmin);
        if (transaction.status === 'completed') {
          // Repair stale historical states without permitting refunds of previously completed records.
          await Transaction.updateOne({ _id: id, status: 'completed', leaseOwner: owner }, { $set: { rechargeStatus: inspected.rechargeStatus, rawDirectTopupStatusResponse: response,
            internalReviewStatus: inspected.completed ? 'pending' : 'needs_review', internalReviewReason: inspected.completed ? '' : 'حالة العملية التاريخية لا تطابق حالة المزوّد' } });
        } else await settle(id, inspected, response, owner);
      } else if (transaction.operationType === 'digital_card' && transaction.prowaveInvoice) {
        const response = await client.getCodes(transaction.prowaveInvoice, transaction.itemCode);
        const foundCodes = protocol.codes(response);
        if (foundCodes.length) await settle(id, { ...protocol.inspect(response, 'digital_card'), completed: true, digitalCodes: foundCodes, invoice: transaction.prowaveInvoice }, response, owner);
        else await Transaction.updateOne({ _id: id, leaseOwner: owner }, { $set: { status: 'delivery_pending', stage: 'delivering', nextCheckAt: new Date(Date.now() + 60000), lastErrorCode: 'CODES_PENDING' } });
      } else await uncertain(id, 'PROVIDER_REFERENCE_UNAVAILABLE', {}, owner);
    } catch (error) {
      await Transaction.updateOne({ _id: id, leaseOwner: owner }, { $set: { lastErrorCode: error.code || 'STATUS_CHECK_FAILED', nextCheckAt: new Date(Date.now() + 60000) },
        $push: { errorHistory: { $each: [{ at: new Date(), code: error.code || 'STATUS_CHECK_FAILED', phase: 'checking', outcome: 'unknown' }], $slice: -30 } } });
    } finally { await releaseLease(id, owner); }
    await changed();
    return view(await Transaction.findById(id), false, access.isAdmin);
  }
  async function resolveTransaction(id, { action, note, actorId, providerEvidence, revision } = {}) {
    const transaction = await owned(id, { actorId, isAdmin: true });
    if (typeof note !== 'string' || note.trim().length < 10 || !protocol.plain(providerEvidence) || !Object.keys(providerEvidence).length) fail('EVIDENCE_REQUIRED', 'يلزم سبب مفصل ودليل من المزوّد');
    if (!['resolve_failed', 'resolve_completed', 'acknowledge_review'].includes(action)) fail('INVALID_ACTION', 'إجراء المراجعة غير صالح');
    if (!Number.isSafeInteger(revision) || revision !== transaction.__v) fail('REVISION_CONFLICT', 'تغيرت العملية؛ حدّث الصفحة وأعد المحاولة', 409);
    const checkedAt = new Date(providerEvidence.checkedAt).getTime();
    if (!['provider_api', 'provider_support'].includes(providerEvidence.source) || !Number.isFinite(checkedAt) || checkedAt > Date.now() + 300000 || checkedAt < Date.now() - 86400000) fail('EVIDENCE_INVALID', 'الدليل يجب أن يتضمن مصدر المزوّد ووقت تحقق حديث');
    const audit = { provider: 'prowave', actor: actorId, action, target: String(id), note: note.trim(), before: protocol.customerTransaction(transaction), evidence: providerEvidence };
    let updated;
    if (action === 'acknowledge_review') {
      updated = await atomic(async (session) => {
        const result = await Transaction.findOneAndUpdate({ _id: id, __v: revision, internalReviewStatus: 'needs_review' }, { $set: { internalReviewStatus: 'clear', reviewResolvedAt: new Date(), reviewResolvedBy: actorId, reviewResolutionNote: note.trim() }, $inc: { __v: 1 } }, { new: true, session });
        if (!result) fail('REVIEW_NOT_PENDING', 'تغيرت العملية أو لا توجد مراجعة معلّقة', 409);
        await require('./providerOperations.service').recordAudit({ ...audit, after: protocol.customerTransaction(result) }, session);
        return result;
      });
    } else {
      if (!ACTIVE.includes(transaction.status)) fail('ALREADY_SETTLED', 'العملية محسومة ولا تقبل تغيير التسوية', 409);
      const reference = scalar(providerEvidence.request_name || providerEvidence.invoice_name || providerEvidence.providerReference);
      const support = providerEvidence.source === 'provider_support' && transaction.status === 'manual_review' && scalar(providerEvidence.ticketReference, 128).length >= 3;
      if (!reference && !support) fail('REFERENCE_REQUIRED', 'مرجع الطلب أو فاتورة المزوّد مطلوب');
      if (providerEvidence.confirmedOutcome !== (action === 'resolve_failed' ? 'rejected' : 'completed')) fail('EVIDENCE_CONFLICT', 'النتيجة المؤكدة في الدليل لا تطابق الإجراء');
      const owner = randomUUID();
      const locked = await Transaction.findOneAndUpdate({ _id: id, __v: revision, $or: [{ leaseUntil: { $lte: new Date() } }, { leaseUntil: { $exists: false } }, { leaseUntil: null }] }, { $set: { leaseOwner: owner, leaseUntil: new Date(Date.now() + 120000) } }, { new: true });
      if (!locked) fail('TRANSACTION_BUSY', 'تجري مراجعة العملية حالياً؛ حدّث الصفحة', 409);
      try {
        let response, inspected;
        if (reference) {
          try {
            response = transaction.operationType === 'direct_topup' ? await client.check(reference) : await client.getCodes(reference, transaction.itemCode);
            inspected = protocol.inspect(response, transaction.operationType);
          } catch (error) { if (!support) throw error; }
        }
        if (action === 'resolve_failed' && inspected?.completed || action === 'resolve_completed' && inspected?.definitiveRejection) fail('EVIDENCE_CONFLICT', 'حالة المزوّد الحالية تناقض دليل المراجعة', 409);
        if (inspected?.accepted) {
          if (transaction.operationType === 'direct_topup' && inspected.requestName !== reference) fail('REFERENCE_MISMATCH', 'مرجع المزوّد لا يطابق العملية', 409);
          const request = inspected.request;
          if (transaction.operationType === 'direct_topup' && (String(request.player_id || request.playerId || '') !== transaction.playerId || request.game && normalizeDirectTopUpGame(request.game) !== transaction.game || request.recharge_category && request.recharge_category !== transaction.rechargeCategory)) fail('REQUEST_MISMATCH', 'بيانات المزوّد لا تطابق اللاعب والمنتج', 409);
          if (action === 'resolve_failed' && !inspected.definitiveRejection || action === 'resolve_completed' && !inspected.completed) fail('OUTCOME_UNCONFIRMED', 'المزوّد لم يؤكد النتيجة المطلوبة؛ الرصيد يبقى محجوزاً', 409);
        } else {
          if (!support) fail('OUTCOME_UNCONFIRMED', 'المزوّد لم يؤكد نتيجة العملية', 409);
          if (action === 'resolve_completed' && transaction.operationType === 'digital_card') fail('DELIVERY_UNCONFIRMED', 'يجب استلام رموز المنتج قبل إكماله', 409);
          inspected = { definitiveRejection: action === 'resolve_failed', completed: action === 'resolve_completed', rejectionReason: note.trim(), digitalCodes: [], providerCostUsd: null };
          response = { reviewed_support_ticket: providerEvidence.ticketReference };
        }
        if (transaction.operationType === 'digital_card' && inspected.completed && transaction.prowaveInvoice !== reference) fail('REFERENCE_MISMATCH', 'الفاتورة يجب أن تكون مرتبطة مسبقاً بالعملية', 409);
        updated = await settle(id, { ...inspected, invoice: inspected.invoice || (transaction.operationType === 'digital_card' ? transaction.prowaveInvoice : '') }, response, owner, { audit, expectedRevision: revision });
      } finally { await releaseLease(id, owner); }
    }
    await changed(); return view(updated, false, true);
  }
  async function tick({ limit = 25 } = {}) {
    if (running) return { skipped: true, count: 0 };
    running = true;
    const operations = require('./providerOperations.service');
    await operations.recordWorkerHeartbeat('prowave', { state: 'started', leaseMs: 180000 });
    let processed = 0;
    try {
      const now = new Date();
      const settings = await operations.getSettings('prowave');
      await Transaction.updateMany({ status: { $in: ['pending', 'unknown', 'delivery_pending'] }, startedAt: { $lt: new Date(now.getTime() - (settings.reviewAfterMinutes || 30) * 60000) } },
        { $set: { internalReviewStatus: 'needs_review', internalReviewReason: 'عملية معلّقة تجاوزت مهلة المراجعة' } });
      const rows = await Transaction.find({ $and: [
        { $or: [{ status: { $in: ACTIVE } }, { status: 'completed', operationType: 'direct_topup', rechargeStatus: { $nin: ['Completed', 'completed', 'Complete', 'Success', 'success', 'Done', 'Paid'] } }] },
        { $or: [{ nextCheckAt: { $lte: now } }, { nextCheckAt: { $exists: false } }] },
        { $or: [{ leaseUntil: { $lte: now } }, { leaseUntil: { $exists: false } }, { leaseUntil: null }] },
      ] }).sort({ nextCheckAt: 1, createdAt: 1 }).limit(Math.min(100, Math.max(1, Number(limit) || 25)));
      const concurrency = Math.max(1, Math.min(10, settings.workerConcurrency || 3));
      for (let index = 0; index < rows.length; index += concurrency) {
        await Promise.all(rows.slice(index, index + concurrency).map(async (row) => { await checkTransaction(row._id, { isAdmin: true }); processed++; }));
      }
      await operations.recordWorkerHeartbeat('prowave', { state: 'succeeded', processed });
      return { skipped: false, count: processed };
    } catch (error) { await operations.recordWorkerHeartbeat('prowave', { state: 'failed', processed, errorCode: error.code || 'WORKER_ERROR' }); throw error; }
    finally { running = false; }
  }
  function start() {
    if (scheduler) return;
    const interval = process.env.PROWAVE_DIRECT_TOPUP_STATUS_INTERVAL_MS === undefined ? 60000 : Number(process.env.PROWAVE_DIRECT_TOPUP_STATUS_INTERVAL_MS);
    if (!Number.isFinite(interval) || interval <= 0) return;
    scheduler = setInterval(() => tick().catch((error) => console.error('[ProWave] recovery worker:', error.code || 'WORKER_ERROR')), interval);
    scheduler.unref?.(); tick().catch((error) => console.error('[ProWave] recovery worker:', error.code || 'WORKER_ERROR'));
  }
  async function readProviderBalance() {
    const amount = ledger.extractProWaveBalanceUsd(await client.getBalance());
    if (amount === null) fail('BALANCE_UNAVAILABLE', 'تعذر قراءة رصيد المزوّد', 502);
    return { amount: new Decimal(amount).toFixed(), currency: 'USD' };
  }
  return { purchase, checkTransaction, resolveTransaction, findAttempt, tick, start, readProviderBalance, view };
}
const service = createOrderService();
module.exports = { ...service, createOrderService, normalizeInput };
