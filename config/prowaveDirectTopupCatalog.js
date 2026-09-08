const directTopUpItem = ({
  game,
  rechargeCategory,
  itemCode = '',
  providerItemCode = itemCode,
  title = rechargeCategory,
  titleAr = title,
  description = '',
  salePriceUsd,
  providerCostUsd = salePriceUsd,
  sortOrder,
}) => ({
  game,
  item_code: itemCode || providerItemCode,
  provider_item_code: providerItemCode || itemCode,
  recharge_category: itemCode || providerItemCode || rechargeCategory,
  legacy_recharge_category: rechargeCategory,
  title,
  title_ar: titleAr,
  description,
  sale_price_usd: salePriceUsd,
  provider_cost_usd: providerCostUsd,
  currency: 'USD',
  sort_order: sortOrder,
});

const DEFAULT_DIRECT_TOPUP_CATALOG = [
  directTopUpItem({
    game: 'pubg',
    rechargeCategory: 'PUBG 60 UC',
    providerItemCode: 'PUBG Card 1$ (60UC)',
    titleAr: 'شحن PUBG 60 UC مباشر',
    description: 'Direct PUBG Mobile top-up by player ID.',
    salePriceUsd: 1.25,
    providerCostUsd: 1.07,
    sortOrder: 10,
  }),
  directTopUpItem({
    game: 'pubg',
    rechargeCategory: 'PUBG 325 UC',
    providerItemCode: 'PUBG Card 5$ (325UC)',
    titleAr: 'شحن PUBG 325 UC مباشر',
    description: 'Direct PUBG Mobile top-up by player ID.',
    salePriceUsd: 5.3,
    sortOrder: 20,
  }),
  directTopUpItem({
    game: 'pubg',
    rechargeCategory: 'PUBG 660 UC',
    providerItemCode: 'PUBG Card 10$ (660UC)',
    titleAr: 'شحن PUBG 660 UC مباشر',
    description: 'Direct PUBG Mobile top-up by player ID.',
    salePriceUsd: 10.53,
    sortOrder: 30,
  }),
  directTopUpItem({
    game: 'pubg',
    rechargeCategory: 'PUBG 1800 UC',
    providerItemCode: 'PUBG Card 25$ (1800UC)',
    titleAr: 'شحن PUBG 1800 UC مباشر',
    description: 'Direct PUBG Mobile top-up by player ID.',
    salePriceUsd: 26,
    providerCostUsd: 25.53,
    sortOrder: 40,
  }),
  directTopUpItem({
    game: 'pubg',
    rechargeCategory: 'PUBG 3850 UC',
    providerItemCode: 'PUBG Card 50$ (3850UC)',
    titleAr: 'شحن PUBG 3850 UC مباشر',
    description: 'Direct PUBG Mobile top-up by player ID.',
    salePriceUsd: 52,
    providerCostUsd: 51.76,
    sortOrder: 50,
  }),
  directTopUpItem({
    game: 'pubg',
    rechargeCategory: 'PUBG 8100 UC',
    providerItemCode: 'PUBG Card 100$ (8100UC)',
    titleAr: 'شحن PUBG 8100 UC مباشر',
    description: 'Direct PUBG Mobile top-up by player ID.',
    salePriceUsd: 103.86,
    sortOrder: 60,
  }),
  directTopUpItem({
    game: 'pubg',
    rechargeCategory: 'PUBG First Purchase Package',
    title: 'PUBG First Purchase Package',
    titleAr: 'حزمة الشراء الأولى PUBG مباشر',
    description: 'Direct PUBG Mobile top-up by player ID.',
    salePriceUsd: 1.61,
    sortOrder: 70,
  }),
  directTopUpItem({
    game: 'pubg',
    rechargeCategory: 'PUBG Weapon Upgrade Package',
    title: 'PUBG Weapon Upgrade Package',
    titleAr: 'حزمة ترقية الأسلحة PUBG مباشر',
    description: 'Direct PUBG Mobile top-up by player ID.',
    salePriceUsd: 3.96,
    sortOrder: 80,
  }),
  directTopUpItem({
    game: 'pubg',
    rechargeCategory: 'PUBG Mythic Emblem Package',
    title: 'PUBG Mythic Emblem Package',
    titleAr: 'حزمة الشعار الخرافية PUBG مباشر',
    description: 'Direct PUBG Mobile top-up by player ID.',
    salePriceUsd: 6.68,
    sortOrder: 90,
  }),
  directTopUpItem({
    game: 'pubg',
    rechargeCategory: 'PUBG Prime Plus 1 Month',
    title: 'PUBG Prime Plus 1 Month',
    titleAr: 'برايم بلس PUBG لمدة شهر مباشر',
    description: 'Direct PUBG Mobile top-up by player ID.',
    salePriceUsd: 11.51,
    sortOrder: 100,
  }),
  directTopUpItem({
    game: 'free_fire',
    rechargeCategory: 'Free Fire 110 + 10 Diamond',
    providerItemCode: 'Free Fire Card 100 + 10 Diamonds',
    titleAr: 'شحن Free Fire 110 + 10 Diamond مباشر',
    description: 'Direct Free Fire top-up by player ID.',
    salePriceUsd: 1.1,
    sortOrder: 110,
  }),
  directTopUpItem({
    game: 'free_fire',
    rechargeCategory: 'Free Fire 210 + 21 Diamond',
    providerItemCode: 'Free Fire Card 210 + 21 Diamonds',
    titleAr: 'شحن Free Fire 210 + 21 Diamond مباشر',
    description: 'Direct Free Fire top-up by player ID.',
    salePriceUsd: 2.19,
    sortOrder: 120,
  }),
  directTopUpItem({
    game: 'free_fire',
    rechargeCategory: 'Free Fire 530 + 53 Diamond',
    providerItemCode: 'Free Fire Card 530 + 53 Diamonds',
    titleAr: 'شحن Free Fire 530 + 53 Diamond مباشر',
    description: 'Direct Free Fire top-up by player ID.',
    salePriceUsd: 5.47,
    sortOrder: 130,
  }),
  directTopUpItem({
    game: 'free_fire',
    rechargeCategory: 'Free Fire 1080 + 108 Diamond',
    providerItemCode: 'Free Fire Card 1080 + 108 Diamonds',
    titleAr: 'شحن Free Fire 1080 + 108 Diamond مباشر',
    description: 'Direct Free Fire top-up by player ID.',
    salePriceUsd: 10.88,
    sortOrder: 140,
  }),
  directTopUpItem({
    game: 'free_fire',
    rechargeCategory: 'Free Fire 2200 + 220 Diamond',
    providerItemCode: 'Free Fire Card 2200 + 220 Diamonds',
    titleAr: 'شحن Free Fire 2200 + 220 Diamond مباشر',
    description: 'Direct Free Fire top-up by player ID.',
    salePriceUsd: 21.8,
    sortOrder: 150,
  }),
  directTopUpItem({
    game: 'free_fire',
    rechargeCategory: 'Free Fire Weekly Membership',
    title: 'Free Fire Weekly Membership',
    titleAr: 'عضوية أسبوعية Free Fire مباشر',
    description: 'Direct Free Fire top-up by player ID.',
    salePriceUsd: 2.78,
    sortOrder: 160,
  }),
  directTopUpItem({
    game: 'free_fire',
    rechargeCategory: 'Free Fire Monthly Membership',
    title: 'Free Fire Monthly Membership',
    titleAr: 'عضوية شهرية Free Fire مباشر',
    description: 'Direct Free Fire top-up by player ID.',
    salePriceUsd: 13.07,
    sortOrder: 170,
  }),
  directTopUpItem({
    game: 'free_fire',
    rechargeCategory: 'Free Fire Booyah Pass',
    title: 'Free Fire Booyah Pass',
    titleAr: 'تصريح بوياه Free Fire مباشر',
    description: 'Direct Free Fire top-up by player ID.',
    salePriceUsd: 3.89,
    sortOrder: 180,
  }),
  directTopUpItem({
    game: 'free_fire',
    rechargeCategory: 'Free Fire Level Up Pass 6',
    title: 'Free Fire Level Up Pass 6',
    titleAr: 'ترقية مستوى Free Fire 6 مباشر',
    description: 'Direct Free Fire top-up by player ID.',
    salePriceUsd: 0.5,
    sortOrder: 190,
  }),
  directTopUpItem({
    game: 'free_fire',
    rechargeCategory: 'Free Fire Level Up Pass 10',
    title: 'Free Fire Level Up Pass 10',
    titleAr: 'ترقية مستوى Free Fire 10 مباشر',
    description: 'Direct Free Fire top-up by player ID.',
    salePriceUsd: 0.87,
    sortOrder: 200,
  }),
  directTopUpItem({
    game: 'free_fire',
    rechargeCategory: 'Free Fire Level Up Pass 15',
    title: 'Free Fire Level Up Pass 15',
    titleAr: 'ترقية مستوى Free Fire 15 مباشر',
    description: 'Direct Free Fire top-up by player ID.',
    salePriceUsd: 0.87,
    sortOrder: 210,
  }),
  directTopUpItem({
    game: 'free_fire',
    rechargeCategory: 'Free Fire Level Up Pass 20',
    title: 'Free Fire Level Up Pass 20',
    titleAr: 'ترقية مستوى Free Fire 20 مباشر',
    description: 'Direct Free Fire top-up by player ID.',
    salePriceUsd: 0.87,
    sortOrder: 220,
  }),
  directTopUpItem({
    game: 'free_fire',
    rechargeCategory: 'Free Fire Level Up Pass 25',
    title: 'Free Fire Level Up Pass 25',
    titleAr: 'ترقية مستوى Free Fire 25 مباشر',
    description: 'Direct Free Fire top-up by player ID.',
    salePriceUsd: 0.87,
    sortOrder: 230,
  }),
  directTopUpItem({
    game: 'free_fire',
    rechargeCategory: 'Free Fire Level Up Pass 30',
    title: 'Free Fire Level Up Pass 30',
    titleAr: 'ترقية مستوى Free Fire 30 مباشر',
    description: 'Direct Free Fire top-up by player ID.',
    salePriceUsd: 1.34,
    providerCostUsd: 0.87,
    sortOrder: 240,
  }),
];

