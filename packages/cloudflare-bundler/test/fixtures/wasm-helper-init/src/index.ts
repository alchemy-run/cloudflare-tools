import init from "./nested/loader";

export default {
  async fetch() {
    const instance = await init();
    const add = instance.exports.add as (a: number, b: number) => number;
    return new Response(String(add(4, 5)));
  },
};
