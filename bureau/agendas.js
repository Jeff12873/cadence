// Agendas externes : lecture d'agendas au format iCal (adresse secrète Google, Nextcloud…)
// et envoi de tâches choisies vers Google Agenda (OAuth 2.0, application « ordinateur » de l'utilisateur).
//
// Rien de secret n'est stocké dans le coffre ni dans le dépôt : les adresses iCal, l'identifiant
// OAuth et le jeton de rafraîchissement restent dans la configuration locale de l'application.

const { net, shell } = require('electron');
const http = require('node:http');
const crypto = require('node:crypto');

/* ------------------------------------------------------------------ iCal */

function deplier(texte) { return texte.replace(/\r?\n[ \t]/g, ''); }
function proprietes(ligne) {
  const i = ligne.indexOf(':'); if (i < 0) return null;
  const [nom, ...params] = ligne.slice(0, i).split(';');
  const p = {}; params.forEach(x => { const [k, v] = x.split('='); p[k.toUpperCase()] = v; });
  return { nom: nom.toUpperCase(), params: p, valeur: ligne.slice(i + 1) };
}
// Date iCal → Date locale ; « allDay » pour VALUE=DATE
function lireDate(prop) {
  const v = prop.valeur.trim();
  if (/^\d{8}$/.test(v)) return { d: new Date(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8)), allDay: true };
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/); if (!m) return null;
  if (m[7]) return { d: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])), allDay: false };
  // Heure « flottante » ou avec TZID : on la prend comme heure locale (cas général : même fuseau que l'utilisateur)
  return { d: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), allDay: false };
}
const JOURS = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };
// Occurrences d'une règle RRULE (cas courants : DAILY, WEEKLY+BYDAY, MONTHLY, YEARLY, INTERVAL, COUNT, UNTIL)
function occurrences(debut, rrule, de, a, exdates) {
  const r = {}; rrule.split(';').forEach(x => { const [k, v] = x.split('='); r[k] = v; });
  const freq = r.FREQ, inter = +(r.INTERVAL || 1), max = r.COUNT ? +r.COUNT : Infinity;
  const until = r.UNTIL ? (lireDate({ valeur: r.UNTIL }) || {}).d : null;
  const byday = r.BYDAY ? r.BYDAY.split(',').map(x => JOURS[x.slice(-2)]) : null;
  const out = []; let n = 0;
  const pousse = (d) => { if (until && d > until) return false; if (n++ >= max) return false; if (d >= de && d < a && !exdates.has(+d)) out.push(new Date(d)); return true; };
  if (freq === 'WEEKLY' && byday) {
    const lundi = new Date(debut); lundi.setDate(lundi.getDate() - ((lundi.getDay() + 6) % 7));
    for (let s = 0; s < 2000; s++) {
      const base = new Date(lundi); base.setDate(lundi.getDate() + s * 7 * inter);
      if (base > a) break;
      for (let k = 0; k < 7; k++) {
        const d = new Date(base); d.setDate(base.getDate() + k);
        d.setHours(debut.getHours(), debut.getMinutes(), debut.getSeconds(), 0);
        if (d < debut || !byday.includes(d.getDay())) continue;
        if (!pousse(d)) return out;
      }
    }
    return out;
  }
  const d = new Date(debut);
  for (let k = 0; k < 5000 && d <= a; k++) {
    if (!pousse(d)) break;
    if (freq === 'DAILY') d.setDate(d.getDate() + inter);
    else if (freq === 'WEEKLY') d.setDate(d.getDate() + 7 * inter);
    else if (freq === 'MONTHLY') d.setMonth(d.getMonth() + inter);
    else if (freq === 'YEARLY') d.setFullYear(d.getFullYear() + inter);
    else break;
  }
  return out;
}
function analyserIcs(texte, de, a) {
  const lignes = deplier(texte).split(/\r?\n/), evs = [], modifies = new Map();
  let cur = null;
  for (const l of lignes) {
    if (l === 'BEGIN:VEVENT') { cur = { ex: new Set() }; continue; }
    if (l === 'END:VEVENT') { if (cur) evs.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = proprietes(l); if (!p) continue;
    if (p.nom === 'SUMMARY') cur.titre = p.valeur.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/gi, ' ');
    else if (p.nom === 'LOCATION') cur.lieu = p.valeur.replace(/\\,/g, ',').replace(/\\n/gi, ' ');
    else if (p.nom === 'DTSTART') cur.debut = lireDate(p);
    else if (p.nom === 'DTEND') cur.fin = lireDate(p);
    else if (p.nom === 'RRULE') cur.rrule = p.valeur;
    else if (p.nom === 'EXDATE') p.valeur.split(',').forEach(v => { const x = lireDate({ valeur: v }); if (x) cur.ex.add(+x.d); });
    else if (p.nom === 'UID') cur.uid = p.valeur;
    else if (p.nom === 'RECURRENCE-ID') cur.recId = lireDate(p);
    else if (p.nom === 'STATUS') cur.statut = p.valeur;
  }
  const out = [];
  // occurrences modifiées (RECURRENCE-ID) : elles remplacent l'occurrence d'origine
  evs.filter(e => e.recId).forEach(e => { if (!modifies.has(e.uid)) modifies.set(e.uid, new Set()); modifies.get(e.uid).add(+e.recId.d); });
  for (const e of evs) {
    if (!e.debut || e.statut === 'CANCELLED') continue;
    const dureeMs = e.fin ? e.fin.d - e.debut.d : (e.debut.allDay ? 864e5 : 36e5);
    const debuts = e.rrule && !e.recId ? occurrences(e.debut.d, e.rrule, new Date(+de - dureeMs), a, new Set([...e.ex, ...(modifies.get(e.uid) || [])])) : [e.debut.d];
    for (const d of debuts) {
      const f = new Date(+d + dureeMs);
      if (f <= de || d >= a) continue;
      out.push({ titre: e.titre || '(sans titre)', lieu: e.lieu || '', debut: d.toISOString(), fin: f.toISOString(), allDay: e.debut.allDay, uid: e.uid || '' });
    }
  }
  return out;
}

