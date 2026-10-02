/**
 * Cache Service Unit Tests
 *
 * Mocks config/redis directly (not the ioredis constructor) so every test
 * talks to one stable fake client.
 */

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  keys: jest.fn(),
  exists: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  ttl: jest.fn(),
  hget: jest.fn(),
  hset: jest.fn(),
  hgetall: jest.fn(),
  flushdb: jest.fn(),
  info: jest.fn(),
  dbsize: jest.fn(),
};
const mockIsRedisHealthy = jest.fn().mockResolvedValue(true);

jest.mock('../../../config/redis', () => ({
  getRedisClient: () => mockRedis,
  isRedisHealthy: () => mockIsRedisHealthy(),
}));

import { cacheService, CacheKeys, CacheTTL } from '../../../services/cacheService';

beforeEach(() => {
  for (const fn of Object.values(mockRedis)) fn.mockReset();
  mockIsRedisHealthy.mockResolvedValue(true);
});

describe('CacheService', () => {
  describe('get', () => {
    it('returns parsed JSON for a cached value', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ name: 'test', value: 123 }));
      expect(await cacheService.get('test-key')).toEqual({ name: 'test', value: 123 });
      expect(mockRedis.get).toHaveBeenCalledWith('test-key');
    });

    it('returns null for a missing key', async () => {
      mockRedis.get.mockResolvedValue(null);
      expect(await cacheService.get('missing')).toBeNull();
    });

    it('returns null when the stored value is not JSON', async () => {
      mockRedis.get.mockResolvedValue('plain-string');
      expect(await cacheService.get('string-key')).toBeNull();
    });

    it('returns null on a Redis error', async () => {
      mockRedis.get.mockRejectedValue(new Error('Redis error'));
      expect(await cacheService.get('error-key')).toBeNull();
    });
  });

  describe('set', () => {
    it('uses SET without a TTL', async () => {
      expect(await cacheService.set('k', { data: 'value' })).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith('k', JSON.stringify({ data: 'value' }));
      expect(mockRedis.setex).not.toHaveBeenCalled();
    });

    it('uses SETEX with a TTL', async () => {
      await cacheService.set('k', 'value', 3600);
      expect(mockRedis.setex).toHaveBeenCalledWith('k', 3600, JSON.stringify('value'));
    });

    it('returns false instead of throwing on a Redis error', async () => {
      mockRedis.set.mockRejectedValue(new Error('Redis error'));
      expect(await cacheService.set('k', 'value')).toBe(false);
    });
  });

  describe('del / delPattern', () => {
    it('deletes a key', async () => {
      expect(await cacheService.del('k')).toBe(true);
      expect(mockRedis.del).toHaveBeenCalledWith('k');
    });

    it('deletes every key matching a pattern', async () => {
      mockRedis.keys.mockResolvedValue(['key1', 'key2', 'key3']);
      mockRedis.del.mockResolvedValue(3);
      expect(await cacheService.delPattern('key*')).toBe(3);
      expect(mockRedis.del).toHaveBeenCalledWith('key1', 'key2', 'key3');
    });

    it('skips DEL when nothing matches', async () => {
      mockRedis.keys.mockResolvedValue([]);
      expect(await cacheService.delPattern('none*')).toBe(0);
      expect(mockRedis.del).not.toHaveBeenCalled();
    });
  });

  describe('exists', () => {
    it('maps 1/0 to true/false', async () => {
      mockRedis.exists.mockResolvedValue(1);
      expect(await cacheService.exists('a')).toBe(true);
      mockRedis.exists.mockResolvedValue(0);
      expect(await cacheService.exists('b')).toBe(false);
    });
  });

  describe('incr', () => {
    it('sets the TTL only on the first increment', async () => {
      mockRedis.incr.mockResolvedValue(1);
      expect(await cacheService.incr('counter', 60)).toBe(1);
      expect(mockRedis.expire).toHaveBeenCalledWith('counter', 60);

      mockRedis.expire.mockClear();
      mockRedis.incr.mockResolvedValue(5);
      expect(await cacheService.incr('counter', 60)).toBe(5);
      expect(mockRedis.expire).not.toHaveBeenCalled();
    });
  });

  describe('getOrSet', () => {
    it('returns the cached value without fetching', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ cached: true }));
      const fetchFn = jest.fn();
      expect(await cacheService.getOrSet('k', fetchFn)).toEqual({ cached: true });
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('fetches and caches on a miss', async () => {
      mockRedis.get.mockResolvedValue(null);
      const fetchFn = jest.fn().mockResolvedValue({ fresh: true });
      expect(await cacheService.getOrSet('k', fetchFn, 3600)).toEqual({ fresh: true });
      expect(mockRedis.setex).toHaveBeenCalledWith('k', 3600, JSON.stringify({ fresh: true }));
    });
  });

  describe('hgetall', () => {
    it('returns null for an empty hash', async () => {
      mockRedis.hgetall.mockResolvedValue({});
      expect(await cacheService.hgetall('h')).toBeNull();
      mockRedis.hgetall.mockResolvedValue({ a: '1' });
      expect(await cacheService.hgetall('h')).toEqual({ a: '1' });
    });
  });

  describe('domain helpers', () => {
    it('caches users under the user prefix with the user TTL', async () => {
      await cacheService.cacheUser('user-123', { id: 'user-123' });
      expect(mockRedis.setex).toHaveBeenCalledWith(`${CacheKeys.USER}user-123`, CacheTTL.USER, expect.any(String));
    });

    it('caches listings under the listing prefix', async () => {
      await cacheService.cacheListing('listing-123', { id: 'listing-123' });
      expect(mockRedis.setex).toHaveBeenCalledWith(`${CacheKeys.LISTING}listing-123`, CacheTTL.LISTING, expect.any(String));
    });

    it('reads back a cached user', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify({ id: 'user-123' }));
      expect(await cacheService.getCachedUser('user-123')).toEqual({ id: 'user-123' });
      expect(mockRedis.get).toHaveBeenCalledWith(`${CacheKeys.USER}user-123`);
    });
  });

  describe('getStats', () => {
    it('reports memory and key count when connected', async () => {
      mockRedis.info.mockResolvedValue('# Memory\r\nused_memory_human:4.78M\r\n');
      mockRedis.dbsize.mockResolvedValue(42);
      expect(await cacheService.getStats()).toEqual({ connected: true, memoryUsage: '4.78M', keyCount: 42 });
    });

    it('reports disconnected when Redis is down', async () => {
      mockIsRedisHealthy.mockResolvedValue(false);
      expect(await cacheService.getStats()).toEqual({ connected: false });
    });
  });

  describe('degraded mode', () => {
    it('skips Redis entirely when unavailable at startup', async () => {
      mockIsRedisHealthy.mockResolvedValue(false);
      let degraded: typeof cacheService;
      jest.isolateModules(() => {
        degraded = require('../../../services/cacheService').cacheService;
      });
      await new Promise((r) => setImmediate(r)); // let the constructor's health check settle

      expect(await degraded!.get('k')).toBeNull();
      expect(await degraded!.set('k', 'v')).toBe(false);
      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });
});
