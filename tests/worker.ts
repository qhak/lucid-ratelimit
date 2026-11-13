export { RateLimitDurableObject } from '@lucid/ratelimit/durable-object';

export default {
  fetch(): Response {
    return new Response('Lucid RateLimit test worker');
  },
};
