import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const session = vi.hoisted(() => {
  class AuthError extends Error {
    constructor(
      message: string,
      public status: 401 | 403 = 401,
    ) {
      super(message);
    }
  }
  return { AuthError, viewer: null as null | { user: Record<string, unknown>; org: Record<string, unknown> }, lookups: 0 };
});

// The real module reads the session cookie through the framework; here the viewer is whatever the test says.
vi.mock("@/lib/auth/session", () => ({
  AuthError: session.AuthError,
  assertViewer: async () => {
    session.lookups++;
    if (!session.viewer) throw new session.AuthError("You are signed out. Sign in and try again.");
    return session.viewer;
  },
  canManage: (user: { role: string }) => user.role === "owner" || user.role === "admin",
}));

import { ServiceError } from "@/lib/services/context";
import { contentDisposition, errorResponse, isSameOrigin, jsonError, pdfResponse, readJson, withActor } from "@/lib/route";

const viewerWith = (role: "owner" | "admin" | "member") => ({
  user: { id: "usr_test000000000001", orgId: "org_test000000000001", name: "Olive Owner", email: "olive@northwind.test", role },
  org: { id: "org_test000000000001", name: "Northwind" },
});

function req(method: string, headers: Record<string, string> = {}, body?: string): Request {
  return new Request("http://internal.invalid/api/app/thing", { method, headers: { host: "app.northwind.test", ...headers }, ...(body !== undefined ? { body } : {}) });
}

const noParams = { params: Promise.resolve({}) };
let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  session.viewer = viewerWith("owner");
  session.lookups = 0;
  errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  errorLog.mockRestore();
  delete process.env.APP_URL;
});

describe("isSameOrigin", () => {
  it("never checks requests that cannot change anything", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(isSameOrigin(req(method, { origin: "https://evil.example" }))).toBe(true);
    }
  });

  it("accepts a write whose Origin is this host, whatever the scheme or letter case", () => {
    expect(isSameOrigin(req("POST", { origin: "https://app.northwind.test" }))).toBe(true);
    expect(isSameOrigin(req("DELETE", { origin: "https://APP.Northwind.test" }))).toBe(true);
    expect(isSameOrigin(req("POST", { host: "localhost:3105", origin: "http://localhost:3105" }))).toBe(true);
  });

  it("refuses a write from any other origin", () => {
    for (const origin of ["https://evil.example", "https://app.northwind.test.evil.example", "https://northwind.test", "http://localhost:3000", "null", "", "not a url"]) {
      expect(isSameOrigin(req("POST", { origin })), origin).toBe(false);
    }
    // A different port is a different origin.
    expect(isSameOrigin(req("POST", { host: "localhost:3105", origin: "http://localhost:3999" }))).toBe(false);
    // Sec-Fetch-Site cannot vouch for a request whose Origin says otherwise.
    expect(isSameOrigin(req("POST", { origin: "https://evil.example", "sec-fetch-site": "same-origin" }))).toBe(false);
  });

  it("with no Origin, requires the browser's own word that the request is same-origin", () => {
    expect(isSameOrigin(req("POST"))).toBe(false);
    expect(isSameOrigin(req("POST", { "sec-fetch-site": "same-origin" }))).toBe(true);
    for (const site of ["cross-site", "same-site", "none", ""]) expect(isSameOrigin(req("PUT", { "sec-fetch-site": site })), site).toBe(false);
  });

  it("trusts the public host the proxy forwards and the configured APP_URL", () => {
    expect(isSameOrigin(req("POST", { host: "10.0.0.7:3000", "x-forwarded-host": "app.northwind.test", origin: "https://app.northwind.test" }))).toBe(true);
    expect(isSameOrigin(req("POST", { host: "10.0.0.7:3000", origin: "https://sign.northwind.test" }))).toBe(false);
    process.env.APP_URL = "https://sign.northwind.test/";
    expect(isSameOrigin(req("POST", { host: "10.0.0.7:3000", origin: "https://sign.northwind.test" }))).toBe(true);
  });
});

