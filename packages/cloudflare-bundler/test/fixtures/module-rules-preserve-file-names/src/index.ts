import message from "../message.txt";

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/text") {
      return new Response(message);
    }

    return new Response("ok");
  },
};
