const provider = require('./alraghebApi');
const { cache } = require('./cache.service');

const ROOT_ID = 1;
const CACHE_KEY = 'alragheb:chat-catalog:v3';
const CACHE_SECONDS = 120;
const STALE_SECONDS = 60 * 60;
const { alraghebError } = provider;

const integer = (value) => {
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

const normalizeQuantity = (value) => {
  if (value === null) return { mode: 'fixed', min: 1, max: 1, defaultQty: 1 };
  if (Array.isArray(value) && value.length) {
    const values = [...new Set(value.map(integer))];
    if (values.every(Boolean)) return { mode: 'choices', values, defaultQty: values[0] };
  } else if (value && typeof value === 'object') {
    const min = integer(value.min);
    const max = integer(value.max);
    if (min && max && min <= max) {
      return { mode: min === max ? 'fixed' : 'range', min, max, defaultQty: min };
    }
  }
  return { mode: 'unsupported', defaultQty: null };
};

const imageUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value, provider.ALRAGHEB_BASE_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname === '/') return '';
    return url.toString();
  } catch {
    return '';
  }
};

const finitePrice = (value) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? String(value) : null;
};

const malformed = () => alraghebError('ALRAGHEB_INVALID_RESPONSE', 'بيانات كتالوج المزوّد غير مكتملة');

const normalizeProduct = (raw, categoryId) => {
  const id = integer(raw?.id);
  if (!id || typeof raw.name !== 'string' || !raw.name.trim() || integer(raw.parent_id) !== categoryId) {
    throw malformed();
  }
  return {
    id,
    name: raw.name.trim(),
    category_id: categoryId,
    category_name: typeof raw.category_name === 'string' ? raw.category_name : '',
    product_type: ['amount', 'package', 'specificPackage'].includes(raw.product_type) ? raw.product_type : 'unknown',
    available: raw.available === true,
    params: Array.isArray(raw.params) ? raw.params.filter((item) => typeof item === 'string' && item.trim()) : [],
    quantity_rules: normalizeQuantity(raw.qty_values),
    image_url: imageUrl(raw.category_img),
    provider_price: finitePrice(raw.price),
    provider_base_price: finitePrice(raw.base_price),
  };
};

const serializeProduct = (product, admin = false) => {
  const { provider_price, provider_base_price, ...customerProduct } = product;
  return {
    ...customerProduct,
    provider: 'alragheb',
    purchasable: false,
    purchase_status: 'not_configured',
    ...(admin ? { provider_price, provider_base_price, provider_currency: 'SYP' } : {}),
  };
};

const descendants = (catalog, id) => {
  const ids = new Set([id]);
  const queue = [id];
  for (let index = 0; index < queue.length; index += 1) {
    for (const category of catalog.categories) {
      if (category.parent_id === queue[index] && !ids.has(category.id)) {
        ids.add(category.id);
        queue.push(category.id);
      }
    }
  }
  return ids;
};

const categorySummary = (catalog, category) => {
  const ids = descendants(catalog, category.id);
  const products = catalog.products.filter((product) => ids.has(product.category_id));
  return {
    ...category,
    product_count: products.length,
    direct_product_count: products.filter((product) => product.category_id === category.id).length,
    available_count: products.filter((product) => product.available).length,
  };
};

const normalizeSearch = (text) => String(text || '').normalize('NFKC').toLowerCase()
  .replace(/[ًٌٍَُِّْـ]/g, '').replace(/[\s_-]+/g, ' ').trim();

const parseQuery = (query = {}) => {
  for (const key of ['category_id', 'search', 'available', 'page', 'limit', 'products_id', 'scope']) {
    if (query[key] !== undefined && typeof query[key] !== 'string') {
      throw alraghebError('INVALID_QUERY', 'معاملات البحث غير صالحة', 400);
    }
  }
  const page = query.page === undefined ? 1 : integer(query.page);
  const limit = query.limit === undefined ? 24 : integer(query.limit);
  const categoryId = query.category_id ? integer(query.category_id) : null;
  if (!page || !limit || limit > 100 || (query.category_id && !categoryId) ||
      (query.available && !['true', 'false'].includes(query.available)) ||
      (query.scope && !['direct', 'all'].includes(query.scope)) || (query.search || '').length > 120) {
    throw alraghebError('INVALID_QUERY', 'معاملات البحث أو التصفح غير صالحة', 400);
  }
  const productIds = query.products_id ? query.products_id.split(',').map(integer) : [];
  if (productIds.length > 100 || productIds.some((id) => !id)) {
    throw alraghebError('INVALID_PRODUCTS', 'معرّفات المنتجات غير صالحة', 400);
  }
  return { page, limit, categoryId, search: normalizeSearch(query.search), available: query.available, productIds, scope: query.scope };
};

