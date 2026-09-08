const axios = require('axios');

const DEFAULT_ALESO_BASE_URL = 'https://api.alesostore.com';

const normalizeBaseUrl = (value) =>
  String(value || DEFAULT_ALESO_BASE_URL).replace(/\/+$/, '');

const ALESO_BASE_URL = normalizeBaseUrl(process.env.ALESO_BASE_URL);
const ALESO_API_TIMEOUT_MS = Number(process.env.ALESO_API_TIMEOUT_MS) || 30000;

const alesoApi = axios.create({
  baseURL: ALESO_BASE_URL,
  timeout: ALESO_API_TIMEOUT_MS,
});

const assertAlesoConfigured = () => {
  if (!process.env.ALESO_API_TOKEN) {
    const error = new Error('Aleso API token is missing');
    error.status = 500;
    throw error;
  }
};

const getAlesoHeaders = () => {
  assertAlesoConfigured();

  return {
    'api-token': process.env.ALESO_API_TOKEN,
  };
};

const requestAleso = ({ method = 'GET', url, params, data } = {}) =>
  alesoApi.request({
    method,
    url,
    params,
    data,
    headers: getAlesoHeaders(),
  });

const getAlesoProfile = () =>
  requestAleso({
    url: '/client/api/profile',
  });

const getAlesoProducts = ({ products_id, base } = {}) =>
  requestAleso({
    url: '/client/api/products',
    params: {
      ...(products_id ? { products_id } : {}),
      ...(base ? { base } : {}),
    },
  });

const getAlesoContent = (categoryId = 0) =>
  requestAleso({
    url: `/client/api/content/${categoryId}`,
  });

const createAlesoOrder = ({ productId, qty, orderUuid, params = {} } = {}) =>
  requestAleso({
    url: `/client/api/newOrder/${productId}/params`,
    params: {
      qty,
      ...params,
      order_uuid: orderUuid,
    },
  });

const checkAlesoOrders = ({ orders, uuid = false } = {}) =>
  requestAleso({
    url: '/client/api/check',
    params: {
      orders,
      ...(uuid ? { uuid: 1 } : {}),
    },
  });

const isAlesoAxiosError = (error) => {
  const requestBaseUrl = String(error.config?.baseURL || '');
  const responseBaseUrl = String(error.response?.config?.baseURL || '');

  return (
    requestBaseUrl.includes('alesostore') ||
    responseBaseUrl.includes('alesostore')
  );
};

module.exports = {
  ALESO_BASE_URL,
  checkAlesoOrders,
  createAlesoOrder,
  getAlesoContent,
  getAlesoProducts,
  getAlesoProfile,
  isAlesoAxiosError,
};
