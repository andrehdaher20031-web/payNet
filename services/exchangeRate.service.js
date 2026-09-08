const ExchangeRate = require('../models/ExchangeRate');
const ExchangeRateHistory = require('../models/ExchangeRateHistory');

const DEFAULT_PROVIDER = 'prowave';
const DEFAULT_FROM_CURRENCY = 'USD';
const DEFAULT_TO_CURRENCY = 'SYP';
const DEFAULT_SYP_RATE =
  Number(process.env.PROWAVE_USD_TO_SYP_RATE || process.env.USD_TO_SYP_RATE) || 135;
const DEFAULT_MARGIN_PERCENT = Number(process.env.PROWAVE_MARGIN_PERCENT) || 0;
const DEFAULT_ROUNDING_STEP = Number(process.env.PROWAVE_SYP_ROUNDING_STEP) || 1;

const normalizeProvider = (provider = DEFAULT_PROVIDER) =>
  String(provider || DEFAULT_PROVIDER).trim().toLowerCase();

const normalizeCurrency = (currency = '') => String(currency || '').trim().toUpperCase();

const normalizePair = ({
  provider = DEFAULT_PROVIDER,
  fromCurrency = DEFAULT_FROM_CURRENCY,
  toCurrency = DEFAULT_TO_CURRENCY,
} = {}) => ({
  provider: normalizeProvider(provider),
  fromCurrency: normalizeCurrency(fromCurrency || DEFAULT_FROM_CURRENCY),
  toCurrency: normalizeCurrency(toCurrency || DEFAULT_TO_CURRENCY),
});

const toPositiveNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toNonNegativeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const toPositiveInteger = (value, fallback = 1) => {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const isPositiveInteger = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
};

const getProviderEnvName = (provider = DEFAULT_PROVIDER) =>
  normalizeProvider(provider).toUpperCase().replace(/[^A-Z0-9]+/g, '_');

const getDefaultConfigValues = (provider = DEFAULT_PROVIDER) => {
  const providerEnvName = getProviderEnvName(provider);

  return {
    rate: toPositiveNumber(
      process.env[`${providerEnvName}_USD_TO_SYP_RATE`] ||
        process.env.USD_TO_SYP_RATE ||
        DEFAULT_SYP_RATE,
      135
    ),
    marginPercent: toNonNegativeNumber(
      process.env[`${providerEnvName}_MARGIN_PERCENT`] ||
        process.env.PROWAVE_MARGIN_PERCENT ||
        DEFAULT_MARGIN_PERCENT,
      0
    ),
    roundingStep: toPositiveInteger(
      process.env[`${providerEnvName}_SYP_ROUNDING_STEP`] ||
        process.env.PROWAVE_SYP_ROUNDING_STEP ||
        DEFAULT_ROUNDING_STEP,
      1
    ),
  };
};

const serializeExchangeRate = (config) => {
  const plain = typeof config?.toObject === 'function' ? config.toObject() : config;

  if (!plain) return null;

  return {
    id: plain._id?.toString?.() || plain.id,
    provider: plain.provider,
    fromCurrency: plain.fromCurrency,
    toCurrency: plain.toCurrency,
    rate: plain.rate,
    marginPercent: plain.marginPercent || 0,
    roundingStep: plain.roundingStep || 1,
    isActive: plain.isActive !== false,
    updatedBy: plain.updatedBy,
    note: plain.note || '',
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
    source: plain._id ? 'database' : plain.source || 'default',
  };
};

