import { Hono, type MiddlewareHandler } from "hono";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { canAccessProject, isUuid, requireProjectAccess, requireRole, requireRoleOrQueryToken, type AuthEnv } from "./auth.js";
import { sql } from "./db.js";
import { STATUS_LABELS, describeFilter, listDefects, parseStatuses, protocolDocument, type Defect, type DefectFilter } from "./defects.js";
import { exists, formatDay, planCrop } from "./report-pdf.js";
import { createShareLink, escapeHtml, notFoundPage, publicOrigin, publicPage, resolveShareLink } from "./share.js";
import { isSignature, qrPng, signaturePng, signatureSchema, type SignatureStrokes } from "./signature.js";
import { photoFile } from "./storage.js";

// Saved acceptance protocols (#82): a stage or the final acceptance, frozen with the defects as they were, printed
// with a QR code to its read-only online version, and signed with a finger in the app by the contractor and the investor.

type Role = "contractor" | "investor";
const ROLES: Role[] = ["contractor", "investor"];
const ROLE_LABELS: Record<Role, string> = { contractor: "Wykonawca", investor: "Inwestor" };

// A paper protocol lives long: its QR code works for a year.
const PROTOCOL_LINK_DAYS = 365;
const MAX_TITLE_CHARS = 200;
const MAX_NAME_CHARS = 120;

type ProtocolRow = {
  id: string;
  projectId: string;
  title: string;
  scope: "stage" | "final";
  filter: DefectFilter;
  snapshot: { projectName: string; scopeText: string; defects: Defect[] };
  shareToken: string;
  shareExpiresAt: Date;
  createdByName: string;
  createdAt: Date;
};

type SignatureRow = { role: Role; name: string; strokes: SignatureStrokes; signedAt: Date };

const protocolColumns = sql`
  id, project_id as "projectId", title, scope, filter, snapshot, share_token as "shareToken",
  share_expires_at as "shareExpiresAt", created_by_name as "createdByName", created_at as "createdAt"`;

const protocolById = async (id: string) => {
  if (!isUuid(id)) return null;
  const [row] = await sql<ProtocolRow[]>`select ${protocolColumns} from protocols where id = ${id}`;
  return row ?? null;
};

const signaturesOf = (protocolId: string) => sql<SignatureRow[]>`
  select role, name, strokes, signed_at as "signedAt" from protocol_signatures where protocol_id = ${protocolId} order by role`;

const onlineUrl = (origin: string, token: string) => `${origin}/p/${token}`;

const protocolView = async (row: ProtocolRow, origin: string) => {
  const signatures = await signaturesOf(row.id);
  const defects = row.snapshot.defects;
  return {
    id: row.id,
    title: row.title,
    scope: row.scope,
    scopeText: row.snapshot.scopeText,
    defectCount: defects.length,
    openCount: defects.filter((defect) => defect.status !== "closed").length,
    url: onlineUrl(origin, row.shareToken),
    urlExpiresAt: row.shareExpiresAt,
    signatures: signatures.map(({ role, name, signedAt }) => ({ role, name, signedAt })),
    createdByName: row.createdByName,
    createdAt: row.createdAt,
  };
};

const pdfOf = async (row: ProtocolRow, origin: string) => {
  const url = onlineUrl(origin, row.shareToken);
  const signatures = await Promise.all(
    (await signaturesOf(row.id)).map(async (signature) => ({ ...signature, image: await signaturePng(signature.strokes) })),
  );
  return protocolDocument(row.projectId, row.snapshot.projectName, row.snapshot.defects, {
    heading: row.title,
    scope: row.snapshot.scopeText,
    asOf: new Date(row.createdAt),
    link: { url, qr: await qrPng(url) },
    signatures,
  });
};