const GAME_ALIASES = new Map(
  [
    ['pubg', 'pubg'],
    ['pubg_mobile', 'pubg'],
    ['pubg mobile', 'pubg'],
    ['free_fire', 'free_fire'],
    ['free fire', 'free_fire'],
    ['freefire', 'free_fire'],
  ].map(([key, value]) => [key, value])
);

const getFirstPresent = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== '');

const toNumber = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeText = (value) => String(value || '').trim();

const normalizeDirectTopUpGame = (game) => {
  const normalized = normalizeText(game).toLowerCase().replace(/-/g, '_');
  return GAME_ALIASES.get(normalized) || normalized;
};

const normalizeCatalogItem = (item = {}) => {
  const game = normalizeDirectTopUpGame(item.game);
  const legacyRechargeCategory = normalizeText(
    getFirstPresent(item.legacy_recharge_category, item.recharge_category, item.rechargeCategory)
  );
  const configuredItemCode = normalizeText(
    getFirstPresent(
      item.provider_item_code,
      item.providerItemCode,
      item.item_code,
      item.itemCode,
      item.code
    )
  );
  const rechargeCategory = configuredItemCode || legacyRechargeCategory;
  const providerCostUsd = toNumber(
    getFirstPresent(
      item.provider_cost_usd,
      item.providerCostUsd,
      item.prowave_unit_cost_usd,
      item.prowaveUnitCostUsd,
      item.cost_usd,
      item.costUsd,
      item.price_usd,
      item.priceUsd,
      item.price
    ),
    0
  );
  const configuredSalePriceUsd = toNumber(
    getFirstPresent(
      item.sale_price_usd,
      item.salePriceUsd,
      item.customer_sale_price_usd,
      item.customerSalePriceUsd,
      item.price_without_discount,
      item.priceWithoutDiscount,
      item.price_usd,
      item.priceUsd,
      item.price
    ),
    providerCostUsd
  );
  const salePriceUsd = Math.max(configuredSalePriceUsd, providerCostUsd);

  if (!game || !rechargeCategory || salePriceUsd <= 0 || providerCostUsd <= 0) return null;

  return {
    game,
    item_code: rechargeCategory,
    provider_item_code: configuredItemCode,
    recharge_category: rechargeCategory,
    legacy_recharge_category: legacyRechargeCategory,
    title: normalizeText(getFirstPresent(item.title, item.name, legacyRechargeCategory, rechargeCategory)),
    title_ar: normalizeText(
      getFirstPresent(item.title_ar, item.titleAr, item.title, legacyRechargeCategory, rechargeCategory)
    ),
    description: normalizeText(item.description),
    price_usd: salePriceUsd,
    sale_price_usd: salePriceUsd,
    provider_cost_usd: providerCostUsd,
    currency: normalizeText(item.currency || 'USD').toUpperCase(),
    sort_order: toNumber(getFirstPresent(item.sort_order, item.sortOrder), 1000),
    raw: item,
  };
};

