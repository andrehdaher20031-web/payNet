const {
  DEFAULT_FROM_CURRENCY,
  DEFAULT_PROVIDER,
  DEFAULT_TO_CURRENCY,
  getExchangeRateConfig,
  listExchangeRateHistory,
  updateExchangeRateConfig,
} = require('../services/exchangeRate.service');

const getProviderPair = (provider = DEFAULT_PROVIDER) => ({
  provider,
  fromCurrency: DEFAULT_FROM_CURRENCY,
  toCurrency: DEFAULT_TO_CURRENCY,
});

const sendExchangeRateError = (res, error, fallback) => {
  res.status(error.status || 500).json({
    success: false,
    message: error.message || fallback,
  });
};

const getExchangeRateForProvider = (provider) => async (req, res) => {
  try {
    const data = await getExchangeRateConfig(getProviderPair(provider));

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error(`Failed to get ${provider} exchange rate:`, error);
    sendExchangeRateError(res, error, 'تعذر جلب سعر الصرف');
  }
};

const updateExchangeRateForProvider = (provider) => async (req, res) => {
  try {
    const data = await updateExchangeRateConfig({
      ...getProviderPair(provider),
      rate: req.body.rate,
      marginPercent: req.body.marginPercent,
      roundingStep: req.body.roundingStep,
      note: req.body.note,
      updatedBy: req.user?.id,
    });

    res.json({
      success: true,
      message: 'تم تحديث سعر الصرف بنجاح',
      data,
    });
  } catch (error) {
    console.error(`Failed to update ${provider} exchange rate:`, error);
    sendExchangeRateError(res, error, 'تعذر تحديث سعر الصرف');
  }
};

const getExchangeRateHistoryForProvider = (provider) => async (req, res) => {
  try {
    const data = await listExchangeRateHistory({
      ...getProviderPair(provider),
      limit: req.query.limit,
    });

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error(`Failed to get ${provider} exchange rate history:`, error);
    sendExchangeRateError(res, error, 'تعذر جلب سجل سعر الصرف');
  }
};

exports.getProWaveExchangeRate = getExchangeRateForProvider('prowave');
exports.updateProWaveExchangeRate = updateExchangeRateForProvider('prowave');
exports.getProWaveExchangeRateHistory = getExchangeRateHistoryForProvider('prowave');

exports.getAlesoExchangeRate = getExchangeRateForProvider('aleso');
exports.updateAlesoExchangeRate = updateExchangeRateForProvider('aleso');
exports.getAlesoExchangeRateHistory = getExchangeRateHistoryForProvider('aleso');
