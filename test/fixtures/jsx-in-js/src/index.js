// Verify JSX syntax is supported in .js files (esbuild loader: jsx)
// Using classic transform via tsconfig: jsxFactory=h
function h(tag, props, ...children) {
  return { tag, props: props || {}, children };
}

// This JSX syntax should be transformed to h() calls by esbuild
const element = <div class="test">Hello JSX</div>;

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/jsx") {
      return new Response(JSON.stringify(element));
    }

    return new Response("ok");
  },
};
