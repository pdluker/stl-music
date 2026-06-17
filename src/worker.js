export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api/events') {
      const data = await env.MUSIC_KV.get('events', 'json');
      return Response.json(data || { events: [] });
    }
    return env.ASSETS.fetch(req);
  }
};