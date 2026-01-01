import { describe, it, expect } from 'vitest';
import { extractClipSlug, isArrossClip } from '../../../src/services/twitch';

describe('extractClipSlug', () => {
  describe('clips.twitch.tv format', () => {
    it('should extract slug from clips.twitch.tv URL', () => {
      const url = 'https://clips.twitch.tv/FunnyClipSlug123';
      expect(extractClipSlug(url)).toBe('FunnyClipSlug123');
    });

    it('should extract slug from clips.twitch.tv URL with trailing slash', () => {
      const url = 'https://clips.twitch.tv/FunnyClipSlug123/';
      expect(extractClipSlug(url)).toBe('FunnyClipSlug123/');
    });

    it('should handle clips.twitch.tv URL with query parameters', () => {
      const url = 'https://clips.twitch.tv/FunnyClipSlug123?filter=clips&range=7d';
      expect(extractClipSlug(url)).toBe('FunnyClipSlug123');
    });
  });

  describe('twitch.tv/channel/clip/ format', () => {
    it('should extract slug from twitch.tv/channel/clip/ URL', () => {
      const url = 'https://twitch.tv/arross/clip/AwesomeClipSlug456';
      expect(extractClipSlug(url)).toBe('AwesomeClipSlug456');
    });

    it('should extract slug from different channel names', () => {
      const url = 'https://twitch.tv/somechannel/clip/CoolClipSlug789';
      expect(extractClipSlug(url)).toBe('CoolClipSlug789');
    });

    it('should handle twitch.tv URL with query parameters', () => {
      const url = 'https://twitch.tv/arross/clip/ClipWithParams?tt_content=full_vod&tt_medium=clips_watch_page';
      expect(extractClipSlug(url)).toBe('ClipWithParams');
    });
  });

  describe('www.twitch.tv format', () => {
    it('should extract slug from www.twitch.tv/channel/clip/ URL', () => {
      const url = 'https://www.twitch.tv/arross/clip/WwwClipSlug123';
      expect(extractClipSlug(url)).toBe('WwwClipSlug123');
    });

    it('should handle www.twitch.tv URL with query parameters', () => {
      const url = 'https://www.twitch.tv/arross/clip/WwwClipParams?filter=clips&range=all';
      expect(extractClipSlug(url)).toBe('WwwClipParams');
    });

    it('should extract slug from www.twitch.tv with different channel', () => {
      const url = 'https://www.twitch.tv/otherchannel/clip/AnotherClipSlug';
      expect(extractClipSlug(url)).toBe('AnotherClipSlug');
    });
  });

  describe('handling URLs with query parameters', () => {
    it('should strip query parameters from clips.twitch.tv', () => {
      const url = 'https://clips.twitch.tv/TestClip?parent=twitch.tv&autoplay=true';
      expect(extractClipSlug(url)).toBe('TestClip');
    });

    it('should strip query parameters from twitch.tv/channel/clip/', () => {
      const url = 'https://twitch.tv/arross/clip/TestClip?parent=twitch.tv&muted=false';
      expect(extractClipSlug(url)).toBe('TestClip');
    });

    it('should strip query parameters from www.twitch.tv/channel/clip/', () => {
      const url = 'https://www.twitch.tv/arross/clip/TestClip?referrer=raid';
      expect(extractClipSlug(url)).toBe('TestClip');
    });
  });

  describe('invalid URLs - should return null', () => {
    it('should return null for empty string', () => {
      expect(extractClipSlug('')).toBeNull();
    });

    it('should return null for malformed URL', () => {
      expect(extractClipSlug('not-a-url')).toBeNull();
    });

    it('should return null for URL without protocol', () => {
      expect(extractClipSlug('clips.twitch.tv/SomeClip')).toBeNull();
    });

    it('should return null for clips.twitch.tv without slug', () => {
      const url = 'https://clips.twitch.tv/';
      expect(extractClipSlug(url)).toBeNull();
    });

    it('should return null for clips.twitch.tv with empty path', () => {
      const url = 'https://clips.twitch.tv';
      expect(extractClipSlug(url)).toBeNull();
    });

    it('should return null for twitch.tv without /clip/ path', () => {
      const url = 'https://www.twitch.tv/arross';
      expect(extractClipSlug(url)).toBeNull();
    });

    it('should return null for twitch.tv channel page without clip', () => {
      const url = 'https://www.twitch.tv/arross/videos';
      expect(extractClipSlug(url)).toBeNull();
    });

    it('should return null for twitch.tv/clip without slug', () => {
      const url = 'https://www.twitch.tv/arross/clip/';
      expect(extractClipSlug(url)).toBeNull();
    });
  });

  describe('non-Twitch URLs - should return null', () => {
    it('should return null for YouTube URL', () => {
      const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
      expect(extractClipSlug(url)).toBeNull();
    });

    it('should return null for random domain', () => {
      const url = 'https://example.com/clips/SomeClip';
      expect(extractClipSlug(url)).toBeNull();
    });

    it('should return null for similar but different domain', () => {
      const url = 'https://clips.twitch.com/SomeClip';
      expect(extractClipSlug(url)).toBeNull();
    });

    it('should return null for subdomain of twitch.tv that is not clips or www', () => {
      const url = 'https://help.twitch.tv/hc/en-us';
      expect(extractClipSlug(url)).toBeNull();
    });

    it('should return null for Twitch VOD URL', () => {
      const url = 'https://www.twitch.tv/videos/123456789';
      expect(extractClipSlug(url)).toBeNull();
    });
  });
});

