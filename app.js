/* Lecteur d'histoires à choix : interprète le graphe des packs (format STUdio : nœuds « stage » et
   « action ») comme la conteuse, avec en plus : retour en arrière, saut au prochain choix,
   réplique précédente / suivante, sous-titres, reprise, lien partageable vers un moment précis. */
"use strict";

const $app = document.getElementById("app");
const $audio = document.getElementById("audio");
const $title = document.getElementById("bar-title");
const $home = document.getElementById("btn-home");
const $share = document.getElementById("btn-share");
const $toast = document.getElementById("toast");

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M6 5v14M19 5l-9 7 9 7z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M18 5v14M5 5l9 7-9 7z"/></svg>',
  back10: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"/></svg>',
  fwd10: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v4h-4"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  skip: '<svg viewBox="0 0 24 24"><path d="M4 6l7 6-7 6zM12 6l7 6-7 6zM21 5v14"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  speaker: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
  ok: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>',
  restart: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"/></svg>',
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (t) => { t = Math.max(0, Math.floor(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* navigation privée */ } },
};
function toast(msg) {
  $toast.textContent = msg; $toast.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => $toast.classList.remove("show"), 2200);
}
const nom = (qui) => qui ? qui.charAt(0).toUpperCase() + qui.slice(1).replace(/[-_]/g, " ") : "";

let catalogue = null;
const packs = {};
async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(url); return r.json(); }
async function loadCatalogue() { return catalogue ??= await getJSON("catalogue.json"); }
async function loadPack(id) {
  if (!packs[id]) {
    const p = await getJSON(`p/${id}.json`);
    p.byId = Object.fromEntries(p.stages.map((s, i) => [s.id, { ...s, i }]));
    p.stages = p.stages.map((s) => p.byId[s.id]);
    p.promptOf = {};  // menu -> nœud question lu juste avant
    for (const st of p.stages) {
      if (st.cs.autoplay && st.ok && st.type !== "story" && !st.cs.wheel) p.promptOf[st.ok[0]] ??= st;
    }
    packs[id] = p;
  }
  return packs[id];
}

/* ------------------------------------------------------------------ graphe */
// Une position = { kind: "cover" } | { kind: "menu", action, idx, prompt } | { kind: "stage", stage } | { kind: "end" }
function isMenuStage(st) { return st && st.cs.wheel && st.type !== "cover"; }
function resolve(p, tr) {
  // transition [actionId, optionIndex] -> position (sans rien jouer)
  if (!tr) return { kind: "end" };
  const [aid, oi] = tr;
  const opts = p.actions[aid] || [];
  if (!opts.length) return { kind: "end" };
  const idx = oi < 0 || oi >= opts.length ? Math.floor(Math.random() * opts.length) : oi;
  const st = p.byId[opts[idx]];
  if (isMenuStage(st)) return { kind: "menu", action: aid, idx, prompt: p.promptOf[aid] || null, replayed: true };
  // nœud « question » lu automatiquement juste avant un menu : on affiche le menu pendant la question
  if (st.cs.autoplay && st.ok && st.type !== "story") {
    const nxt = resolve(p, st.ok);
    if (nxt.kind === "menu") return { ...nxt, prompt: st, replayed: false };
  }
  return { kind: "stage", stage: st };
}
function optionsOf(p, pos) { return (p.actions[pos.action] || []).map((id) => p.byId[id]); }
function startPos(p) { return { kind: "cover", stage: p.stages.find((s) => s.start) || p.stages[0] }; }

/* --------------------------------------------------------------- lecteur */
const S = {
  pack: null,       // pack chargé
  pos: null,        // position courante
  hist: [],         // positions précédentes (pour revenir en arrière)
  path: [],         // index choisis à chaque menu, dans l'ordre (lien partageable)
  focus: null,      // option sélectionnée dans le menu courant
  showText: store.get("texte") ?? false,
  cueIdx: -1,
};

function audioPlay(src, at = 0) {
  if (!src) { $audio.removeAttribute("src"); $audio.load(); return; }
  const url = new URL(src, location.href).href;
  if ($audio.src !== url) { $audio.src = url; }
  const go = () => { try { $audio.currentTime = at; } catch { /* pas encore prêt */ } $audio.play().catch(() => {}); };
  if ($audio.readyState >= 1) go(); else $audio.addEventListener("loadedmetadata", go, { once: true });
}

