// Kookn: comments and photos on recipe pages.
// Visitors never get JavaScript: comments are inserted into the HTML here, on Cloudflare's side.

const MAX_NAME = 50;
const MAX_BODY = 2000;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const RATE_LIMIT = { posts: 5, minutes: 10 };
const MAX_PENDING = 50;
const MAX_PER_DAY = 100; // site-wide, so a flood can't fill storage even when posts go live straight away

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" && (request.method === "GET" || request.method === "HEAD")) return homePage(request, env, url);
    if (path === "/community" && (request.method === "GET" || request.method === "HEAD")) return communityPage(request, env, url);
    if (path.startsWith("/u/")) return servePhoto(path.slice(3), env);
    if (path === "/admin" || path.startsWith("/admin/")) return admin(request, env, url);
    if (path.startsWith("/recipes/")) {
      if (request.method === "POST") return postComment(request, env, url);
      if (request.method === "GET" || request.method === "HEAD") return recipePage(request, env, url);
      return new Response("Method not allowed", { status: 405 });
    }
    return env.ASSETS.fetch(request);
  },
};

// ---------- database ----------

let schemaReady = false;
async function db(env) {
  if (!schemaReady) {
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS comments (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, recipe TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', " +
        "photo TEXT, photo_w INTEGER, photo_h INTEGER, approved INTEGER NOT NULL DEFAULT 0, " +
        "visitor TEXT NOT NULL, created INTEGER NOT NULL)"
    );
    await env.DB.exec("CREATE INDEX IF NOT EXISTS comments_recipe ON comments (recipe, approved, created)");
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS admin_sessions (token_hash TEXT PRIMARY KEY, family TEXT NOT NULL, " +
        "expires INTEGER NOT NULL, revoked INTEGER, created INTEGER NOT NULL)"
    );
    await env.DB.exec("CREATE INDEX IF NOT EXISTS admin_sessions_family ON admin_sessions (family)");
    await env.DB.exec("CREATE TABLE IF NOT EXISTS admin_login_fails (visitor TEXT NOT NULL, at INTEGER NOT NULL)");
    schemaReady = true;
  }
  return env.DB;
}

// ---------- recipe pages ----------

function slugOf(url) {
  const m = url.pathname.match(/^\/recipes\/([a-z0-9-]+)\/?$/);
  return m ? m[1] : null;
}

async function recipePage(request, env, url) {
  const page = await env.ASSETS.fetch(request);
  const slug = slugOf(url);
  if (!slug || page.status !== 200 || !(page.headers.get("content-type") || "").includes("text/html")) return page;

  const { results } = await (await db(env))
    .prepare("SELECT name, body, photo, photo_w, photo_h, created FROM comments WHERE recipe = ? AND approved = 1 ORDER BY created")
    .bind(slug)
    .all();

  let html = results.map(commentHtml).join("");
  const sent = url.searchParams.get("sent");
  if (sent) {
    const msg = env.REQUIRE_APPROVAL
      ? "Thanks! Your post will show up here once it's approved."
      : "Thanks! Your post is up.";
    html += `<p><b>${msg}</b></p>\n`;
  }
  const err = url.searchParams.get("error");
  if (err && ERRORS[err]) html += `<p><b>${ERRORS[err]}</b></p>\n`;

  const headers = new Headers(page.headers);
  headers.set("Cache-Control", "no-cache");
  headers.delete("ETag");
  return new HTMLRewriter()
    .on("form[method=post]", { element(el) { if (html) el.before(html, { html: true }); } })
    .transform(new Response(page.body, { status: 200, headers }));
}

// ---------- home page highlight + timeline ----------

// Recipe titles, read from each recipe page's <h1> (cached per Worker instance).
const titles = new Map();
async function recipeTitle(env, origin, slug) {
  if (!titles.has(slug)) {
    const r = await env.ASSETS.fetch(new Request(`${origin}/recipes/${slug}`));
    const m = r.status === 200 ? (await r.text()).match(/<h1>([^<]*)<\/h1>/) : null;
    titles.set(slug, m ? m[1] : null);
  }
  return titles.get(slug);
}

