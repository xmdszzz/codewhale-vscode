import * as http from "node:http";
import * as assert from "node:assert";
import { CodewhaleClient } from "./client";

// ── Tiny mock HTTP server ───────────────────────────────────

type Handler = (
  method: string,
  path: string,
  body: unknown
) => { status: number; body: unknown; headers?: Record<string, string> };

function startMock(handler: Handler): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let body: unknown = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          // no body
        }
        const result = handler(req.method ?? "GET", req.url ?? "/", body);
        res.writeHead(result.status, result.headers ?? { "Content-Type": "application/json" });
        if (result.body != null) {
          res.end(JSON.stringify(result.body));
        } else {
          res.end();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

// ── Tests ───────────────────────────────────────────────────

async function testHealth() {
  const { port, close } = await startMock((_method, path) => {
    assert.strictEqual(path, "/health");
    return { status: 200, body: { status: "ok", service: "test", mode: "http" } };
  });
  const client = new CodewhaleClient(port);
  const result = await client.health();
  assert.strictEqual(result.status, "ok");
  close();
}

async function testCreateThread() {
  const { port, close } = await startMock((method, path, body) => {
    assert.strictEqual(method, "POST");
    assert.strictEqual(path, "/v1/threads");
    const b = body as Record<string, unknown>;
    assert.strictEqual(b?.model, "deepseek-v4-pro");
    assert.strictEqual(b?.mode, "agent");
    return {
      status: 200,
      body: {
        id: "thr_test123",
        title: "",
        preview: "",
        model: "deepseek-v4-pro",
        mode: "agent",
        archived: false,
        workspace: "/test",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    };
  });
  const client = new CodewhaleClient(port);
  const thread = await client.createThread({ model: "deepseek-v4-pro", mode: "agent" });
  assert.strictEqual(thread.id, "thr_test123");
  assert.strictEqual(thread.model, "deepseek-v4-pro");
  close();
}

async function testListThreads() {
  const { port, close } = await startMock((_method, path) => {
    assert.ok(path.includes("/v1/threads?"));
    assert.ok(path.includes("limit=10"));
    assert.ok(path.includes("include_archived=true"));
    return { status: 200, body: [] };
  });
  const client = new CodewhaleClient(port);
  const threads = await client.listThreads(10, true);
  assert.strictEqual(threads.length, 0);
  close();
}

async function testListThreadSummaries() {
  const { port, close } = await startMock((_method, path) => {
    assert.ok(path.includes("/v1/threads/summary"));
    assert.ok(path.includes("search=hello"));
    return {
      status: 200,
      body: [
        {
          id: "thr_a",
          title: "hello world",
          preview: "Greeting",
          model: "v4",
          mode: "agent",
          archived: false,
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    };
  });
  const client = new CodewhaleClient(port);
  const threads = await client.listThreadSummaries(50, "hello");
  assert.strictEqual(threads.length, 1);
  assert.strictEqual(threads[0].title, "hello world");
  close();
}

async function testUpdateThread() {
  const { port, close } = await startMock((method, path, body) => {
    assert.strictEqual(method, "PATCH");
    assert.strictEqual(path, "/v1/threads/thr_x");
    const b = body as Record<string, unknown>;
    assert.strictEqual(b?.archived, true);
    return {
      status: 200,
      body: {
        id: "thr_x",
        archived: true,
        model: "v4",
        mode: "agent",
        updated_at: "2026-01-01T00:00:00Z",
      },
    };
  });
  const client = new CodewhaleClient(port);
  const thread = await client.updateThread("thr_x", { archived: true });
  assert.strictEqual(thread.archived, true);
  close();
}

async function testResumeThread() {
  const { port, close } = await startMock((method, path) => {
    assert.strictEqual(method, "POST");
    assert.strictEqual(path, "/v1/threads/thr_resume/resume");
    return {
      status: 200,
      body: {
        id: "thr_resumed_new",
        title: "Resumed",
        preview: "",
        model: "v4",
        mode: "agent",
        archived: false,
        workspace: "/test",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    };
  });
  const client = new CodewhaleClient(port);
  const thread = await client.resumeThread("thr_resume");
  assert.strictEqual(thread.id, "thr_resumed_new");
  assert.strictEqual(thread.title, "Resumed");
  close();
}

async function testForkThread() {
  const { port, close } = await startMock((method, path) => {
    assert.strictEqual(method, "POST");
    assert.strictEqual(path, "/v1/threads/thr_fork/fork");
    return {
      status: 200,
      body: {
        id: "thr_forked",
        title: "Forked",
        preview: "",
        model: "v4",
        mode: "agent",
        archived: false,
        workspace: "/test",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    };
  });
  const client = new CodewhaleClient(port);
  const thread = await client.forkThread("thr_fork");
  assert.strictEqual(thread.id, "thr_forked");
  close();
}

async function testSseStreamParsing() {
  // SSE mock: send data lines and verify client parses them
  const { close } = await startMock((_method, path) => {
    assert.ok(path.includes("/v1/threads/thr_sse/events"));
    return {
      status: 200,
      body: null,
      headers: { "Content-Type": "text/event-stream" },
      // We need custom handling — return null and handle manually
    };
  });

  // Replace mock with a raw SSE server for this test
  close();
  const sseServer = http.createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    res.write('data: {"seq":1,"event":"item.started","thread_id":"thr_sse","turn_id":"turn_1","item_id":"item_1","payload":{"kind":"agent_message"}}\n\n');
    res.write('data: {"seq":2,"event":"item.delta","thread_id":"thr_sse","turn_id":"turn_1","item_id":"item_1","payload":{"delta":"Hello","kind":"agent_message"}}\n\n');
    res.write('data: {"seq":3,"event":"item.completed","thread_id":"thr_sse","turn_id":"turn_1","item_id":"item_1","payload":{"item":{"kind":"agent_message"}}}\n\n');
    // Close after sending
    setTimeout(() => res.end(), 100);
  });

  await new Promise<void>((resolve) => sseServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = sseServer.address();
  const ssePort = typeof addr === "object" && addr ? addr.port : 0;

  const client = new CodewhaleClient(ssePort);

  // Suppress expected abort errors
  client.on("error", () => {});

  const events: unknown[] = [];
  client.streamEvents("thr_sse", 0);

  await new Promise<void>((resolve) => {
    client.on("event", (ev: unknown) => {
      events.push(ev);
      if (events.length === 3) resolve();
    });
  });

  assert.strictEqual(events.length, 3, "should receive 3 SSE events");
  const e1 = events[0] as Record<string, unknown>;
  assert.strictEqual(e1.seq, 1);
  assert.strictEqual(e1.event, "item.started");

  const e2 = events[1] as Record<string, unknown>;
  assert.strictEqual(e2.seq, 2);
  assert.strictEqual(
    (e2.payload as Record<string, unknown>).delta,
    "Hello"
  );

  sseServer.close();
}

async function testErrorResponse() {
  const { port, close } = await startMock(() => {
    return { status: 500, body: { error: "internal" } };
  });
  const client = new CodewhaleClient(port);
  try {
    await client.health();
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok((err as Error).message.includes("500"));
  }
  close();
}

// ── Lifecycle integration ───────────────────────────────────

async function testThreadLifecycle() {
  // Simulates: create → list → archive → resume → fork
  const threads: Record<string, Record<string, unknown>> = {};

  const { port, close } = await startMock((method, path, body) => {
    if (method === "POST" && path === "/v1/threads") {
      const id = "thr_" + Math.random().toString(36).slice(2, 8);
      const b = body as Record<string, unknown>;
      threads[id] = {
        id,
        archived: false,
        model: (b?.model as string) ?? "v4",
        mode: (b?.mode as string) ?? "agent",
        updated_at: new Date().toISOString(),
      };
      return { status: 200, body: threads[id] };
    }
    if (method === "GET" && path.includes("/v1/threads?")) {
      return { status: 200, body: Object.values(threads) };
    }
    if (method === "PATCH" && path.startsWith("/v1/threads/")) {
      const tid = path.split("/v1/threads/")[1];
      const changes = body as Record<string, unknown>;
      if (threads[tid]) {
        Object.assign(threads[tid], changes);
        return { status: 200, body: threads[tid] };
      }
    }
    if (method === "POST" && path.endsWith("/resume")) {
      const tid = path.split("/v1/threads/")[1].replace("/resume", "");
      const newId = "thr_resumed_" + Math.random().toString(36).slice(2, 6);
      threads[newId] = { id: newId, archived: false, title: "Resumed from " + tid };
      return { status: 200, body: threads[newId] };
    }
    return { status: 404, body: {} };
  });

  const client = new CodewhaleClient(port);

  // Create
  const t1 = await client.createThread({ model: "v4", mode: "agent" });
  assert.ok(t1.id);
  assert.strictEqual(t1.archived, false);

  // Create another
  const t2 = await client.createThread({ model: "v4", mode: "plan" });
  assert.ok(t2.id);
  assert.notStrictEqual(t2.id, t1.id);

  // List
  const all = await client.listThreads();
  assert.strictEqual(all.length, 2);

  // Archive t1
  const archived = await client.updateThread(t1.id, { archived: true });
  assert.strictEqual(archived.archived, true);

  // Resume t2
  const resumed = await client.resumeThread(t2.id);
  assert.ok(resumed.id);
  assert.ok(resumed.title.includes("Resumed"));

  // Verify: now 3 threads (original 2 + resumed)
  const allAfter = await client.listThreads();
  assert.strictEqual(allAfter.length, 3);

  close();
}

// ── Runner ──────────────────────────────────────────────────

(async () => {
  const tests: [string, () => Promise<void>][] = [
    ["health check", testHealth],
    ["create thread", testCreateThread],
    ["list threads", testListThreads],
    ["list thread summaries", testListThreadSummaries],
    ["update (archive) thread", testUpdateThread],
    ["resume thread", testResumeThread],
    ["fork thread", testForkThread],
    ["SSE event parsing", testSseStreamParsing],
    ["error response handling", testErrorResponse],
    ["full thread lifecycle", testThreadLifecycle],
  ];

  let passed = 0;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