const cacheIcs = new Map();   // url → {t, texte}
async function lireAgendas(agendas, deIso, aIso) {
  const de = new Date(deIso), a = new Date(aIso), out = [];
  for (const ag of agendas || []) {
    if (!ag || !/^https:\/\//.test(ag.url || '')) continue;
    try {
      let c = cacheIcs.get(ag.url);
      if (!c || Date.now() - c.t > 10 * 60 * 1000) {
        const r = await net.fetch(ag.url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        c = { t: Date.now(), texte: await r.text() }; cacheIcs.set(ag.url, c);
      }
      analyserIcs(c.texte, de, a).forEach(e => out.push({ ...e, agenda: ag.nom || 'Agenda', couleur: ag.couleur || '' }));
    } catch (err) { out.push({ erreur: `${ag.nom || 'Agenda'} : ${err.message}` }); }
  }
  return out;
}

/* ------------------------------------------------------------ Google OAuth */

const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
let jeton = null;   // {acces, expire}

function connecterGoogle(g) {
  if (!g || !g.clientId || !g.clientSecret) return Promise.reject(new Error("Renseigne d'abord l'identifiant et le secret OAuth."));
  const verif = crypto.randomBytes(32).toString('base64url');
  const defi = crypto.createHash('sha256').update(verif).digest('base64url');
  const etat = crypto.randomBytes(12).toString('hex');
  return new Promise((resoudre, rejeter) => {
    const serveur = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/') { res.writeHead(404).end(); return; }
      const code = u.searchParams.get('code'), err = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h2>${code ? '✓ Cadence est connectée à Google Agenda' : 'Connexion annulée'}</h2><p>Tu peux fermer cet onglet et revenir à Cadence.</p>`);
      serveur.close();
      if (err || !code || u.searchParams.get('state') !== etat) { rejeter(new Error(err || 'Connexion annulée.')); return; }
      try {
        const r = await net.fetch('https://oauth2.googleapis.com/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ code, client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: redirection, grant_type: 'authorization_code', code_verifier: verif }).toString(),
        });
        const d = await r.json();
        if (!r.ok || !d.refresh_token) throw new Error(d.error_description || d.error || 'Pas de jeton de rafraîchissement.');
        jeton = { acces: d.access_token, expire: Date.now() + (d.expires_in - 60) * 1000 };
        resoudre(d.refresh_token);
      } catch (e) { rejeter(e); }
    });
    let redirection = '';
    serveur.listen(0, '127.0.0.1', () => {
      redirection = `http://127.0.0.1:${serveur.address().port}/`;
      const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: g.clientId, redirect_uri: redirection, response_type: 'code', scope: SCOPE,
        access_type: 'offline', prompt: 'consent', state: etat, code_challenge: defi, code_challenge_method: 'S256',
      });
      shell.openExternal(url);
    });
    setTimeout(() => { try { serveur.close(); } catch {} rejeter(new Error('Délai dépassé (5 min).')); }, 5 * 60 * 1000);
  });
}