const parseCatalogFromEnv = () => {
  if (!process.env.PROWAVE_DIRECT_TOPUP_CATALOG_JSON) return null;

  try {
    const parsed = JSON.parse(process.env.PROWAVE_DIRECT_TOPUP_CATALOG_JSON);
    return Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    console.error('[ProWave] invalid PROWAVE_DIRECT_TOPUP_CATALOG_JSON:', error.message);
    return null;
  }
};

const getDirectTopUpCatalog = () => {
  const source = parseCatalogFromEnv() || DEFAULT_DIRECT_TOPUP_CATALOG;

  return source
    .map(normalizeCatalogItem)
    .filter(Boolean)
    .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title));
};

const listDirectTopUpCatalog = ({ game } = {}) => {
  const normalizedGame = game ? normalizeDirectTopUpGame(game) : '';
  const catalog = getDirectTopUpCatalog();

  return normalizedGame
    ? catalog.filter((item) => item.game === normalizedGame)
    : catalog;
};

const findDirectTopUpCatalogItem = ({ game, recharge_category, item_code }) => {
  const normalizedGame = normalizeDirectTopUpGame(game);
  const normalizedCategory = normalizeText(item_code || recharge_category).toLowerCase();

  return getDirectTopUpCatalog().find(
    (item) =>
      item.game === normalizedGame &&
      [
        item.item_code,
        item.provider_item_code,
        item.recharge_category,
        item.legacy_recharge_category,
      ]
        .filter(Boolean)
        .map((value) => value.toLowerCase())
        .includes(normalizedCategory)
  );
};

module.exports = {
  findDirectTopUpCatalogItem,
  getDirectTopUpCatalog,
  listDirectTopUpCatalog,
  normalizeDirectTopUpGame,
};
