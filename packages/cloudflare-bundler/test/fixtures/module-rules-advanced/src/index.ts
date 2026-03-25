import customText from "../data.custom";
import regularText from "../info.txt";

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/custom") {
      return new Response(customText);
    }

    if (url.pathname === "/text") {
      return new Response(regularText);
    }

    return new Response("ok");
  },
};