function setPos(pos, { push = true, at = 0, autoplay = true } = {}) {
  if (push && S.pos && S.pos.kind !== "end") S.hist.push({ pos: S.pos, path: S.path.length });
  S.pos = pos; S.focus = null; S.cueIdx = -1;
  render();
  const p = S.pack;
  if (pos.kind === "menu") {
    // retour sur un menu déjà vu : la conteuse redit l'option en cours, pas la question
    const prompt = pos.replayed ? optionsOf(p, pos)[pos.idx]?.audio : pos.prompt?.audio;
    if (autoplay) audioPlay(prompt || null);
    else audioPlay(null);
  } else if (pos.kind === "stage") {
    if (autoplay) audioPlay(pos.stage.audio, at);
    else { $audio.src = new URL(pos.stage.audio, location.href).href; $audio.addEventListener("loadedmetadata", () => { $audio.currentTime = at; tick(); }, { once: true }); }
    mediaSession(pos.stage);
  } else if (pos.kind === "end") {
    audioPlay(null);
  }
  save();
}

function follow(tr) { setPos(resolve(S.pack, tr)); }

function onEnded() {
  const pos = S.pos;
  if (pos?.kind === "stage") {
    const st = pos.stage;
    if (st.ok && st.cs.autoplay) follow(st.ok);
    else if (!st.ok) setPos({ kind: "end" });
    else render(); // attend « OK »
  }
}

function choose(i) {
  const pos = S.pos; const p = S.pack;
  const st = optionsOf(p, pos)[i];
  S.path.push(i);
  pos.chosen = i;
  follow(st.ok);
}

function focusOption(i) {
  const p = S.pack; const st = optionsOf(p, S.pos)[i];
  if (S.focus === i) { choose(i); return; }
  S.focus = i;
  document.querySelectorAll(".opt").forEach((el, j) => el.classList.toggle("on", j === i));
  const ok = document.getElementById("menu-ok"); if (ok) ok.disabled = false;
  audioPlay(st.audio);
}

function goBack() {
  // revient à la position précédente ; depuis une histoire, de préférence au dernier menu
  if (!S.hist.length) { setPos(startPos(S.pack), { push: false, autoplay: false }); S.path = []; return; }
  let h = S.hist.pop();
  if (S.pos.kind === "stage") {
    while (h.pos.kind === "stage" && h.pos.stage.id === S.pos.stage.id && S.hist.length) h = S.hist.pop();
  }
  S.path.length = h.path;
  setPos(h.pos, { push: false });
}

function backToCrumb(k) {
  // k = index dans S.hist d'un menu : on y retourne en oubliant la suite
  const h = S.hist[k];
  S.hist.length = k; S.path.length = h.path;
  setPos(h.pos, { push: false });
}

function skipToChoice() {
  // saute les nœuds lus automatiquement jusqu'au prochain menu (ou la fin)
  let pos = S.pos; let guard = 0;
  while (pos.kind === "stage" && guard++ < 200) {
    if (pos !== S.pos) S.hist.push({ pos, path: S.path.length });
    const st = pos.stage;
    pos = st.ok ? resolve(S.pack, st.ok) : { kind: "end" };
    if (pos.kind === "stage" && !pos.stage.cs.autoplay) break;
  }
  setPos(pos);
}

/* ------------------------------------------------------- sous-titres */
function cues() { return S.pos?.kind === "stage" ? S.pack.cues[S.pos.stage.audio] || [] : []; }
function cueAt(t) {
  const c = cues(); let k = -1;
  for (let i = 0; i < c.length; i++) { if (c[i].debut <= t + 0.05) k = i; else break; }
  return k;
}
function jumpCue(d) {
  const c = cues(); if (!c.length) { $audio.currentTime = Math.max(0, $audio.currentTime + 10 * d); return; }
  const t = $audio.currentTime; let k = cueAt(t);
  if (d < 0) { if (k >= 0 && t - c[k].debut > 1.5) { /* reprend la réplique */ } else k = Math.max(0, k - 1); }
  else k = Math.min(c.length - 1, k + 1);
  $audio.currentTime = c[Math.max(0, k)].debut; if ($audio.paused) $audio.play().catch(() => {});
}