const ensureExchangeRateConfig = async (pair = {}) => {
  const query = normalizePair(pair);
  const defaults = getDefaultConfigValues(query.provider);

  return ExchangeRate.findOneAndUpdate(
    query,
    {
      $setOnInsert: {
        ...query,
        ...defaults,
        isActive: true,
        note: 'Initial exchange rate',
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }
  );
};

const getExchangeRateConfig = async (pair = {}) => {
  const config = await ensureExchangeRateConfig(pair);
  return serializeExchangeRate(config);
};

const assertValidPricingInput = ({ rate, marginPercent, roundingStep }) => {
  if (!toPositiveNumber(rate)) {
    const error = new Error('سعر الصرف يجب أن يكون أكبر من صفر');
    error.status = 400;
    throw error;
  }

  if (marginPercent !== undefined && !Number.isFinite(Number(marginPercent))) {
    const error = new Error('نسبة الهامش غير صالحة');
    error.status = 400;
    throw error;
  }

  if (Number(marginPercent) < 0) {
    const error = new Error('نسبة الهامش يجب ألا تكون سالبة');
    error.status = 400;
    throw error;
  }

  if (roundingStep !== undefined && !isPositiveInteger(Number(roundingStep))) {
    const error = new Error('قيمة التقريب يجب أن تكون رقما صحيحا أكبر من صفر');
    error.status = 400;
    throw error;
  }
};

const updateExchangeRateConfig = async ({
  provider = DEFAULT_PROVIDER,
  fromCurrency = DEFAULT_FROM_CURRENCY,
  toCurrency = DEFAULT_TO_CURRENCY,
  rate,
  marginPercent,
  roundingStep,
  note = '',
  updatedBy,
} = {}) => {
  assertValidPricingInput({ rate, marginPercent, roundingStep });

  const query = normalizePair({ provider, fromCurrency, toCurrency });
  const config = await ensureExchangeRateConfig(query);
  const previous = serializeExchangeRate(config);
  const nextRate = toPositiveNumber(rate);
  const nextMarginPercent = toNonNegativeNumber(marginPercent, previous.marginPercent || 0);
  const nextRoundingStep = toPositiveInteger(roundingStep, previous.roundingStep || 1);

  config.rate = nextRate;
  config.marginPercent = nextMarginPercent;
  config.roundingStep = nextRoundingStep;
  config.updatedBy = updatedBy;
  config.note = String(note || '').trim();
  config.isActive = true;

  await config.save();

  await ExchangeRateHistory.create({
    ...query,
    previousRate: previous.rate,
    newRate: nextRate,
    previousMarginPercent: previous.marginPercent || 0,
    newMarginPercent: nextMarginPercent,
    previousRoundingStep: previous.roundingStep || 1,
    newRoundingStep: nextRoundingStep,
    changedBy: updatedBy,
    note: config.note,
  });

  return serializeExchangeRate(config);
};

const roundUpToStep = (amount, step = 1) => {
  const normalizedStep = toPositiveInteger(step, 1);
  return Math.ceil(amount / normalizedStep) * normalizedStep;
};

const calculateSypPricing = ({ usdAmount, qty = 1, exchangeRateConfig } = {}) => {
  const unitPriceUsd = toPositiveNumber(usdAmount);

  if (!unitPriceUsd || !exchangeRateConfig?.rate) return null;

  const quantity = toPositiveInteger(qty, 1);
  const exchangeRate = toPositiveNumber(exchangeRateConfig.rate);
  const marginPercent = toNonNegativeNumber(exchangeRateConfig.marginPercent, 0);
  const roundingStep = toPositiveInteger(exchangeRateConfig.roundingStep, 1);
  const baseUnitAmountSyp = unitPriceUsd * exchangeRate;
  const unitAmountBeforeRoundingSyp = baseUnitAmountSyp * (1 + marginPercent / 100);
  const unitAmountSyp = roundUpToStep(unitAmountBeforeRoundingSyp, roundingStep);

  return {
    exchangeRate,
    marginPercent,
    roundingStep,
    unitPriceUsd,
    qty: quantity,
    baseUnitAmountSyp,
    unitAmountBeforeRoundingSyp,
    unitAmountSyp,
    totalAmountSyp: unitAmountSyp * quantity,
    source: exchangeRateConfig.source || 'database',
  };
};

const formatSypAmount = (amount) =>
  `${Number(amount || 0).toLocaleString('en-US')} ل.س`;

const listExchangeRateHistory = async ({
  provider = DEFAULT_PROVIDER,
  fromCurrency = DEFAULT_FROM_CURRENCY,
  toCurrency = DEFAULT_TO_CURRENCY,
  limit = 20,
} = {}) => {
  const query = normalizePair({ provider, fromCurrency, toCurrency });
  const normalizedLimit = Math.min(toPositiveInteger(limit, 20), 100);

  return ExchangeRateHistory.find(query)
    .populate('changedBy', 'name email role')
    .sort({ createdAt: -1 })
    .limit(normalizedLimit)
    .lean();
};

module.exports = {
  DEFAULT_PROVIDER,
  DEFAULT_FROM_CURRENCY,
  DEFAULT_TO_CURRENCY,
  calculateSypPricing,
  formatSypAmount,
  getExchangeRateConfig,
  listExchangeRateHistory,
  serializeExchangeRate,
  updateExchangeRateConfig,
};