describe('isArrossClip', () => {
  const ARROSS_BROADCASTER_ID = '76024422';

  describe('broadcaster validation', () => {
    it('should return true for clip with Arross broadcaster ID', () => {
      const clipData = {
        id: 'TestClip123',
        url: 'https://clips.twitch.tv/TestClip123',
        embed_url: 'https://clips.twitch.tv/embed?clip=TestClip123',
        broadcaster_id: ARROSS_BROADCASTER_ID,
        broadcaster_name: 'arross',
        creator_id: '12345',
        creator_name: 'somecreator',
        title: 'Test Clip',
        created_at: '2024-01-01T00:00:00Z',
        thumbnail_url: 'https://clips-media.twitch.tv/test.jpg',
        duration: 30,
      };
      expect(isArrossClip(clipData)).toBe(true);
    });

    it('should return true for clip with Arross broadcaster name (case insensitive)', () => {
      const clipData = {
        id: 'TestClip456',
        url: 'https://clips.twitch.tv/TestClip456',
        embed_url: 'https://clips.twitch.tv/embed?clip=TestClip456',
        broadcaster_id: 'different-id',
        broadcaster_name: 'Arross',
        creator_id: '12345',
        creator_name: 'somecreator',
        title: 'Test Clip',
        created_at: '2024-01-01T00:00:00Z',
        thumbnail_url: 'https://clips-media.twitch.tv/test.jpg',
        duration: 30,
      };
      expect(isArrossClip(clipData)).toBe(true);
    });

    it('should return true for clip with uppercase broadcaster name', () => {
      const clipData = {
        id: 'TestClip789',
        url: 'https://clips.twitch.tv/TestClip789',
        embed_url: 'https://clips.twitch.tv/embed?clip=TestClip789',
        broadcaster_id: 'different-id',
        broadcaster_name: 'ARROSS',
        creator_id: '12345',
        creator_name: 'somecreator',
        title: 'Test Clip',
        created_at: '2024-01-01T00:00:00Z',
        thumbnail_url: 'https://clips-media.twitch.tv/test.jpg',
        duration: 30,
      };
      expect(isArrossClip(clipData)).toBe(true);
    });

    it('should return false for clip from different broadcaster', () => {
      const clipData = {
        id: 'OtherClip123',
        url: 'https://clips.twitch.tv/OtherClip123',
        embed_url: 'https://clips.twitch.tv/embed?clip=OtherClip123',
        broadcaster_id: '99999999',
        broadcaster_name: 'otherstreamer',
        creator_id: '12345',
        creator_name: 'somecreator',
        title: 'Other Clip',
        created_at: '2024-01-01T00:00:00Z',
        thumbnail_url: 'https://clips-media.twitch.tv/test.jpg',
        duration: 30,
      };
      expect(isArrossClip(clipData)).toBe(false);
    });

    it('should return false for clip with similar but different broadcaster name', () => {
      const clipData = {
        id: 'SimilarClip123',
        url: 'https://clips.twitch.tv/SimilarClip123',
        embed_url: 'https://clips.twitch.tv/embed?clip=SimilarClip123',
        broadcaster_id: '88888888',
        broadcaster_name: 'arross2',
        creator_id: '12345',
        creator_name: 'somecreator',
        title: 'Similar Clip',
        created_at: '2024-01-01T00:00:00Z',
        thumbnail_url: 'https://clips-media.twitch.tv/test.jpg',
        duration: 30,
      };
      expect(isArrossClip(clipData)).toBe(false);
    });
  });
});