describe("withActor", () => {
  it("passes the actor, viewer, request details and route params to the handler, and sends plain data as JSON", async () => {
    const handler = withActor<{ id: string }>(async ({ actor, viewer, meta, params, request }) => ({
      orgId: actor.orgId,
      actorType: actor.type,
      name: viewer.user.name,
      ip: meta.ip,
      id: params.id,
      method: request.method,
    }));
    const res = await handler(req("POST", { origin: "https://app.northwind.test", "x-real-ip": "203.0.113.5" }), { params: Promise.resolve({ id: "file_1" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ orgId: "org_test000000000001", actorType: "user", name: "Olive Owner", ip: "203.0.113.5", id: "file_1", method: "POST" });
  });

  it("returns a handler's own Response untouched", async () => {
    const res = await withActor(async () => new Response("ok", { status: 201 }))(req("GET"), noParams);
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("ok");
  });

  it("answers 401 JSON when signed out", async () => {
    session.viewer = null;
    let ran = false;
    const res = await withActor(async () => {
      ran = true;
      return {};
    })(req("GET"), noParams);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthenticated", message: "You are signed out. Sign in and try again." } });
    expect(ran).toBe(false);
  });

  it("answers 403 to a member when the route is for managers, and lets admins through", async () => {
    const handler = withActor(async () => ({ done: true }), { manage: true });
    session.viewer = viewerWith("member");
    const refused = await handler(req("GET"), noParams);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("forbidden");
    session.viewer = viewerWith("admin");
    expect((await handler(req("GET"), noParams)).status).toBe(200);
    // Without `manage`, a member is fine.
    session.viewer = viewerWith("member");
    expect((await withActor(async () => ({}))(req("GET"), noParams)).status).toBe(200);
  });

  it("refuses a cross-site write before looking at the session or running the handler", async () => {
    let ran = false;
    const handler = withActor(async () => {
      ran = true;
      return {};
    });
    const res = await handler(req("POST", { origin: "https://evil.example" }), noParams);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("cross_origin");
    expect(ran).toBe(false);
    expect(session.lookups).toBe(0);
    expect((await handler(req("DELETE"), noParams)).status).toBe(403);
  });

  it("maps a ServiceError to its status with the message and field problems", async () => {
    const cases: [ServiceError["code"], number][] = [
      ["not_found", 404],
      ["invalid", 422],
      ["conflict", 409],
      ["forbidden", 403],
      ["rate_limited", 429],
      ["gone", 410],
      ["not_ready", 409],
    ];
    for (const [code, status] of cases) {
      const res = await withActor(async () => {
        throw new ServiceError(code, "That did not work. Try again.", code === "invalid" ? { clientEmail: "Enter an email address." } : undefined);
      })(req("GET"), noParams);
      expect(res.status, code).toBe(status);
      expect(await res.json()).toEqual({ error: { code, message: "That did not work. Try again.", ...(code === "invalid" ? { fields: { clientEmail: "Enter an email address." } } : {}) } });
    }
  });

  it("logs an unexpected error and reports it without internals", async () => {
    const res = await withActor(async () => {
      throw new Error('relation "secret_table" does not exist');
    })(req("GET"), noParams);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal");
    expect(JSON.stringify(body)).not.toContain("secret_table");
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it("lets the framework's own redirect and not-found signals through", async () => {
    const signal = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
    await expect(
      withActor(async () => {
        throw signal;
      })(req("GET"), noParams),
    ).rejects.toBe(signal);
  });
});

describe("errorResponse, jsonError and readJson", () => {
  it("maps an AuthError by its status", async () => {
    expect(errorResponse(new session.AuthError("Signed out")).status).toBe(401);
    const forbidden = errorResponse(new session.AuthError("Only an owner or admin can do that.", 403));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: { code: "forbidden", message: "Only an owner or admin can do that." } });
  });

  it("builds the one error shape every route uses", async () => {
    const res = jsonError("not_found", "That file was not found.", 404);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "That file was not found." } });
  });

  it("reads a JSON object and turns anything else into a 422", async () => {
    expect(await readJson(req("POST", {}, '{"a":1}'))).toEqual({ a: 1 });
    for (const body of ["not json", "[1,2]", '"text"', "null", ""]) {
      await expect(readJson(req("POST", {}, body)), body).rejects.toMatchObject({ code: "invalid" });
    }
  });
});

describe("pdfResponse", () => {
  it("sets the headers a private PDF download needs", async () => {
    const bytes = Buffer.from("%PDF-1.7 test");
    const res = pdfResponse(bytes, "Client Services Agreement F-2026-0001 (signed).pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-length")).toBe(String(bytes.length));
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Client Services Agreement F-2026-0001 (signed).pdf"; filename*=UTF-8''Client%20Services%20Agreement%20F-2026-0001%20%28signed%29.pdf`,
    );
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it("can be shown in the browser instead, and always ends in .pdf", () => {
    expect(pdfResponse(new Uint8Array([1]), "Agreement", { inline: true }).headers.get("content-disposition")).toMatch(/^inline; filename="Agreement\.pdf"/);
  });

  it("encodes any filename so nothing can break out of the header", () => {
    const hostile = 'Acme "Q4"\r\nSet-Cookie: x=1; évaluation/..\\naïve 合同.pdf';
    const header = contentDisposition(hostile);
    expect(header).not.toMatch(/[\r\n]/);
    const [, ascii] = /filename="([^"]*)"/.exec(header) ?? [];
    expect(ascii).toBeDefined();
    expect(ascii).not.toMatch(/["\\/;%]/);
    expect(ascii).toMatch(/^[\x20-\x7e]+$/);
    const [, encoded] = /filename\*=UTF-8''(\S+)$/.exec(header) ?? [];
    expect(encoded).toMatch(/^[A-Za-z0-9%._~!$&+^`|-]+$/);
    expect(decodeURIComponent(encoded)).toContain("合同.pdf");
    expect(decodeURIComponent(encoded)).not.toMatch(/[\r\n\\/]/);
    expect(contentDisposition("")).toBe(`attachment; filename="document.pdf"; filename*=UTF-8''document.pdf`);
  });
});