// Title ("Robin's Wok" or "Robin made Wok"), comment, photo; everything links to the recipe page.
async function postCard(c, env, origin, heading, withDate, made = false) {
  const title = await recipeTitle(env, origin, c.recipe);
  if (!title) return "";
  const href = `/recipes/${c.recipe}`;
  const who = made ? `${c.name} made` : c.name.endsWith("s") ? `${c.name}’` : `${c.name}’s`;
  let out = `<article>\n  <${heading}><a href="${href}">${esc(who)} ${title}</a></${heading}>\n`;
  if (withDate) {
    const date = new Date(c.created).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Brussels" });
    out += `  <p><small><time datetime="${new Date(c.created).toISOString().slice(0, 10)}">${date}</time></small></p>\n`;
  }
  if (c.body) out += `  <p>${esc(c.body).replace(/\r?\n/g, "<br>")}</p>\n`;
  if (c.photo) out += `  <p><a href="${href}"><img src="/u/${c.photo}-640.webp" width="${Math.round(c.photo_w / 2)}" height="${Math.round(c.photo_h / 2)}" loading="lazy" alt="Photo by ${esc(c.name)}"></a></p>\n`;
  return out + "</article>\n";
}

async function withMarker(request, env, marker, build) {
  const page = await env.ASSETS.fetch(request);
  if (page.status !== 200) return page;
  let html = "";
  try { html = await build(); } catch (e) { console.error(marker, e); }
  const headers = new Headers(page.headers);
  headers.set("Cache-Control", "no-cache");
  headers.delete("ETag");
  return new HTMLRewriter()
    .onDocument({ comments(c) { if (c.text.trim() === marker) html ? c.replace(html, { html: true }) : c.remove(); } })
    .transform(new Response(page.body, { status: 200, headers }));
}

const POST_COLUMNS = "recipe, name, body, photo, photo_w, photo_h, created";

function homePage(request, env, url) {
  return withMarker(request, env, "community-highlight", async () => {
    const c = await (await db(env)).prepare(`SELECT ${POST_COLUMNS} FROM comments WHERE approved = 1 ORDER BY created DESC LIMIT 1`).first();
    const card = c ? await postCard(c, env, url.origin, "h3", false) : "";
    if (!card) return "";
    const date = new Date(c.created).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Brussels" });
    const under = `  <p><small><time datetime="${new Date(c.created).toISOString().slice(0, 10)}">${date}</time> · <a href="/community">More from the community</a></small></p>\n`;
    return `<section>\n  <h2>Community highlight</h2>\n${card.replace('loading="lazy" ', "").replace(/<\/article>\n$/, under + "</article>\n")}</section>\n`;
  });
}

function communityPage(request, env, url) {
  return withMarker(request, env, "community", async () => {
    const { results } = await (await db(env)).prepare(`SELECT ${POST_COLUMNS} FROM comments WHERE approved = 1 ORDER BY created DESC LIMIT 200`).all();
    const cards = (await Promise.all(results.map((c) => postCard(c, env, url.origin, "h3", true, true)))).join("\n");
    return cards || "<p>No posts yet. Be the first: pick a recipe and share a photo or question!</p>\n";
  });
}

const ERRORS = {
  empty: "Please write a comment or add a photo.",
  name: "Please fill in your name (max 50 characters).",
  long: "That comment is too long (max 2000 characters).",
  photo: "That photo couldn't be used. Please send a JPEG, PNG or WebP under 15 MB.",
  slow: "You've posted a lot just now. Please try again in a few minutes.",
  busy: "We can't take new posts right now. Please try again later.",
};

