const axios = require('axios');
const protocol = require('./proWaveProtocol.service');
const client = axios.create({ baseURL: process.env.PROWAVE_BASE_URL || 'https://pro-wave.net/api/method', timeout: Number(process.env.PROWAVE_TIMEOUT_MS) || 30000 });
function headers() {
  if (!process.env.PROWAVE_API_KEY || !process.env.PROWAVE_API_SECRET) {
    const error = new Error('إعدادات الاتصال بالمزوّد غير متوفرة'); error.status = 503; error.code = 'PROVIDER_NOT_CONFIGURED'; throw error;
  }
  return { Authorization: `token ${process.env.PROWAVE_API_KEY}:${process.env.PROWAVE_API_SECRET}` };
}
const post = async (url, data) => (await client.post(url, data, { headers: headers() })).data;
const get = async (url, params) => (await client.get(url, { params, headers: headers() })).data;
module.exports = {
  purchase: (operationType, data) => post(operationType === 'direct_topup' ? '/create_direct_topup_request' : '/purchase_digital_card', data),
  check: (name) => post('/get_direct_topup_request', { name }),
  getCodes: (invoice, itemCode) => get('/get_codes', { invoice_name: invoice, item_code: itemCode }),
  listInvoices: (limit, offset) => get('/get_invoices', { limit, offset }),
  getBalance: () => get('/get_balance'),
  inspect: protocol.inspect,
};