const selectProducts = (catalog, query, { admin = false, categoryId = null, recursive = true } = {}) => {
  const options = parseQuery(query);
  const selectedCategory = categoryId || options.categoryId;
  if (selectedCategory && !catalog.categories.some((category) => category.id === selectedCategory)) {
    throw alraghebError('CATEGORY_NOT_FOUND', 'التصنيف غير موجود ضمن تطبيقات الدردشة', 404);
  }
  const ids = selectedCategory
    ? recursive ? descendants(catalog, selectedCategory) : new Set([selectedCategory])
    : null;
  const inCategory = catalog.products.filter((product) => !ids || ids.has(product.category_id));
  const selected = inCategory.filter((product) => {
    const text = normalizeSearch(`${product.id} ${product.name} ${product.category_name}`);
    return (!options.search || text.includes(options.search)) &&
      (!options.available || product.available === (options.available === 'true')) &&
      (!options.productIds.length || options.productIds.includes(product.id));
  });
  const totalPages = Math.max(1, Math.ceil(selected.length / options.limit));
  const page = Math.min(options.page, totalPages);
  return {
    data: selected.slice((page - 1) * options.limit, page * options.limit).map((product) => serializeProduct(product, admin)),
    meta: {
      total: selected.length,
      category_total: inCategory.length,
      catalog_total: catalog.products.length,
      available_total: catalog.products.filter((product) => product.available).length,
      page,
      limit: options.limit,
      total_pages: totalPages,
      synced_at: catalog.synced_at,
      stale: Boolean(catalog.stale),
      purchase_enabled: false,
    },
  };
};

const selectContent = (catalog, categoryId, query = {}) => {
  const category = catalog.categories.find((item) => item.id === categoryId);
  if (!category) throw alraghebError('CATEGORY_NOT_FOUND', 'التصنيف غير موجود ضمن تطبيقات الدردشة', 404);
  const options = parseQuery(query);
  const result = selectProducts(catalog, query, {
    categoryId,
    recursive: Boolean(options.search) || options.scope === 'all',
  });
  const breadcrumbs = [category];
  let parent = category.parent_id;
  while (parent) {
    const item = catalog.categories.find((entry) => entry.id === parent);
    if (!item) break;
    breadcrumbs.unshift(item);
    parent = item.parent_id;
  }
  return {
    data: {
      category: categorySummary(catalog, category),
      breadcrumbs,
      categories: catalog.categories.filter((item) => item.parent_id === categoryId)
        .map((item) => categorySummary(catalog, item)),
      products: result.data,
    },
    meta: result.meta,
  };
};

const createCatalogService = ({ client = provider, storage = cache, now = Date.now } = {}) => {
  let inFlight = null;
  let nextRetryAt = 0;

  const fetchCatalog = async () => {
    const categories = new Map([[ROOT_ID, { id: ROOT_ID, name: 'تطبيقات الدردشة', parent_id: 0, image_url: '' }]]);
    const products = new Map();
    let pending = [ROOT_ID];

    // Traverse the provider's tree, including future nested categories, with bounded concurrency.
    while (pending.length) {
      const batch = pending.splice(0, 3);
      const responses = await Promise.allSettled(batch.map((id) => client.getContent(id)));
      for (let index = 0; index < batch.length; index += 1) {
        const response = responses[index];
        if (response.status === 'rejected') throw response.reason;
        const content = response.value;
        const parentId = batch[index];
        if (!Array.isArray(content?.products) || !Array.isArray(content?.categories)) throw malformed();
        for (const raw of content.products) {
          const product = normalizeProduct(raw, parentId);
          if (products.has(product.id) && products.get(product.id).category_id !== parentId) throw malformed();
          products.set(product.id, product);
        }
        for (const raw of content.categories) {
          const id = integer(raw?.id);
          if (!id || id === ROOT_ID || integer(raw.parent_id) !== parentId || typeof raw.name !== 'string' || !raw.name.trim()) throw malformed();
          if (categories.has(id)) {
            if (categories.get(id).parent_id !== parentId) throw malformed();
            continue;
          }
          categories.set(id, { id, name: raw.name.trim(), parent_id: parentId, image_url: imageUrl(raw.category_img || raw.image) });
          pending.push(id);
        }
        if (categories.size > 500 || products.size > 50000) throw malformed();
      }
    }

    const catalog = {
      categories: [...categories.values()],
      products: [...products.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar', { numeric: true }) || a.id - b.id),
      synced_at: new Date(now()).toISOString(),
    };
    await storage.set(CACHE_KEY, catalog, STALE_SECONDS);
    nextRetryAt = 0;
    return catalog;
  };

  const getCatalog = async ({ force = false } = {}) => {
    const stored = await storage.get(CACHE_KEY);
    const fresh = stored && now() - Date.parse(stored.synced_at) < CACHE_SECONDS * 1000;
    if (fresh && !force) return stored;
    if (stored && nextRetryAt > now() && !force) return { ...stored, stale: true };
    if (!inFlight) inFlight = fetchCatalog().finally(() => { inFlight = null; });
    try {
      return await inFlight;
    } catch (error) {
      nextRetryAt = now() + 30000;
      if (stored && !force) return { ...stored, stale: true };
      throw error;
    }
  };

  return { getCatalog };
};

module.exports = {
  ...createCatalogService(), ROOT_ID, createCatalogService, categorySummary,
  integer, normalizeProduct, normalizeQuantity, parseQuery, selectContent, selectProducts, serializeProduct,
};