function commentHtml(c) {
  const date = new Date(c.created).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Brussels" });
  const iso = new Date(c.created).toISOString().slice(0, 10);
  let out = `<article>\n  <p><b>${esc(c.name)}</b> <small><time datetime="${iso}">${date}</time></small></p>\n`;
  if (c.body) out += `  <p>${esc(c.body).replace(/\r?\n/g, "<br>")}</p>\n`;
  if (c.photo) {
    out += `  <p><a href="/u/${c.photo}-1280.webp"><img src="/u/${c.photo}-640.webp" width="${c.photo_w}" height="${c.photo_h}" loading="lazy" alt="Photo by ${esc(c.name)}"></a></p>\n`;
  }
  return out + "</article>\n";
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

// ---------- posting ----------

async function postComment(request, env, url) {
  const slug = slugOf(url);
  const back = (q) => Response.redirect(`${url.origin}/recipes/${slug}?${q}#comments`, 303);
  if (!slug) return new Response("Not found", { status: 404 });

  // The recipe must exist.
  const exists = await env.ASSETS.fetch(new Request(`${url.origin}/recipes/${slug}`));
  if (exists.status !== 200) return new Response("Not found", { status: 404 });

  let form;
  try { form = await request.formData(); } catch { return back("error=photo"); }

  // Honeypot: real people never see or fill this field.
  if ((form.get("website") || "").toString().trim()) return back("sent=1");

  const name = (form.get("name") || "").toString().trim();
  const body = (form.get("body") || "").toString().trim();
  const file = form.get("photo");
  const hasPhoto = file && typeof file === "object" && file.size > 0;

  if (!name || name.length > MAX_NAME) return back("error=name");
  if (body.length > MAX_BODY) return back("error=long");
  if (!body && !hasPhoto) return back("error=empty");

  const d = await db(env);
  const visitor = await visitorId(request);
  const since = Date.now() - RATE_LIMIT.minutes * 60_000;
  const recent = await d.prepare("SELECT COUNT(*) AS n FROM comments WHERE visitor = ? AND created > ?").bind(visitor, since).first("n");
  if (recent >= RATE_LIMIT.posts) return back("error=slow");
  // Safety valve against floods: stop taking posts while too many are waiting for approval.
  const waiting = await d.prepare("SELECT COUNT(*) AS n FROM comments WHERE approved = 0").first("n");
  if (waiting >= MAX_PENDING) return back("error=busy");
  const today = await d.prepare("SELECT COUNT(*) AS n FROM comments WHERE created > ?").bind(Date.now() - 86_400_000).first("n");
  if (today >= MAX_PER_DAY) return back("error=busy");

  let photo = null, w = null, h = null;
  if (hasPhoto) {
    if (file.size > MAX_PHOTO_BYTES || !PHOTO_TYPES.includes(file.type)) return back("error=photo");
    try {
      ({ photo, w, h } = await storePhoto(file, env));
    } catch (e) {
      console.error("photo failed", e);
      return back("error=photo");
    }
  }

  await d
    .prepare("INSERT INTO comments (recipe, name, body, photo, photo_w, photo_h, approved, visitor, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(slug, name, body, photo, w, h, env.REQUIRE_APPROVAL ? 0 : 1, visitor, Date.now())
    .run();
  return back("sent=1");
}

// A daily-changing hash of the visitor's IP: enough to rate-limit, without storing the IP itself.
async function visitorId(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|${day}|kookn`));
  return [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Re-encode the upload as WebP in two sizes. Re-encoding drops the original metadata (incl. GPS location).
async function storePhoto(file, env) {
  const bytes = await file.arrayBuffer();
  const stream = () => new Blob([bytes]).stream();
  const info = await env.IMAGES.info(stream());
  if (!info || !info.width || !info.height) throw new Error("not an image");

  const key = crypto.randomUUID();
  let w640 = 640, h640 = 480;
  for (const [width, quality] of [[1280, 70], [640, 75]]) {
    const out = await env.IMAGES.input(stream())
      .transform({ width, fit: "scale-down" })
      .output({ format: "image/webp", quality });
    const data = await out.response().arrayBuffer();
    await env.PHOTOS.put(`${key}-${width}.webp`, data, { httpMetadata: { contentType: "image/webp" } });
    if (width === 640) {
      w640 = Math.min(640, info.width);
      h640 = Math.round((info.height * w640) / info.width);
    }
  }
  return { photo: key, w: w640, h: h640 };
}

// ---------- photos ----------

async function servePhoto(key, env) {
  if (!/^[0-9a-f-]{36}-(640|1280)\.webp$/.test(key)) return new Response("Not found", { status: 404 });
  const obj = await env.PHOTOS.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000, immutable" },
  });
}

// ---------- admin ----------
//
// Login gives two cookies, both HttpOnly + Secure + SameSite=Strict, only sent to /admin:
// - access token:  signed, valid 15 minutes, checked without touching the database.
// - refresh token: random, valid 30 days, stored (hashed) in D1. When the access token has expired,
//   the refresh token is swapped for a fresh pair ("rotation") and the 30 days start over.
//   If an already-used refresh token shows up again, someone copied it: that whole login is cancelled.

const ACCESS_TTL = 15 * 60_000;
const REFRESH_TTL = 30 * 86_400_000;
const ROTATION_GRACE = 60_000; // two tabs refreshing at once shouldn't log you out
const LOGIN_FAILS = { max: 5, minutes: 15 };
const COOKIE = "; Path=/admin; HttpOnly; Secure; SameSite=Strict";

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256 = async (str) => b64url(await crypto.subtle.digest("SHA-256", enc.encode(str)));
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

// Signing key derived from ADMIN_PASSWORD: changing the password logs out every session.
async function signingKey(env) {
  return crypto.subtle.importKey("raw", enc.encode(`kookn-access|${env.ADMIN_PASSWORD}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function makeAccess(env, family) {
  const payload = b64url(enc.encode(JSON.stringify({ f: family, exp: Date.now() + ACCESS_TTL })));
  const sig = b64url(await crypto.subtle.sign("HMAC", await signingKey(env), enc.encode(payload)));
  return `${payload}.${sig}`;
}
async function checkAccess(env, token) {
  const [payload, sig] = (token || "").split(".");
  if (!payload || !sig) return false;
  const expected = b64url(await crypto.subtle.sign("HMAC", await signingKey(env), enc.encode(payload)));
  if (expected.length !== sig.length || !crypto.subtle.timingSafeEqual(enc.encode(expected), enc.encode(sig))) return false;
  try {
    const { exp } = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return exp > Date.now();
  } catch { return false; }
}

function cookies(request) {
  const out = {};
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const setCookies = (access, refresh) => [
  `kookn_access=${access}${COOKIE}; Max-Age=${ACCESS_TTL / 1000}`,
  `kookn_refresh=${refresh}${COOKIE}; Max-Age=${REFRESH_TTL / 1000}`,
];
const clearCookies = () => [`kookn_access=${COOKIE}; Max-Age=0`, `kookn_refresh=${COOKIE}; Max-Age=0`];

async function newSession(env, d, family) {
  const refresh = randomToken();
  await d.prepare("INSERT INTO admin_sessions (token_hash, family, expires, created) VALUES (?, ?, ?, ?)")
    .bind(await sha256(refresh), family, Date.now() + REFRESH_TTL, Date.now()).run();
  return setCookies(await makeAccess(env, family), refresh);
}

// Ends a login for good (logout or stolen token). revoked = 1 is far in the past, so the grace window never applies.
function killFamily(d, family) {
  return d.prepare("UPDATE admin_sessions SET revoked = 1 WHERE family = ?").bind(family).run();
}

// Returns { ok, setCookie } — setCookie holds new cookies when the refresh token was rotated.
async function session(request, env, d) {
  const c = cookies(request);
  if (await checkAccess(env, c.kookn_access)) return { ok: true, setCookie: [] };
  if (!c.kookn_refresh) return { ok: false, setCookie: [] };

  const row = await d.prepare("SELECT * FROM admin_sessions WHERE token_hash = ?").bind(await sha256(c.kookn_refresh)).first();
  const now = Date.now();
  if (!row || row.expires < now) return { ok: false, setCookie: clearCookies() };
  if (row.revoked) {
    if (now - row.revoked < ROTATION_GRACE) return { ok: true, setCookie: [] };
    // Reuse of an old refresh token: assume it was stolen and end that login everywhere.
    await killFamily(d, row.family);
    return { ok: false, setCookie: clearCookies() };
  }
  await d.prepare("UPDATE admin_sessions SET revoked = ? WHERE token_hash = ?").bind(now, row.token_hash).run();
  await d.prepare("DELETE FROM admin_sessions WHERE expires < ?").bind(now).run();
  return { ok: true, setCookie: await newSession(env, d, row.family) };
}

function adminHtml(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<meta name="robots" content="noindex">
<title>${title} · Kookn</title>
<style>body{max-width:40em;margin:auto;padding:1em;line-height:1.5}img{max-width:100%;height:auto}</style>
<nav><a href="/">← Kookn</a></nav>
${body}`;
}
function htmlResponse(html, setCookie = [], status = 200) {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" });
  for (const c of setCookie) headers.append("Set-Cookie", c);
  return new Response(html, { status, headers });
}
function redirect(url, setCookie = []) {
  const headers = new Headers({ Location: url, "Cache-Control": "no-store" });
  for (const c of setCookie) headers.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers });
}

function loginPage(message = "") {
  return adminHtml("Log in", `<h1>Admin</h1>
${message ? `<p><b>${message}</b></p>\n` : ""}<form method="post" action="/admin/login">
  <input type="text" name="username" value="admin" autocomplete="username" hidden>
  <p><label>Password<br><input type="password" name="password" required autocomplete="current-password" autofocus></label></p>
  <p><button>Log in</button></p>
</form>
`);
}

async function admin(request, env, url) {
  if (!env.ADMIN_PASSWORD) {
    return new Response("Admin is off: add a secret called ADMIN_PASSWORD to this Worker in the Cloudflare dashboard.", { status: 503 });
  }
  const d = await db(env);
  const path = url.pathname.replace(/\/$/, "");

  if (request.method === "POST") {
    // Only accept forms sent from this site itself.
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return new Response("Forbidden", { status: 403 });
  }

  if (path === "/admin/login") {
    if (request.method !== "POST") return redirect(`${url.origin}/admin`);
    const visitor = await visitorId(request);
    const since = Date.now() - LOGIN_FAILS.minutes * 60_000;
    const fails = await d.prepare("SELECT COUNT(*) AS n FROM admin_login_fails WHERE visitor = ? AND at > ?").bind(visitor, since).first("n");
    if (fails >= LOGIN_FAILS.max) return htmlResponse(loginPage(`Too many attempts. Try again in ${LOGIN_FAILS.minutes} minutes.`), [], 429);

    const form = await request.formData();
    const [a, b] = await Promise.all([(form.get("password") || "").toString(), env.ADMIN_PASSWORD].map((x) => crypto.subtle.digest("SHA-256", enc.encode(x))));
    if (!crypto.subtle.timingSafeEqual(a, b)) {
      await d.prepare("INSERT INTO admin_login_fails (visitor, at) VALUES (?, ?)").bind(visitor, Date.now()).run();
      await d.prepare("DELETE FROM admin_login_fails WHERE at < ?").bind(since).run();
      return htmlResponse(loginPage("Wrong password."), [], 401);
    }
    return redirect(`${url.origin}/admin`, await newSession(env, d, randomToken()));
  }

  if (path === "/admin/logout") {
    const c = cookies(request);
    if (request.method === "POST" && c.kookn_refresh) {
      const row = await d.prepare("SELECT family FROM admin_sessions WHERE token_hash = ?").bind(await sha256(c.kookn_refresh)).first();
      if (row) await killFamily(d, row.family);
    }
    return redirect(`${url.origin}/admin`, clearCookies());
  }

  const { ok, setCookie } = await session(request, env, d);
  if (!ok) return htmlResponse(loginPage(), setCookie, 401);

  if (request.method === "POST") {
    const form = await request.formData();
    const id = Number(form.get("id"));
    const action = form.get("action");
    if (action === "approve") await d.prepare("UPDATE comments SET approved = 1 WHERE id = ?").bind(id).run();
    if (action === "hide") await d.prepare("UPDATE comments SET approved = 0 WHERE id = ?").bind(id).run();
    if (action === "delete") {
      const row = await d.prepare("SELECT photo FROM comments WHERE id = ?").bind(id).first();
      if (row && row.photo) await env.PHOTOS.delete([`${row.photo}-640.webp`, `${row.photo}-1280.webp`]);
      await d.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
    }
    return redirect(`${url.origin}/admin`, setCookie);
  }

  const pending = (await d.prepare("SELECT * FROM comments WHERE approved = 0 ORDER BY created DESC").all()).results;
  const live = (await d.prepare("SELECT * FROM comments WHERE approved = 1 ORDER BY created DESC LIMIT 50").all()).results;
  const row = (c, buttons) =>
    `<article>\n<p><a href="/recipes/${c.recipe}#comments">${esc(c.recipe)}</a></p>\n` +
    commentHtml(c).replace(/^<article>\n|<\/article>\n$/g, "") +
    buttons.map(([a, label]) => `<form method="post" style="display:inline"><input type="hidden" name="id" value="${c.id}"><button name="action" value="${a}">${label}</button></form>`).join(" ") +
    "\n<hr>\n</article>\n";

  return htmlResponse(adminHtml("Admin", `<h1>Admin</h1>
<form method="post" action="/admin/logout"><button>Log out</button></form>
<h2>Waiting for approval (${pending.length})</h2>
${pending.map((c) => row(c, [["approve", "Approve"], ["delete", "Delete"]])).join("") || "<p>Nothing waiting.</p>"}
<h2>Live (latest 50)</h2>
${live.map((c) => row(c, [["hide", "Hide"], ["delete", "Delete"]])).join("") || "<p>Nothing yet.</p>"}
`), setCookie);
}
