export { ChaosDebounceAndLease } from "./chaos-do";
export { TestDebounceAndLease } from "./test-do";

export default {
  async fetch(): Promise<Response> {
    return new Response("test fixture worker", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
