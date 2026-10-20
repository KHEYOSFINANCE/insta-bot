// Bot Instagram (mode polling, sans webhook) :
// commentaire contenant un mot-clé -> réponse publique + DM privé avec la ressource.
// Aucune dépendance. Node 18+ requis.  Lancer : node --env-file=.env server.js
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const { IG_ACCESS_TOKEN, IG_USER_ID, POLL_SECONDS = "45", MEDIA_LIMIT = "10" } = process.env;

for (const k of ["IG_ACCESS_TOKEN", "IG_USER_ID"]) {
  if (!process.env[k]) { console.error(`Variable manquante ou vide : ${k} (voir .env)`); process.exit(1); }
}

const GRAPH = "https://graph.instagram.com/v21.0";
const STATE_FILE = new URL("./state.json", import.meta.url);
const rules = JSON.parse(readFileSync(new URL("./rules.json", import.meta.url)));

// état persistant : commentaires déjà vus + token renouvelé
const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE))
  : { seen: [], token: null, refreshedAt: 0, baselineDone: false };
const seen = new Set(state.seen);
let token = state.token || IG_ACCESS_TOKEN;
// le token n'est sauvegardé que s'il a été renouvelé (jamais en mode RUN_ONCE, où l'état est mis en cache)
const save = () => writeFileSync(STATE_FILE, JSON.stringify({ ...state, seen: [...seen].slice(-5000) }));

const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function api(method, path, { query = {}, body } = {}) {
  const url = new URL(`${GRAPH}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json.error ?? json));
  return json;
}

async function fetchComments() {
  const media = await api("GET", `/${IG_USER_ID}/media`, { query: { fields: "id", limit: MEDIA_LIMIT } });
  const all = [];
  for (const m of media.data ?? []) {
    const c = await api("GET", `/${m.id}/comments`, { query: { fields: "id,text,username,from", limit: "50" } });
    all.push(...(c.data ?? []));
  }
  return all;
}

async function handleComment(c) {
  const rule = rules.find((r) => c.text && r.keywords.some((k) => norm(c.text).includes(norm(k))));
  if (!rule) return;
  try {
    await api("POST", `/${c.id}/replies`, { body: { message: pick(rule.publicReplies) } });
    await api("POST", `/${IG_USER_ID}/messages`, { body: { recipient: { comment_id: c.id }, message: { text: rule.dm } } });
    console.log(`OK     @${c.username} -> "${rule.keywords[0]}"`);
  } catch (e) {
    console.error(`ERREUR @${c.username} :`, e.message);
  }
}

async function tick() {
  try {
    const comments = await fetchComments();
    const fresh = comments.filter((c) => !seen.has(c.id));
    for (const c of fresh) seen.add(c.id);
    if (!state.baselineDone) {
      // 1er lancement : on ignore les commentaires existants pour ne pas spammer l'historique
      state.baselineDone = true;
      console.log(`Premier lancement : ${fresh.length} commentaires existants ignorés.`);
    } else {
      for (const c of fresh) if (c.from?.id !== IG_USER_ID && c.username) await handleComment(c);
    }
    save();
  } catch (e) {
    console.error("Erreur de lecture :", e.message);
  }
}

// le token Instagram dure ~60 jours : on le renouvelle toutes les semaines
async function refreshToken() {
  if (Date.now() - state.refreshedAt < 7 * 24 * 3600 * 1000) return;
  try {
    const u = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`;
    const j = await (await fetch(u)).json();
    if (j.access_token) { token = j.access_token; state.token = token; state.refreshedAt = Date.now(); save(); console.log("Token renouvelé."); }
  } catch { /* on réessaiera au prochain tour */ }
}

if (process.env.RUN_ONCE) {
  // mode GitHub Actions : un seul passage puis on quitte (le planificateur relance toutes les 5 min)
  await tick();
  process.exit(0);
}

console.log(`Bot démarré : vérification des commentaires toutes les ${POLL_SECONDS}s.`);
await refreshToken();
await tick();
setInterval(async () => { await refreshToken(); await tick(); }, Number(POLL_SECONDS) * 1000);
