const axios = require('axios');
const { parse } = require('lossless-json');

const ALRAGHEB_BASE_URL = 'https://api.alragheb-store.com';

const alraghebError = (code, message, status = 502) =>
  Object.assign(new Error(message), { code, status });

const isCatalogEnabled = () =>
  !['0', 'false', 'off', 'no'].includes(
    String(process.env.ALRAGHEB_CATALOG_ENABLED || '').trim().toLowerCase()
  );

const request = async (path, params, financial = false, timeout = 20000) => {
  if (!financial && !isCatalogEnabled()) {
    throw Object.assign(alraghebError('ALRAGHEB_DISABLED', 'خدمة تطبيقات الدردشة متوقفة مؤقتًا', 503), { requestOutcome: 'not_sent' });
  }
  const token = process.env.ALRAGHEB_API_TOKEN;
  if (!token) {
    throw Object.assign(alraghebError('ALRAGHEB_NOT_CONFIGURED', 'خدمة تطبيقات الدردشة غير مهيأة', 503), { requestOutcome: 'not_sent' });
  }

  let response;
  try {
    response = await axios.get(path, {
      baseURL: ALRAGHEB_BASE_URL,
      timeout,
      maxRedirects: 0,
      maxContentLength: 8 * 1024 * 1024,
      headers: { Accept: 'application/json', 'api-token': token, ...(financial ? { 'Cache-Control': 'no-store', Pragma: 'no-cache' } : {}) },
      params,
      transformResponse: [(text) => parse(text, undefined, { parseNumber: (value) => value })],
    });
  } catch (error) {
    // Axios errors include the authentication header; never forward or log them.
    const timeout = ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code);
    throw Object.assign(alraghebError(
      timeout ? 'ALRAGHEB_TIMEOUT' : 'ALRAGHEB_UNAVAILABLE',
      timeout ? 'انتهت مهلة الاتصال بالمزوّد' : 'تعذر الاتصال بمزوّد تطبيقات الدردشة',
      timeout ? 504 : 502
    ), { requestOutcome: ['ENOTFOUND', 'ECONNREFUSED'].includes(error.code) ? 'not_sent' : 'unknown' });
  }

  const data = response.data;
  if (!data || typeof data !== 'object' ||
      (!Array.isArray(data) && (data.error || data.code ||
        (data.status && !['ok', 'success'].includes(String(data.status).toLowerCase()))))) {
    // A top-level error is not proof that the provider never accepted a financial request.
    throw Object.assign(alraghebError('ALRAGHEB_PROVIDER_ERROR', 'تعذر جلب البيانات من المزوّد'), { requestOutcome: 'unknown' });
  }
  return data;
};

const getProfile = () => request('/client/api/profile');
// Operational balance checks remain available while catalog browsing is stopped.
const getOperationalProfile = () => request('/client/api/profile', undefined, true);
const getProducts = () => request('/client/api/products');
const getContent = (categoryId) => {
  if (!Number.isSafeInteger(categoryId) || categoryId < 0) {
    throw alraghebError('INVALID_CATEGORY', 'معرّف التصنيف غير صالح', 400);
  }
  // Large categories (notably ZNET) can exceed the order request's 20 second budget.
  // This is a read-only request; financial submission and status checks keep their existing timeout.
  return request(`/client/api/content/${categoryId}`, undefined, false, 45000);
};

const getContentIndex = (categoryId) => {
  if (!Number.isSafeInteger(categoryId) || categoryId < 0) {
    throw alraghebError('INVALID_CATEGORY', 'معرّف التصنيف غير صالح', 400);
  }
  // The provider supports base=1 on content: category metadata plus product IDs/names.
  // Fetch full prices once from /products instead of repeatedly in every category.
  return request(`/client/api/content/${categoryId}`, { base: 1 }, false, 45000);
};

const getProduct = async (id) => {
  if (!Number.isSafeInteger(id) || id < 1) throw alraghebError('INVALID_PRODUCT', 'معرّف المنتج غير صالح', 400);
  const data = await request('/client/api/products', { products_id: String(id) });
  if (!Array.isArray(data) || data.length !== 1 || Number(data[0].id) !== id) {
    throw alraghebError('ALRAGHEB_INVALID_RESPONSE', 'تعذر التحقق من سعر المنتج الحالي');
  }
  return data[0];
};
const newOrder = (id, qty, params, uuid) => request(`/client/api/newOrder/${id}/params`, { ...params, qty, order_uuid: uuid }, true);
const checkOrder = (uuid) => request('/client/api/check', { orders: `[${uuid}]`, uuid: 1 }, true);

module.exports = { ALRAGHEB_BASE_URL, alraghebError, getProfile, getOperationalProfile, getProducts, getContent, getContentIndex, getProduct, newOrder, checkOrder, isCatalogEnabled };
