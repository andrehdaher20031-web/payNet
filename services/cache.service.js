const DEFAULT_TTL_SECONDS = 60;

class MemoryCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  set(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return value;
  }

  del(key) {
    this.store.delete(key);
  }

  delByPrefix(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}

class RedisCache {
  constructor(url) {
    this.url = url;
    this.client = null;
    this.memoryFallback = new MemoryCache();
    this.connectPromise = null;
  }

  async connect() {
    if (this.client?.isOpen) return this.client;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      try {
        const { createClient } = require('redis');
        const client = createClient({ url: this.url });
        client.on('error', (error) => {
          console.error('Redis cache error:', error.message);
        });
        await client.connect();
        this.client = client;
        return client;
      } catch (error) {
        console.warn('Redis cache unavailable, using memory cache:', error.message);
        this.connectPromise = null;
        return null;
      }
    })();

    return this.connectPromise;
  }

  async get(key) {
    const client = await this.connect();
    if (!client) return this.memoryFallback.get(key);

    const value = await client.get(key);
    return value ? JSON.parse(value) : null;
  }

  async set(key, value, ttlSeconds = DEFAULT_TTL_SECONDS) {
    const client = await this.connect();
    if (!client) return this.memoryFallback.set(key, value, ttlSeconds);

    await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
    return value;
  }

  async del(key) {
    const client = await this.connect();
    if (!client) return this.memoryFallback.del(key);

    await client.del(key);
  }

  async delByPrefix(prefix) {
    const client = await this.connect();
    if (!client) return this.memoryFallback.delByPrefix(prefix);

    for await (const key of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
      await client.del(key);
    }
  }
}

const cache = process.env.REDIS_URL
  ? new RedisCache(process.env.REDIS_URL)
  : new MemoryCache();

const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const cacheKey = (prefix, params = {}) => `${prefix}:${stableStringify(params)}`;

const getOrSet = async (key, ttlSeconds, loader) => {
  const cached = await cache.get(key);
  if (cached) return cached;

  const value = await loader();
  await cache.set(key, value, ttlSeconds);
  return value;
};

module.exports = {
  cache,
  cacheKey,
  getOrSet,
};
