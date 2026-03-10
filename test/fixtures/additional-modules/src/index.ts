export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    const langMatch = url.pathname.match(/^\/lang\/(\w+)$/);
    if (langMatch) {
      const lang = langMatch[1];
      const mod = await import(`./lang/${lang}.js`);
      return new Response(mod.default);
    }

    return new Response("ok");
  },
};