function tick() {
  if (!S.pack || S.pos?.kind !== "stage") return;
  const t = $audio.currentTime, d = $audio.duration || 0;
  const r = document.getElementById("seek"); if (r && !r.dragging) { r.max = d || 1; r.value = t; }
  const el = document.getElementById("tcur"); if (el) el.textContent = fmt(t);
  const tot = document.getElementById("ttot"); if (tot) tot.textContent = fmt(d);
  const k = cueAt(t);
  if (k !== S.cueIdx) {
    S.cueIdx = k; const c = cues()[k];
    const sub = document.getElementById("sub");
    if (sub) sub.innerHTML = c ? `<div class="who">${esc(nom(c.qui))}</div><div class="txt">${esc(c.texte)}</div>` : "";
    document.querySelectorAll(".script li").forEach((li, j) => {
      li.classList.toggle("cur", j === k);
      if (j === k && S.showText) li.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }
  const pb = document.getElementById("pp"); if (pb) pb.innerHTML = $audio.paused ? ICON.play : ICON.pause;
  if (tick.n = (tick.n || 0) + 1, tick.n % 8 === 0) save();
}

/* ---------------------------------------------------- persistance, lien */
function hashFor(withTime = true) {
  const p = S.pack; if (!p) return "#/";
  let h = `#/p/${p.id}/${S.path.join(".") || "-"}`;
  if (S.pos?.kind === "stage") h += `/${S.pos.stage.i}` + (withTime ? `/${Math.floor($audio.currentTime || 0)}` : "");
  else if (S.pos?.kind === "menu") h += "/m";
  return h;
}
function save() {
  if (!S.pack) return;
  const h = hashFor();
  history.replaceState(null, "", h);
  if (S.pos?.kind !== "cover") store.set(`pos:${S.pack.id}`, { h, ts: Date.now() });
}
async function share() {
  const url = location.href.split("#")[0] + hashFor();
  const title = S.pos?.kind === "stage" ? S.pos.stage.name : S.pack.titre;
  try {
    if (navigator.share) { await navigator.share({ title, url }); return; }
    await navigator.clipboard.writeText(url); toast("Lien copié : ouvre-le sur l'autre téléphone");
  } catch { /* partage annulé */ }
}

function replay(p, pathStr, stageIdx, t, menu) {
  // reconstruit l'historique en rejouant les choix depuis le début, sans son
  S.pack = p; S.hist = []; S.path = [];
  const path = pathStr && pathStr !== "-" ? pathStr.split(".").map(Number) : [];
  let pos = resolve(p, startPos(p).stage.ok); let k = 0; let guard = 0;
  const target = stageIdx != null ? p.stages[stageIdx] : null;
  while (guard++ < 5000) {
    if (pos.kind === "menu") {
      if (k >= path.length) break;
      const i = path[k++]; const st = optionsOf(p, pos)[i]; if (!st) break;
      pos.chosen = i; S.hist.push({ pos, path: S.path.length }); S.path.push(i);
      pos = resolve(p, st.ok);
    } else if (pos.kind === "stage") {
      if (k >= path.length && (!target || pos.stage.id === target.id || menu)) break;
      if (!pos.stage.ok) { pos = { kind: "end" }; break; }
      S.hist.push({ pos, path: S.path.length });
      pos = resolve(p, pos.stage.ok);
    } else break;
  }
  S.pos = null;
  setPos(pos, { push: false, at: t || 0, autoplay: false });
}

/* ------------------------------------------------------------- rendu */
function crumbs() {
  const items = S.hist.map((h, k) => ({ h, k })).filter(({ h }) => h.pos.kind === "menu" && h.pos.chosen != null);
  if (!items.length) return "";
  return `<nav class="crumbs" aria-label="Choix faits">${items.map(({ h, k }) => {
    const st = optionsOf(S.pack, h.pos)[h.pos.chosen];
    return `<button class="crumb" data-k="${k}" title="Revenir à ce choix">${st.image ? `<img src="${st.image}" alt="">` : ""}<span>${esc(st.name)}</span></button>`;
  }).join("")}</nav>`;
}

function render() {
  const p = S.pack; const pos = S.pos;
  $home.hidden = false; $share.hidden = false;
  $title.textContent = p.titre; document.title = p.titre;
  let html = crumbs();
  if (pos.kind === "cover") {
    const resume = store.get(`pos:${p.id}`);
    html += `<section class="cover">
      <img src="${p.couverture}" alt="">
      <h2>${esc(p.titre)}</h2>
      <p>${esc(p.description || (p.aventure ? `Une aventure à choix, ${p.histoires} chemins possibles` : `${p.histoires} histoires à composer`))}</p>
      <div class="row">
        <button class="big" id="start">${ICON.play} Commencer</button>
        ${resume ? `<button class="ghost" id="resume">${ICON.undo} Reprendre</button>` : ""}
      </div></section>`;
  } else if (pos.kind === "menu") {
    const opts = optionsOf(p, pos);
    html += `<section class="menu">
      <h2 class="prompt">${pos.prompt ? `<button class="bar-btn" id="say-q" aria-label="Réécouter la question">${ICON.speaker}</button>` : ""}
        <span>${esc(pos.prompt?.name || "Choisis")}</span></h2>
      <div class="options">${opts.map((o, i) => `<button class="opt" data-i="${i}">
        ${o.image ? `<img src="${o.image}" alt="">` : ""}<span>${esc(o.name)}</span></button>`).join("")}</div>
      <div class="menu-ok"><button class="big" id="menu-ok" disabled>${ICON.ok} C'est parti</button></div>
      <div class="tools">${S.hist.length ? `<button class="ghost" id="back">${ICON.undo} Retour</button>` : ""}</div>
    </section>`;
  } else if (pos.kind === "stage") {
    const st = pos.stage; const c = cues();
    const waitOk = !st.cs.autoplay && st.ok && $audio.ended;
    html += `<section class="stage"><div class="stage-wrap"><div>
        ${st.image ? `<img class="pic" src="${st.image}" alt="">` : ""}
        <h2>${esc(st.name)}</h2></div><div>
        <div class="sub" id="sub" aria-live="off"></div>
        <div class="prog"><span id="tcur">0:00</span><input id="seek" type="range" min="0" step="0.1" value="0" aria-label="Position"><span id="ttot">0:00</span></div>
        <div class="ctrl">
          <button id="cprev" aria-label="Réplique précédente">${ICON.prev}</button>
          <button id="b10" class="lbl" aria-label="Reculer de 10 secondes">${ICON.back10}<small>10</small></button>
          <button id="pp" class="play" aria-label="Lecture ou pause">${ICON.pause}</button>
          <button id="f10" class="lbl" aria-label="Avancer de 10 secondes">${ICON.fwd10}<small>10</small></button>
          <button id="cnext" aria-label="Réplique suivante">${ICON.next}</button>
        </div>
        <div class="tools">
          <button class="ghost" id="back">${ICON.undo} Retour</button>
          <button class="ghost" id="skip">${ICON.skip} ${st.ok ? "Aller au prochain choix" : "Aller à la fin"}</button>
          ${c.length ? `<button class="ghost" id="txt" aria-pressed="${S.showText}">${ICON.text} Texte</button>` : ""}
          ${waitOk ? `<button class="big" id="okbtn">${ICON.ok} OK</button>` : ""}
        </div></div></div>
        ${c.length && S.showText ? `<ol class="script">${c.map((x) => `<li data-t="${x.debut}"><b>${esc(nom(x.qui))}</b>${esc(x.texte)}</li>`).join("")}</ol>` : ""}
      </section>`;
  } else {
    html += `<section class="end"><h2>Fin !</h2><div class="row">
      <button class="big" id="again">${ICON.restart} Recommencer</button>
      <a class="ghost" href="#/">Autres histoires</a></div>
      <div class="tools" style="margin-top:14px">${S.hist.length ? `<button class="ghost" id="back">${ICON.undo} Retour</button>` : ""}</div></section>`;
  }
  $app.innerHTML = html;
  bind();
  S.cueIdx = -2; tick();
}

function bind() {
  const on = (id, f) => { const el = document.getElementById(id); if (el) el.onclick = f; };
  on("start", () => { S.hist = []; S.path = []; S.pos = null; setPos(startPos(S.pack), { push: false, autoplay: false }); follow(S.pos.stage.ok); });
  on("resume", () => { const r = store.get(`pos:${S.pack.id}`); if (r) { location.hash = r.h; } });
  on("say-q", () => audioPlay(S.pos.prompt.audio));
  on("menu-ok", () => { if (S.focus != null) choose(S.focus); });
  on("back", goBack);
  on("skip", skipToChoice);
  on("again", () => { S.hist = []; S.path = []; S.pos = null; follow(startPos(S.pack).stage.ok); });
  on("okbtn", () => follow(S.pos.stage.ok));
  on("pp", () => { if ($audio.paused) $audio.play().catch(() => {}); else $audio.pause(); });
  on("b10", () => { $audio.currentTime = Math.max(0, $audio.currentTime - 10); });
  on("f10", () => { $audio.currentTime = Math.min($audio.duration || 0, $audio.currentTime + 10); });
  on("cprev", () => jumpCue(-1));
  on("cnext", () => jumpCue(1));
  on("txt", () => { S.showText = !S.showText; store.set("texte", S.showText); const t = $audio.currentTime; render(); $audio.currentTime = t; });
  document.querySelectorAll(".opt").forEach((el) => { el.onclick = () => focusOption(+el.dataset.i); });
  document.querySelectorAll(".crumb").forEach((el) => { el.onclick = () => backToCrumb(+el.dataset.k); });
  document.querySelectorAll(".script li").forEach((el) => { el.onclick = () => { $audio.currentTime = +el.dataset.t; $audio.play().catch(() => {}); }; });
  const seek = document.getElementById("seek");
  if (seek) {
    seek.oninput = () => { seek.dragging = true; document.getElementById("tcur").textContent = fmt(+seek.value); };
    seek.onchange = () => { $audio.currentTime = +seek.value; seek.dragging = false; };
  }
}

function mediaSession(st) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: st.name, artist: S.pack.titre,
      artwork: st.image ? [{ src: new URL(st.image, location.href).href, sizes: "320x240", type: "image/webp" }] : [],
    });
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", () => $audio.play());
    ms.setActionHandler("pause", () => $audio.pause());
    ms.setActionHandler("previoustrack", () => jumpCue(-1));
    ms.setActionHandler("nexttrack", () => jumpCue(1));
    ms.setActionHandler("seekbackward", () => { $audio.currentTime = Math.max(0, $audio.currentTime - 10); });
    ms.setActionHandler("seekforward", () => { $audio.currentTime += 10; });
  } catch { /* navigateur sans Media Session complète */ }
}