const pdfResponse = (pdf: Buffer, row: ProtocolRow) =>
  new Response(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="protokol-${new Date(row.createdAt).toISOString().slice(0, 10)}.pdf"`,
      "cache-control": "no-store",
    },
  });

const requireProtocolAccess: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const row = await protocolById(c.req.param("id") ?? "");
  if (!row || !(await canAccessProject(c.get("principal"), row.projectId))) return c.json({ error: "Nie ma takiego protokołu" }, 404);
  await next();
};

export const protocols = new Hono<AuthEnv>();

protocols.get("/api/projects/:id/protocols", requireRole("app", "admin"), requireProjectAccess(), async (c) => {
  const rows = await sql<ProtocolRow[]>`select ${protocolColumns} from protocols where project_id = ${c.req.param("id")} order by created_at desc`;
  return c.json(await Promise.all(rows.map((row) => protocolView(row, publicOrigin(c)))));
});

// Made from the defects filtered like the list in the app. It creates the read-only link for the QR code, which is
// handing the protocol outside the firm, so like other links it is for owners and managers.
protocols.post("/api/projects/:id/protocols", requireRole("admin"), requireProjectAccess(), async (c) => {
  const body = await c.req
    .json<{ title?: unknown; scope?: unknown; status?: unknown; assignee?: unknown; documentId?: unknown; pageNo?: unknown }>()
    .catch(() => null);
  if (!body) return c.json({ error: "Nieprawidłowe dane" }, 400);
  const scope = body.scope === "final" ? "final" : "stage";
  const title =
    (typeof body.title === "string" ? body.title.trim().slice(0, MAX_TITLE_CHARS) : "") ||
    (scope === "final" ? "Protokół odbioru końcowego" : "Protokół odbioru etapu");
  const filter: DefectFilter = {
    statuses: parseStatuses(typeof body.status === "string" ? body.status : undefined),
    assignee: typeof body.assignee === "string" ? body.assignee : undefined,
    documentId: typeof body.documentId === "string" ? body.documentId : undefined,
    pageNo: typeof body.pageNo === "number" && Number.isInteger(body.pageNo) && body.pageNo > 0 ? body.pageNo : undefined,
  };
  const projectId = c.req.param("id");
  const [project] = await sql<{ name: string }[]>`select name from projects where id = ${projectId}`;
  const found = await listDefects(projectId, filter);
  const { user } = c.get("principal");
  const [row] = await sql<{ id: string }[]>`
    insert into protocols (project_id, title, scope, filter, snapshot, share_token, share_expires_at, created_by, created_by_name)
    values (${projectId}, ${title}, ${scope}, ${sql.json(filter)},
      ${sql.json({ projectName: project?.name ?? "", scopeText: describeFilter(filter, found), defects: found } as never)},
      '', now(), ${user?.id ?? null}, ${user ? user.name || user.email : ""})
    returning id`;
  const link = await createShareLink(projectId, { type: "protocol", id: row!.id }, user?.id ?? null, PROTOCOL_LINK_DAYS);
  await sql`update protocols set share_token = ${link.token}, share_expires_at = ${link.expiresAt} where id = ${row!.id}`;
  return c.json(await protocolView((await protocolById(row!.id))!, publicOrigin(c)), 201);
});

protocols.get("/api/protocols/:id", requireRole("app", "admin"), requireProtocolAccess, async (c) =>
  c.json(await protocolView((await protocolById(c.req.param("id")))!, publicOrigin(c))),
);

protocols.get("/api/protocols/:id/protocol.pdf", requireRoleOrQueryToken("app", "admin"), requireProtocolAccess, async (c) => {
  const row = (await protocolById(c.req.param("id")))!;
  return pdfResponse(await pdfOf(row, publicOrigin(c)), row);
});

// Signed on the phone on site: the investor signs on the contractor's phone, so anyone on the project may save it.
protocols.put("/api/protocols/:id/signatures/:role", requireRole("app", "admin"), requireProtocolAccess, async (c) => {
  const role = c.req.param("role") as Role;
  if (!ROLES.includes(role)) return c.json({ error: "Nieznana strona podpisu" }, 404);
  const body = await c.req.json<{ name?: unknown; signature?: unknown }>().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, MAX_NAME_CHARS) : "";
  if (!name) return c.json({ error: "Podaj imię i nazwisko podpisującego" }, 400);
  const parsed = signatureSchema.safeParse(body?.signature);
  if (!parsed.success || !isSignature(parsed.data)) return c.json({ error: "Podpis jest pusty albo nieczytelny. Podpisz się jeszcze raz." }, 400);
  const row = (await protocolById(c.req.param("id")))!;
  await sql`
    insert into protocol_signatures (protocol_id, project_id, role, name, strokes, signed_by)
    values (${row.id}, ${row.projectId}, ${role}, ${name}, ${sql.json(parsed.data)}, ${c.get("principal").user?.id ?? null})
    on conflict (protocol_id, role) do update set name = excluded.name, strokes = excluded.strokes, signed_by = excluded.signed_by, signed_at = now()`;
  return c.json(await protocolView(row, publicOrigin(c)));
});

protocols.delete("/api/protocols/:id/signatures/:role", requireRole("admin"), requireProtocolAccess, async (c) => {
  await sql`delete from protocol_signatures where protocol_id = ${c.req.param("id")} and role = ${c.req.param("role")}`;
  return c.json(await protocolView((await protocolById(c.req.param("id")))!, publicOrigin(c)));
});

protocols.delete("/api/protocols/:id", requireRole("admin"), requireProtocolAccess, async (c) => {
  await sql`delete from protocols where id = ${c.req.param("id")}`;
  await sql`delete from share_links where target_type = 'protocol' and target_id = ${c.req.param("id")}`;
  return c.body(null, 204);
});

// --- The online version behind the QR code ---

const sharedProtocol = async (token: string) => {
  const link = await resolveShareLink(token, "protocol");
  const row = link ? await protocolById(link.targetId) : null;
  return row && row.projectId === link?.projectId ? row : null;
};

const protocolHtml = (row: ProtocolRow, signatures: SignatureRow[], token: string) => {
  const base = `/p/${encodeURIComponent(token)}`;
  const defects = row.snapshot.defects.map((defect, index) => {
    const status = defect.status ?? "open";
    const meta = [
      `${escapeHtml(defect.pageTitle ?? "Strona")} (str. ${defect.pageNo})`,
      defect.assignee ? `Odpowiedzialny: ${escapeHtml(defect.assignee)}` : "",
      defect.dueDate ? `Termin: ${formatDay(defect.dueDate)}` : "",
      `Zgłoszono ${formatDay(defect.createdAt)}`,
    ].filter(Boolean);
    const photos = [
      `<figure><img loading="lazy" src="${base}/spots/${defect.id}" alt="Miejsce na rzucie"><figcaption>Miejsce na rzucie</figcaption></figure>`,
      ...defect.photos.map(
        (photo) =>
          `<figure><img loading="lazy" src="${base}/photos/${photo.id}" alt=""><figcaption>${photo.stage === "after" ? "Po" : "Przed"} · ${formatDay(photo.takenAt)}</figcaption></figure>`,
      ),
    ];
    return (
      `<div class="card"><h3 style="margin-top:0">${index + 1}. ${escapeHtml(defect.room || defect.pageTitle || `Strona ${defect.pageNo}`)} ` +
      `<span class="status-${status}">${STATUS_LABELS[status]}</span></h3><p class="muted">${meta.join(" · ")}</p>` +
      (defect.note ? `<p>${escapeHtml(defect.note)}</p>` : "") +
      `<div class="photos">${photos.join("")}</div></div>`
    );
  });
  const signed = ROLES.map((role) => {
    const signature = signatures.find((candidate) => candidate.role === role);
    return signature
      ? `<div class="card"><p><strong>${ROLE_LABELS[role]}:</strong> ${escapeHtml(signature.name)}, ${formatDay(signature.signedAt)}</p><img class="signature" src="${base}/signatures/${role}" alt="Podpis"></div>`
      : `<div class="card"><p><strong>${ROLE_LABELS[role]}:</strong> <span class="muted">jeszcze nie podpisano w aplikacji</span></p></div>`;
  });
  const body = [
    `<h1>${escapeHtml(row.title)}</h1>`,
    `<p>${escapeHtml(row.snapshot.projectName)}</p>`,
    `<p class="muted">Stan na ${formatDay(row.createdAt)}. ${escapeHtml(row.snapshot.scopeText)}. Usterek: ${row.snapshot.defects.length}</p>`,
    `<p><a class="button" href="${base}/protocol.pdf">Pobierz PDF</a></p>`,
    ...defects,
    `<h2>Podpisy</h2>`,
    ...signed,
  ];
  return publicPage(row.title, body.join("\n"));
};

protocols.get("/p/:token", async (c) => {
  const row = await sharedProtocol(c.req.param("token"));
  if (!row) return c.html(notFoundPage(), 404);
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  return c.html(protocolHtml(row, await signaturesOf(row.id), c.req.param("token")));
});

protocols.get("/p/:token/protocol.pdf", async (c) => {
  const row = await sharedProtocol(c.req.param("token"));
  if (!row) return c.html(notFoundPage(), 404);
  return pdfResponse(await pdfOf(row, publicOrigin(c)), row);
});

const jpeg = (body: Uint8Array<ArrayBuffer> | ReadableStream) =>
  new Response(body, { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" } });

// Only what is in the protocol: its photos, the spots of its defects and its signatures.
protocols.get("/p/:token/photos/:photoId", async (c) => {
  const row = await sharedProtocol(c.req.param("token"));
  const known = row?.snapshot.defects.some((defect) => defect.photos.some((photo) => photo.id === c.req.param("photoId")));
  const file = row && known ? photoFile(row.projectId, c.req.param("photoId"), "thumb") : null;
  if (!file || !(await exists(file))) return c.body(null, 404);
  return jpeg(Readable.toWeb(createReadStream(file)) as ReadableStream);
});

protocols.get("/p/:token/spots/:defectId", async (c) => {
  const row = await sharedProtocol(c.req.param("token"));
  const defect = row?.snapshot.defects.find((candidate) => candidate.id === c.req.param("defectId"));
  const image = defect ? await planCrop(defect.documentId, defect.pageNo, defect.x, defect.y) : null;
  return image ? jpeg(new Uint8Array(image)) : c.body(null, 404);
});

protocols.get("/p/:token/signatures/:role", async (c) => {
  const row = await sharedProtocol(c.req.param("token"));
  const signature = row ? (await signaturesOf(row.id)).find((candidate) => candidate.role === c.req.param("role")) : undefined;
  if (!signature) return c.body(null, 404);
  return new Response(new Uint8Array(await signaturePng(signature.strokes)), { headers: { "content-type": "image/png", "cache-control": "no-store" } });
});