async function acces(g) {
  if (jeton && Date.now() < jeton.expire) return jeton.acces;
  if (!g || !g.refreshToken) throw new Error("Google Agenda n'est pas connecté (⚙️ Réglages).");
  const r = await net.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, refresh_token: g.refreshToken, grant_type: 'refresh_token' }).toString(),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`Google : ${d.error_description || d.error || r.status}`);
  jeton = { acces: d.access_token, expire: Date.now() + (d.expires_in - 60) * 1000 };
  return jeton.acces;
}

// Crée ou met à jour l'évènement d'une tâche ; renvoie son identifiant. ev = {id?, titre, debut, fin, allDay, description}
async function envoyerEvenement(g, ev) {
  const cal = encodeURIComponent(g.calendarId || 'primary');
  const corps = {
    summary: ev.titre, description: ev.description || '',
    start: ev.allDay ? { date: ev.debut.slice(0, 10) } : { dateTime: ev.debut, timeZone: ev.fuseau },
    end: ev.allDay ? { date: ev.fin.slice(0, 10) } : { dateTime: ev.fin, timeZone: ev.fuseau },
    extendedProperties: { private: { cadence: '1' } },
  };
  const tok = await acces(g);
  const url = ev.id ? `https://www.googleapis.com/calendar/v3/calendars/${cal}/events/${encodeURIComponent(ev.id)}` : `https://www.googleapis.com/calendar/v3/calendars/${cal}/events`;
  let r = await net.fetch(url, { method: ev.id ? 'PATCH' : 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(corps) });
  if (ev.id && (r.status === 404 || r.status === 410)) {  // évènement supprimé dans Google : on le recrée
    r = await net.fetch(`https://www.googleapis.com/calendar/v3/calendars/${cal}/events`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(corps) });
  }
  const d = await r.json();
  if (!r.ok) throw new Error(`Google : ${(d.error && d.error.message) || r.status}`);
  return d.id;
}
async function supprimerEvenement(g, id) {
  if (!id) return;
  const tok = await acces(g);
  const r = await net.fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(g.calendarId || 'primary')}/events/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok && r.status !== 404 && r.status !== 410) throw new Error(`Google : suppression impossible (${r.status}).`);
}

// --- Rendez-vous Google (agenda connecté) : lecture et modification -------------------------
const calUrl = (g) => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(g.calendarId || 'primary')}`;
async function appelGoogle(g, url, options = {}) {
  const tok = await acces(g);
  const r = await net.fetch(url, { ...options, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  if (r.status === 204) return null;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google : ${(d.error && d.error.message) || r.status}`);
  return d;
}
const versCadence = (x) => ({
  id: x.id, uid: x.iCalUID || '', titre: x.summary || '(sans titre)', lieu: x.location || '', description: x.description || '',
  debut: x.start.dateTime || x.start.date, fin: x.end.dateTime || x.end.date, allDay: !x.start.dateTime,
  recurrent: !!x.recurringEventId, lien: x.htmlLink || '', modifiable: true,
});
async function lireGoogle(g, de, a) {
  const out = []; let page = '';
  do {
    const d = await appelGoogle(g, `${calUrl(g)}/events?` + new URLSearchParams({ timeMin: de, timeMax: a, singleEvents: 'true', orderBy: 'startTime', maxResults: '250', ...(page ? { pageToken: page } : {}) }));
    (d.items || []).filter(x => x.status !== 'cancelled' && !(x.extendedProperties && x.extendedProperties.private && x.extendedProperties.private.cadence)).forEach(x => out.push(versCadence(x)));
    page = d.nextPageToken || '';
  } while (page);
  return out;
}
const corpsRdv = (c) => {
  const o = {};
  if (c.titre !== undefined) o.summary = c.titre;
  if (c.lieu !== undefined) o.location = c.lieu;
  if (c.description !== undefined) o.description = c.description;
  if (c.debut) o.start = c.allDay ? { date: c.debut.slice(0, 10) } : { dateTime: c.debut, timeZone: c.fuseau };
  if (c.fin) o.end = c.allDay ? { date: c.fin.slice(0, 10) } : { dateTime: c.fin, timeZone: c.fuseau };
  return o;
};
const modifierRdv = async (g, id, c) => versCadence(await appelGoogle(g, `${calUrl(g)}/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(corpsRdv(c)) }));
const creerRdv = async (g, c) => versCadence(await appelGoogle(g, `${calUrl(g)}/events`, { method: 'POST', body: JSON.stringify(corpsRdv(c)) }));
const supprimerRdv = (g, id) => supprimerEvenement(g, id);

module.exports = { lireGoogle, modifierRdv, creerRdv, supprimerRdv, lireAgendas, analyserIcs, connecterGoogle, envoyerEvenement, supprimerEvenement };
