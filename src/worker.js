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

// ---------- home page: latest post as "Community highlight" ----------

async function homePage(request, env, url) {
  const page = await env.ASSETS.fetch(request);
  if (page.status !== 200) return page;

  let html = "";
  try {
    const c = await (await db(env))
      .prepare("SELECT recipe, name, body, photo, photo_w, photo_h FROM comments WHERE approved = 1 ORDER BY created DESC LIMIT 1")
      .first();
    if (c) {
      const recipe = await env.ASSETS.fetch(new Request(`${url.origin}/recipes/${c.recipe}`));
      const m = recipe.status === 200 ? (await recipe.text()).match(/<h1>([^<]*)<\/h1>/) : null;
      if (m) {
        const href = `/recipes/${c.recipe}`;
        const who = c.name.endsWith("s") ? `${c.name}’` : `${c.name}’s`;
        html = `<section>\n  <h2>Community highlight</h2>\n  <h3><a href="${href}">${esc(who)} ${m[1]}</a></h3>\n`;
        if (c.body) html += `  <p>${esc(c.body).replace(/\r?\n/g, "<br>")}</p>\n`;
        if (c.photo) html += `  <p><a href="${href}"><img src="/u/${c.photo}-640.webp" width="${Math.round(c.photo_w / 2)}" height="${Math.round(c.photo_h / 2)}" alt="Photo by ${esc(c.name)}"></a></p>\n`;
        html += "</section>\n";
      }
    }
  } catch (e) {
    console.error("highlight failed", e); // never break the home page over this
  }

  const headers = new Headers(page.headers);
  headers.set("Cache-Control", "no-cache");
  headers.delete("ETag");
  return new HTMLRewriter()
    .onDocument({ comments(c) { if (c.text.trim() === "community-highlight") html ? c.replace(html, { html: true }) : c.remove(); } })
    .transform(new Response(page.body, { status: 200, headers }));
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

async function admin(request, env, url) {
  if (!env.ADMIN_PASSWORD) {
    return new Response("Admin is off: add a secret called ADMIN_PASSWORD to this Worker in the Cloudflare dashboard.", { status: 503 });
  }
  if (!(await authorized(request, env))) {
    return new Response("Login required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Kookn admin", charset="UTF-8"' } });
  }
  const d = await db(env);

  if (request.method === "POST") {
    // Only accept posts made from this site's own admin page.
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return new Response("Forbidden", { status: 403 });
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
    return Response.redirect(`${url.origin}/admin`, 303);
  }

  const pending = (await d.prepare("SELECT * FROM comments WHERE approved = 0 ORDER BY created DESC").all()).results;
  const live = (await d.prepare("SELECT * FROM comments WHERE approved = 1 ORDER BY created DESC LIMIT 50").all()).results;
  const row = (c, buttons) =>
    `<article>\n<p><a href="/recipes/${c.recipe}#comments">${esc(c.recipe)}</a></p>\n` +
    commentHtml(c).replace(/^<article>\n|<\/article>\n$/g, "") +
    buttons.map(([a, label]) => `<form method="post" style="display:inline"><input type="hidden" name="id" value="${c.id}"><button name="action" value="${a}">${label}</button></form>`).join(" ") +
    "\n<hr>\n</article>\n";

  const html = `<!DOCTYPE html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<meta name="robots" content="noindex">
<title>Admin · Kookn</title>
<style>body{max-width:40em;margin:auto;padding:1em;line-height:1.5}img{max-width:100%;height:auto}</style>
<nav><a href="/">← Kookn</a></nav>
<h1>Admin</h1>
<h2>Waiting for approval (${pending.length})</h2>
${pending.map((c) => row(c, [["approve", "Approve"], ["delete", "Delete"]])).join("") || "<p>Nothing waiting.</p>"}
<h2>Live (latest 50)</h2>
${live.map((c) => row(c, [["hide", "Hide"], ["delete", "Delete"]])).join("") || "<p>Nothing yet.</p>"}
`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

async function authorized(request, env) {
  const h = request.headers.get("Authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  let pass = "";
  try { pass = atob(h.slice(6)).split(":").slice(1).join(":"); } catch { return false; }
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([pass, env.ADMIN_PASSWORD].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}
