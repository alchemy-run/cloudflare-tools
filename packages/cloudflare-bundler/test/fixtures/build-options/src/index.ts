function myVeryLongAndDistinctiveFunctionName() {
  return "hello from named function";
}

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/function-name") {
      return new Response(myVeryLongAndDistinctiveFunctionName.name);
    }

    if (url.pathname === "/call") {
      return new Response(myVeryLongAndDistinctiveFunctionName());
    }

    return new Response("ok");
  },
};
