export default {
  async fetch(request) {
    console.log(globalThis.process);
    return new Response("Hello World");
  },
};
