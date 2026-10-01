const axios = require('axios');
const { parse } = require('lossless-json');

const ALRAGHEB_BASE_URL = 'https://api.alragheb-store.com';

const alraghebError = (code, message, status = 502) =>
  Object.assign(new Error(message), { code, status });

const isCatalogEnabled = () =>
  !['0', 'false', 'off', 'no'].includes(
    String(process.env.ALRAGHEB_CATALOG_ENABLED || '').trim().toLowerCase()
  );

const request = async (path, params, financial = false) => {
  if (!financial && !isCatalogEnabled()) {
    throw alraghebError('ALRAGHEB_DISABLED', 'خدمة تطبيقات الدردشة متوقفة مؤقتًا', 503);
  }
  const token = process.env.ALRAGHEB_API_TOKEN;
  if (!token) {
    throw alraghebError('ALRAGHEB_NOT_CONFIGURED', 'خدمة تطبيقات الدردشة غير مهيأة', 503);
  }

  let response;
  try {
    response = await axios.get(path, {
      baseURL: ALRAGHEB_BASE_URL,
      timeout: 20000,
      maxRedirects: 0,
      maxContentLength: 8 * 1024 * 1024,
      headers: { Accept: 'application/json', 'api-token': token, ...(financial ? { 'Cache-Control': 'no-store', Pragma: 'no-cache' } : {}) },
      params,
      transformResponse: [(text) => parse(text, undefined, { parseNumber: (value) => value })],
    });
  } catch (error) {
    // Axios errors include the authentication header; never forward or log them.
    const timeout = ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code);
    throw alraghebError(
      timeout ? 'ALRAGHEB_TIMEOUT' : 'ALRAGHEB_UNAVAILABLE',
      timeout ? 'انتهت مهلة الاتصال بالمزوّد' : 'تعذر الاتصال بمزوّد تطبيقات الدردشة',
      timeout ? 504 : 502
    );
  }

  const data = response.data;
  if (!data || typeof data !== 'object' ||
      (!Array.isArray(data) && (data.error || data.code ||
        (data.status && !['ok', 'success'].includes(String(data.status).toLowerCase()))))) {
    throw alraghebError('ALRAGHEB_PROVIDER_ERROR', 'تعذر جلب البيانات من المزوّد');
  }
  return data;
};

const getProfile = () => request('/client/api/profile');
const getProducts = () => request('/client/api/products');
const getContent = (categoryId) => {
  if (!Number.isSafeInteger(categoryId) || categoryId < 0) {
    throw alraghebError('INVALID_CATEGORY', 'معرّف التصنيف غير صالح', 400);
  }
  return request(`/client/api/content/${categoryId}`);
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

module.exports = { ALRAGHEB_BASE_URL, alraghebError, getProfile, getProducts, getContent, getProduct, newOrder, checkOrder, isCatalogEnabled };