/* ---------------------------------------------------------- catalogue */
async function showCatalogue() {
  $audio.pause(); S.pack = null; S.pos = null;
  const c = await loadCatalogue();
  $title.textContent = c.titre; document.title = c.titre;
  $home.hidden = true; $share.hidden = true;
  $app.innerHTML = `<div class="grid">${c.packs.map((p) => {
    const r = store.get(`pos:${p.id}`);
    return `<a class="pack" href="${r ? r.h : `#/p/${p.id}`}">
      <img src="${p.couverture}" alt="" loading="lazy">
      <span class="t">${esc(p.titre)}</span>
      <span class="s">${p.aventure ? `Aventure · ${p.histoires} chemins` : `${p.histoires} histoires`}</span>
      ${r ? `<span class="resume">Reprendre</span>` : ""}</a>`;
  }).join("")}</div>
  <p class="foot"><a href="#/credits">Crédits</a></p>`;
}

async function showCredits() {
  $audio.pause(); S.pack = null; S.pos = null;
  const c = await loadCatalogue();
  $title.textContent = "Crédits"; $home.hidden = false; $share.hidden = true;
  const src = c.sources || {};
  const fs = c.sons.filter((s) => s.source === "freesound");
  const gen = [...new Set(c.sons.filter((s) => src[s.source]).map((s) => s.source))];
  $app.innerHTML = `<section class="credits">
    <p>Histoires écrites pour des enfants de 4 à 6 ans. Voix, illustrations et musiques générées par ordinateur avec des modèles ouverts.</p>
    <h2>Modèles</h2><ul>${c.modeles.map((m) => `<li>${esc(m.quoi)} : <a href="${esc(m.url)}" rel="noopener">${esc(m.nom)}</a>, ${esc(m.licence)}</li>`).join("")}
    ${gen.map((g) => `<li>Sons et musiques : <a href="${esc(src[g].url)}" rel="noopener">${esc(src[g].nom)}</a>, ${esc(src[g].licence)}</li>`).join("")}</ul>
    ${fs.length ? `<h2>Bruitages (Freesound, domaine public CC0)</h2><ul>${fs.map((s) => `<li><a href="${esc(s.url)}" rel="noopener">${esc(s.nom)}</a> par ${esc(s.auteur)}</li>`).join("")}</ul>` : ""}
    <h2>Ce site</h2><p>Aucune publicité, aucun cookie, aucune mesure d'audience. La position d'écoute est gardée seulement dans ce navigateur.</p>
  </section>`;
}

/* ------------------------------------------------------------ routes */
async function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  try {
    if (parts[0] === "p" && parts[1]) {
      const p = await loadPack(parts[1]);
      const [, , path, st, t] = parts;
      const same = S.pack === p && hashFor() === location.hash;
      if (same) return;
      if (path === undefined) { S.pack = p; S.hist = []; S.path = []; S.pos = null; setPos(startPos(p), { push: false, autoplay: false }); }
      else replay(p, path, st === "m" || st === undefined ? null : +st, t ? +t : 0, st === "m");
      $app.focus({ preventScroll: true });
    } else if (parts[0] === "credits") await showCredits();
    else await showCatalogue();
  } catch (e) {
    console.error(e);
    $app.innerHTML = `<p>Cette histoire est introuvable. <a href="#/">Retour aux histoires</a></p>`;
  }
  window.scrollTo(0, 0);
}

$audio.addEventListener("timeupdate", tick);
$audio.addEventListener("play", tick);
$audio.addEventListener("pause", () => { tick(); save(); });
$audio.addEventListener("ended", onEnded);
$share.onclick = share;
window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => { if (document.hidden) save(); });
route();
