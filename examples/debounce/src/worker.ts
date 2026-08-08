export { ExampleDebounceAndLease } from "./do";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    // "" / "api" / :key / :action
    const [, , key, action] = url.pathname.split("/");
    if (!key || !action) {
      return new Response(
        "Usage: POST /api/:key/signal, POST /api/:key/flush, GET /api/:key/status, GET /api/:key/runs",
        { status: 400 },
      );
    }

    const stub = env.DEBOUNCE.getByName(key);

    if (request.method === "POST" && action === "signal") {
      return Response.json(await stub.signal());
    }
    if (request.method === "POST" && action === "flush") {
      return Response.json(await stub.flush());
    }
    if (request.method === "GET" && action === "status") {
      return Response.json(await stub.status());
    }
    if (request.method === "GET" && action === "runs") {
      return Response.json(await stub.runs());
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
