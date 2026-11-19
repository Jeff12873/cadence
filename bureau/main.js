// Cadence — application de bureau (Electron).
// Une fenêtre qui affiche index.html, plus un pont vers le coffre Obsidian choisi par l'utilisateur :
// lecture des tâches TaskNotes, suivi en direct, et quelques écritures précises
// (cocher une ligne de checklist, fixer le jour planifié, créer une tâche, enregistrer la semaine type).
//
// Rien de personnel n'est stocké dans l'application : le chemin du coffre vit dans le dossier
// de configuration de l'utilisateur, la semaine type dans un fichier du coffre.

const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const agendas = require('./agendas');

const RACINE = path.join(__dirname, '..');
const FICHIER_CONFIG = () => path.join(app.getPath('userData'), 'config.json');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'coffre', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// --- Configuration (chemin du coffre, fichier de données) ---------------------

let config = { coffre: null, donnees: 'Cadence.json' };

function chargerConfig() {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(FICHIER_CONFIG(), 'utf8')) }; } catch { /* premier lancement */ }
}
async function enregistrerConfig() {
  await fsp.mkdir(path.dirname(FICHIER_CONFIG()), { recursive: true });
  await ecrireAtomique(FICHIER_CONFIG(), JSON.stringify(config, null, 2));
}

// Réglages du plugin TaskNotes du coffre : dossier des tâches, identification, champs, priorités.
function reglagesTaskNotes() {
  const defaut = {
    dossier: 'TaskNotes/Tasks', methode: 'tag', tag: 'task', propriete: '', valeur: '',
    statutParDefaut: 'open', prioriteParDefaut: 'normal', priorites: [], statuts: [], champs: {},
  };
  if (!config.coffre) return defaut;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(config.coffre, '.obsidian/plugins/tasknotes/data.json'), 'utf8'));
    return {
      dossier: d.tasksFolder || defaut.dossier,
      methode: d.taskIdentificationMethod || 'tag',
      tag: d.taskTag || 'task',
      propriete: d.taskPropertyName || '',
      valeur: d.taskPropertyValue || '',
      statutParDefaut: d.defaultTaskStatus || 'open',
      prioriteParDefaut: d.defaultTaskPriority || 'normal',
      priorites: (d.customPriorities || []).map(p => ({ valeur: p.value, libelle: p.label || p.value, couleur: p.color })),
      statuts: (d.customStatuses || []).map(s => ({ valeur: s.value, libelle: s.label || s.value, termine: !!s.isCompleted })),
      champs: d.fieldMapping || {},
    };
  } catch {
    return defaut;
  }
}
const champ = (tn, nom) => (tn.champs && tn.champs[nom]) || nom;

// --- Chemins autorisés --------------------------------------------------------

function dossierTaches() {
  if (!config.coffre) throw new Error('Aucun coffre Obsidian choisi.');
  return path.join(config.coffre, reglagesTaskNotes().dossier);
}
function fichierTache(nom) {
  if (typeof nom !== 'string' || !nom || /[\\/]/.test(nom) || nom.startsWith('.')) throw new Error('Nom de tâche invalide.');
  return path.join(dossierTaches(), nom.endsWith('.md') ? nom : nom + '.md');
}
function fichierDonnees() {
  if (!config.coffre) throw new Error('Aucun coffre Obsidian choisi.');
  const f = path.normalize(path.join(config.coffre, config.donnees || 'Cadence.json'));
  if (!f.startsWith(path.normalize(config.coffre) + path.sep) || !f.endsWith('.json')) throw new Error('Fichier de données invalide.');
  return f;
}

// Écriture « atomique » : fichier temporaire puis renommage, pour ne jamais laisser
// un fichier à moitié écrit dans un dossier synchronisé (Syncthing, Nextcloud…).
async function ecrireAtomique(chemin, contenu) {
  const temporaire = path.join(path.dirname(chemin), `.${path.basename(chemin)}.cadence-tmp`);
  await fsp.writeFile(temporaire, contenu);
  await fsp.rename(temporaire, chemin);
}

// --- Frontmatter YAML : modifications ligne à ligne, sans réécrire le reste ----

const RE_FM = /^---\r?\n([\s\S]*?)\r?\n---/;

function changerCle(texte, cle, valeur) {
  const m = texte.match(RE_FM);
  if (!m) throw new Error('Tâche sans frontmatter.');
  const lignes = m[1].split(/\r?\n/);
  const i = lignes.findIndex(l => l.startsWith(cle + ':'));
  if (i >= 0) {
    let j = i + 1;
    while (j < lignes.length && /^\s+\S/.test(lignes[j])) j++;   // valeurs en liste ou indentées
    lignes.splice(i, j - i, ...(valeur == null ? [] : [`${cle}: ${valeur}`]));
  } else if (valeur != null) {
    lignes.push(`${cle}: ${valeur}`);
  }
  return texte.replace(m[0], '---\n' + lignes.join('\n') + '\n---');
}

// Rappels TaskNotes : on garde ceux qui ne dépendent pas de la date prévue, et on (re)met « 30 min avant » si elle a une heure
const RAPPEL_AVANT = '-PT30M';
function regleRappel(texte, tn, valeur) {
  const m = texte.match(RE_FM); if (!m) return texte;
  const cle = champ(tn, 'reminders'), lignes = m[1].split(/\r?\n/);
  const i = lignes.findIndex(l => l.startsWith(cle + ':'));
  const items = [];
  if (i >= 0) {
    let j = i + 1, cur = null;
    while (j < lignes.length && /^\s+\S/.test(lignes[j])) {
      if (/^\s+-\s/.test(lignes[j])) { cur = [lignes[j]]; items.push(cur); } else if (cur) cur.push(lignes[j]);
      j++;
    }
    lignes.splice(i, j - i);
  }
  const autres = items.filter(it => !it.some(l => /relatedTo:\s*scheduled/.test(l)));
  if (valeur && /T\d{2}:\d{2}$/.test(valeur)) {
    autres.push([`  - id: rem_${Date.now()}`, '    type: relative', '    relatedTo: scheduled', `    offset: ${RAPPEL_AVANT}`, '    description: Cadence']);
  }
  if (autres.length) lignes.push(`${cle}:`, ...autres.flat());
  return texte.replace(m[0], '---\n' + lignes.join('\n') + '\n---');
}

function maintenant() {
  const d = new Date(), z = -d.getTimezoneOffset(), s = z >= 0 ? '+' : '-', p = n => String(Math.abs(n)).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000${s}${p(Math.trunc(z / 60))}:${p(z % 60)}`;
}
const yamlTexte = (v) => /^[\w\- .àâäéèêëîïôöùûüç'/]+$/i.test(v) && !/^\d/.test(v) ? v : JSON.stringify(v);

async function lireVerifie(nom, mtimeAttendu) {
  const chemin = fichierTache(nom);
  const info = await fsp.stat(chemin);
  if (mtimeAttendu && Math.abs(info.mtimeMs - mtimeAttendu) > 1) {
    const e = new Error('La tâche a été modifiée ailleurs entre-temps : la liste est rechargée, réessaie.');
    e.modifie = true; throw e;
  }
  return { chemin, texte: await fsp.readFile(chemin, 'utf8') };
}

// --- IPC ----------------------------------------------------------------------

ipcMain.handle('config', () => {
  const tn = reglagesTaskNotes();
  return {
    coffre: config.coffre, nomCoffre: config.coffre ? path.basename(config.coffre) : null,
    donnees: config.donnees, tasknotes: tn,
  };
});

ipcMain.handle('choisir-coffre', async (evenement) => {
  const fenetre = BrowserWindow.fromWebContents(evenement.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(fenetre, {
    title: 'Choisir le dossier du coffre Obsidian', properties: ['openDirectory'],
    defaultPath: config.coffre || app.getPath('home'),
  });
  if (canceled || !filePaths[0]) return null;
  if (!fs.existsSync(path.join(filePaths[0], '.obsidian'))) {
    throw new Error("Ce dossier n'est pas un coffre Obsidian (pas de dossier .obsidian).");
  }
  config.coffre = filePaths[0];
  await enregistrerConfig();
  surveiller();
  return config.coffre;
});

ipcMain.handle('regler-donnees', async (evenement, relatif) => {
  if (typeof relatif !== 'string' || !relatif.endsWith('.json') || relatif.includes('..')) throw new Error('Chemin invalide (un fichier .json dans le coffre).');
  config.donnees = relatif.replace(/^\/+/, '');
  await enregistrerConfig();
  surveiller();
  return config.donnees;
});

ipcMain.handle('lire-donnees', async () => {
  try { return JSON.parse(await fsp.readFile(fichierDonnees(), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' || !config.coffre) return null; throw e; }
});

ipcMain.handle('ecrire-donnees', async (evenement, donnees) => {
  const f = fichierDonnees();
  await fsp.mkdir(path.dirname(f), { recursive: true });
  dernierEcritDonnees = Date.now();
  await ecrireAtomique(f, JSON.stringify(donnees, null, 2) + '\n');
});

ipcMain.handle('lire-taches', async () => {
  if (!config.coffre) return [];
  const dossier = dossierTaches();
  let noms = [];
  try { noms = await fsp.readdir(dossier); } catch { return []; }
  const fichiers = [];
  for (const nom of noms) {
    if (!nom.endsWith('.md') || nom.includes('sync-conflict') || nom.startsWith('.')) continue;
    try {
      const chemin = path.join(dossier, nom);
      const [texte, info] = await Promise.all([fsp.readFile(chemin, 'utf8'), fsp.stat(chemin)]);
      fichiers.push({ name: nom, text: texte, mtime: info.mtimeMs });
    } catch { /* fichier en cours de synchronisation : il reviendra au prochain changement */ }
  }
  return fichiers;
});

// Cocher / décocher la n-ième case « - [ ] » du corps de la tâche
ipcMain.handle('cocher', async (evenement, nom, index, fait, mtime) => {
  const { chemin, texte } = await lireVerifie(nom, mtime);
  const m = texte.match(RE_FM);
  const debut = m ? m[0].length : 0;
  const lignes = texte.slice(debut).split('\n');
  let n = -1;
  for (let i = 0; i < lignes.length; i++) {
    if (/^\s*- \[( |x|X)\]/.test(lignes[i]) && ++n === index) {
      lignes[i] = lignes[i].replace(/- \[( |x|X)\]/, fait ? '- [x]' : '- [ ]');
      let nouveau = texte.slice(0, debut) + lignes.join('\n');
      nouveau = changerCle(nouveau, champ(reglagesTaskNotes(), 'dateModified'), maintenant());
      await ecrireAtomique(chemin, nouveau);
      return true;
    }
  }
  throw new Error('Ligne de checklist introuvable : la liste est rechargée.');
});

// Fixer (ou retirer) le jour planifié : AAAA-MM-JJ ou AAAA-MM-JJTHH:MM
ipcMain.handle('planifier', async (evenement, nom, valeur, mtime) => {
  if (valeur != null && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(valeur)) throw new Error('Date invalide.');
  const tn = reglagesTaskNotes();
  const { chemin, texte } = await lireVerifie(nom, mtime);
  let nouveau = changerCle(texte, champ(tn, 'scheduled'), valeur);
  nouveau = regleRappel(nouveau, tn, valeur);
  nouveau = changerCle(nouveau, champ(tn, 'dateModified'), maintenant());
  await ecrireAtomique(chemin, nouveau);
  return true;
});

// Remplacer la n-ième case « - [ ] » du corps par un simple lien (ligne extraite en tâche)
ipcMain.handle('remplacer-ligne', async (evenement, nom, index, lien, mtime) => {
  if (typeof lien !== 'string' || /[\n\r]/.test(lien)) throw new Error('Lien invalide.');
  const { chemin, texte } = await lireVerifie(nom, mtime);
  const m = texte.match(RE_FM), debut = m ? m[0].length : 0;
  const lignes = texte.slice(debut).split('\n');
  let n = -1;
  for (let i = 0; i < lignes.length; i++) {
    const c = lignes[i].match(/^(\s*)- \[( |x|X)\]/);
    if (c && ++n === index) {
      lignes[i] = `${c[1]}- → ${lien}`;
      let nouveau = texte.slice(0, debut) + lignes.join('\n');
      nouveau = changerCle(nouveau, champ(reglagesTaskNotes(), 'dateModified'), maintenant());
      await ecrireAtomique(chemin, nouveau);
      return true;
    }
  }
  throw new Error('Ligne de checklist introuvable.');
});

// Remplace une clé de liste du frontmatter (ou la retire si la liste est vide)
function changerListe(texte, cle, valeurs) {
  const m = texte.match(RE_FM); if (!m) throw new Error('Tâche sans frontmatter.');
  const lignes = m[1].split(/\r?\n/);
  const i = lignes.findIndex(l => l.startsWith(cle + ':'));
  const bloc = valeurs.length ? [`${cle}:`, ...valeurs.map(v => `  - ${v}`)] : [];
  if (i >= 0) { let j = i + 1; while (j < lignes.length && /^\s+\S/.test(lignes[j])) j++; lignes.splice(i, j - i, ...bloc); }
  else lignes.push(...bloc);
  return texte.replace(m[0], '---\n' + lignes.join('\n') + '\n---');
}
function lireListe(texte, cle) {
  const m = texte.match(RE_FM); if (!m) return [];
  const lignes = m[1].split(/\r?\n/), i = lignes.findIndex(l => l.startsWith(cle + ':'));
  if (i < 0) return [];
  const enLigne = lignes[i].slice(cle.length + 1).trim();
  if (enLigne.startsWith('[')) return enLigne.slice(1, -1).split(',').map(x => x.trim()).filter(Boolean);
  const out = []; for (let j = i + 1; j < lignes.length && /^\s+\S/.test(lignes[j]); j++) { const v = lignes[j].match(/^\s+-\s+(.*)$/); if (v) out.push(v[1].trim()); }
  return out;
}

// Modifier une tâche depuis Cadence : catégorie, projet, lieu, priorité, date prévue, puis titre (avec les liens)
ipcMain.handle('modifier-tache', async (evenement, nom, c, mtime) => {
  const tn = reglagesTaskNotes();
  const { chemin, texte } = await lireVerifie(nom, mtime);
  let t = texte;
  // tags : le tag d'identification TaskNotes et « archived » sont conservés
  const garder = lireListe(t, 'tags').filter(x => { const v = x.replace(/^["']|["']$/g, ''); return v === 'archived' || (tn.methode === 'tag' && v === tn.tag); });
  t = changerListe(t, 'tags', [...garder, ...(c.tags || []).filter(Boolean).map(yamlTexte)]);
  // projets : les liens vers des tâches (sous-tâches) sont conservés, le projet choisi remplace les autres
  const cleP = champ(tn, 'projects'), dossier = path.dirname(chemin);
  const parents = lireListe(t, cleP).filter(x => { const n = x.replace(/^["']|["']$/g, '').replace(/^\[\[|\]\]$/g, '').split('|')[0]; return fs.existsSync(path.join(dossier, n + '.md')); });
  t = changerListe(t, cleP, [...parents, ...(c.projets || []).filter(Boolean).map(p => `"[[${p}]]"`)]);
  t = changerListe(t, champ(tn, 'contexts'), (c.contextes || []).map(x => String(x).replace(/^@/, '').trim()).filter(Boolean).map(yamlTexte));
  if (c.priorite) t = changerCle(t, champ(tn, 'priority'), yamlTexte(c.priorite));
  if (c.google === true && !/^cadenceGoogle:/m.test((t.match(RE_FM) || ['', ''])[1])) t = changerCle(t, 'cadenceGoogle', 'oui');
  if (c.google === false) t = changerCle(t, 'cadenceGoogle', null);
  if (c.planifie !== undefined) {
    if (c.planifie != null && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(c.planifie)) throw new Error('Date invalide.');
    t = changerCle(t, champ(tn, 'scheduled'), c.planifie);
    t = regleRappel(t, tn, c.planifie);
  }
  t = changerCle(t, champ(tn, 'dateModified'), maintenant());
  await ecrireAtomique(chemin, t);
  // renommage en dernier
  const titre = String(c.titre || '').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  const ancien = path.basename(chemin, '.md');
  if (titre && titre !== ancien) {
    const dest = fichierTache(titre);
    if (fs.existsSync(dest)) throw new Error('Les informations sont enregistrées, mais une tâche porte déjà ce nom : titre inchangé.');
    let t2 = await fsp.readFile(chemin, 'utf8');
    t2 = changerCle(t2, champ(tn, 'title'), yamlTexte(titre));
    await ecrireAtomique(chemin, t2);
    await fsp.rename(chemin, dest);
    return { nom: titre, liens: await majLiens(ancien, titre) };
  }
  return { nom: ancien, liens: 0 };
});

// Rattacher une tâche à une tâche parente (lien dans ses projets, comme les sous-tâches TaskNotes)
ipcMain.handle('ajouter-parent', async (evenement, nom, parent, mtime) => {
  if (typeof parent !== 'string' || !parent || /[\]\[\n\r"|]/.test(parent)) throw new Error('Tâche parente invalide.');
  const tn = reglagesTaskNotes(), cleP = champ(tn, 'projects');
  const { chemin, texte } = await lireVerifie(nom, mtime);
  const liste = lireListe(texte, cleP);
  if (liste.some(x => x.replace(/^["']|["']$/g, '').replace(/^\[\[|\]\]$/g, '').split('|')[0] === parent)) return true;
  let t = changerListe(texte, cleP, [...liste, `"[[${parent}]]"`]);
  t = changerCle(t, champ(tn, 'dateModified'), maintenant());
  await ecrireAtomique(chemin, t);
  return true;
});

// Recherche dans les notes du coffre (titre puis contenu), hors dossiers cachés et dossier des tâches
ipcMain.handle('chercher-notes', async (evenement, q) => {
  if (!config.coffre || typeof q !== 'string') return [];
  const mots = q.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\s+/).filter(Boolean);
  if (!mots.length) return [];
  const sans = (x) => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const racine = path.normalize(config.coffre), taches = path.normalize(dossierTaches());
  const out = []; let vus = 0;
  async function parcourir(d) {
    if (out.length >= 40 || vus > 6000) return;
    let ents = []; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (path.normalize(f) !== taches) await parcourir(f); continue; }
      if (!e.name.endsWith('.md') || e.name.includes('sync-conflict')) continue;
      vus++;
      const nom = e.name.slice(0, -3), rel = path.relative(racine, d).split(path.sep).join('/');
      const titreOk = mots.every(m => sans(nom).includes(m));
      let extrait = '', score = titreOk ? 2 : 0;
      if (!titreOk) {
        try {
          const st = await fsp.stat(f); if (st.size > 300000) continue;
          const txt = await fsp.readFile(f, 'utf8'), bas = sans(txt);
          if (!mots.every(m => bas.includes(m))) continue;
          const i = bas.indexOf(mots[0]); extrait = txt.slice(Math.max(0, i - 40), i + 80).replace(/\s+/g, ' ').trim(); score = 1;
        } catch { continue; }
      }
      if (score) out.push({ nom, dossier: rel, extrait, score });
      if (out.length >= 40) return;
    }
  }
  await parcourir(racine);
  return out.sort((a, b) => b.score - a.score || a.nom.localeCompare(b.nom, 'fr'));
});

// Valider une tâche (statut « terminé » de TaskNotes + date de fin). Les tâches récurrentes restent
// à valider dans TaskNotes ou TaskForge, qui gèrent les occurrences et l'archivage.
ipcMain.handle('terminer', async (evenement, nom, mtime) => {
  const tn = reglagesTaskNotes();
  const { chemin, texte } = await lireVerifie(nom, mtime);
  const m = texte.match(RE_FM);
  if (m && new RegExp(`^${champ(tn, 'recurrence')}:\\s*\\S`, 'm').test(m[1])) {
    throw new Error('Tâche récurrente : valide cette occurrence dans TaskForge ou Obsidian.');
  }
  const cle = champ(tn, 'status');
  const ancien = m && (m[1].match(new RegExp(`^${cle}:\\s*(.*)$`, 'm')) || [])[1];
  const fini = (tn.statuts.find(x => x.termine) || { valeur: 'done' }).valeur;
  const d = new Date(), p = n => String(n).padStart(2, '0');
  let nouveau = changerCle(texte, cle, yamlTexte(fini));
  nouveau = changerCle(nouveau, champ(tn, 'completedDate'), `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
  nouveau = changerCle(nouveau, champ(tn, 'dateModified'), maintenant());
  await ecrireAtomique(chemin, nouveau);
  return { ancien: ancien ? ancien.trim() : yamlTexte(tn.statutParDefaut) };
});

// Annuler une validation : remet l'ancien statut et retire la date de fin
ipcMain.handle('rouvrir', async (evenement, nom, ancien) => {
  const tn = reglagesTaskNotes();
  const { chemin, texte } = await lireVerifie(nom);
  if (typeof ancien !== 'string' || /[\n\r]/.test(ancien)) throw new Error('Statut invalide.');
  let nouveau = changerCle(texte, champ(tn, 'status'), ancien);
  nouveau = changerCle(nouveau, champ(tn, 'completedDate'), null);
  nouveau = changerCle(nouveau, champ(tn, 'dateModified'), maintenant());
  await ecrireAtomique(chemin, nouveau);
  return true;
});

// Créer une tâche TaskNotes
ipcMain.handle('creer-tache', async (evenement, t) => {
  const tn = reglagesTaskNotes();
  const titre = String(t.titre || '').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!titre) throw new Error('Il faut un titre.');
  const chemin = fichierTache(titre);
  if (fs.existsSync(chemin)) throw new Error('Une tâche porte déjà ce nom.');
  const tags = [...(t.tags || [])].filter(Boolean);
  if (tn.methode === 'tag' && tn.tag && !tags.includes(tn.tag)) tags.unshift(tn.tag);
  const l = [
    `${champ(tn, 'status')}: ${yamlTexte(tn.statutParDefaut)}`,
    `${champ(tn, 'priority')}: ${yamlTexte(t.priorite || tn.prioriteParDefaut)}`,
  ];
  if (t.planifie) l.push(`${champ(tn, 'scheduled')}: ${t.planifie}`);
  if (t.planifie && /T\d{2}:\d{2}$/.test(t.planifie)) l.push(`${champ(tn, 'reminders')}:`, `  - id: rem_${Date.now()}`, '    type: relative', '    relatedTo: scheduled', `    offset: ${RAPPEL_AVANT}`, '    description: Cadence');
  l.push(`${champ(tn, 'dateCreated')}: ${maintenant()}`);
  if (tn.methode === 'property' && tn.propriete) l.push(`${tn.propriete}: ${JSON.stringify(tn.valeur)}`);
  if (tags.length) l.push('tags:', ...tags.map(x => `  - ${yamlTexte(x)}`));
  if ((t.projets || []).length) l.push(`${champ(tn, 'projects')}:`, ...t.projets.map(p => `  - "[[${p}]]"`));
  const bloque = (t.bloquePar || []).filter(x => typeof x === 'string' && x && !/[\]\[\n\r"]/.test(x));
  if (bloque.length) l.push(`${champ(tn, 'blockedBy')}:`, ...bloque.flatMap(b => [`  - uid: "[[${b}]]"`, '    reltype: FINISHTOSTART']));
  const ctx = (t.contextes || []).map(c => String(c).replace(/^@/, '').trim()).filter(Boolean);
  if (ctx.length) l.push(`${champ(tn, 'contexts')}:`, ...ctx.map(c => `  - ${yamlTexte(c)}`));
  if (t.google) l.push('cadenceGoogle: oui');
  l.push(`${champ(tn, 'title')}: ${yamlTexte(titre)}`);
  const corps = t.note ? `\n${String(t.note).trim()}\n` : '';
  await fsp.mkdir(path.dirname(chemin), { recursive: true });
  await fsp.writeFile(chemin, `---\n${l.join('\n')}\n---\n${corps}`, { flag: 'wx' });
  return path.basename(chemin, '.md');
});

// --- Notes (daily) ------------------------------------------------------------

function dossierNotes(relatif) {
  if (!config.coffre) throw new Error('Aucun coffre Obsidian choisi.');
  const rel = String(relatif || '').replace(/^\/+|\/+$/g, '');
  if (rel.includes('..')) throw new Error('Dossier invalide.');
  const d = path.normalize(path.join(config.coffre, rel));
  if (d !== path.normalize(config.coffre) && !d.startsWith(path.normalize(config.coffre) + path.sep)) throw new Error('Dossier invalide.');
  return d;
}
function fichierNote(relatif, nom) {
  if (typeof nom !== 'string' || !nom || /[\\/]/.test(nom) || nom.startsWith('.')) throw new Error('Nom de note invalide.');
  return path.join(dossierNotes(relatif), nom.endsWith('.md') ? nom : nom + '.md');
}

// Réglages du plugin « Notes quotidiennes » d'Obsidian (dossier, format), s'il est configuré
ipcMain.handle('reglages-daily', () => {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(config.coffre, '.obsidian/daily-notes.json'), 'utf8'));
    return { dossier: d.folder || '', format: d.format || 'YYYY-MM-DD' };
  } catch { return { dossier: '', format: 'YYYY-MM-DD' }; }
});

ipcMain.handle('lister-notes', async (evenement, relatif) => {
  const dossier = dossierNotes(relatif);
  let noms = [];
  try { noms = await fsp.readdir(dossier); } catch { return []; }
  const out = [];
  for (const nom of noms) {
    if (!nom.endsWith('.md') || nom.startsWith('.') || nom.includes('sync-conflict')) continue;
    try {
      const f = path.join(dossier, nom), i = await fsp.stat(f);
      if (i.isFile()) out.push({ name: nom.slice(0, -3), mtime: i.mtimeMs, cadence: (await fsp.readFile(f, 'utf8')).includes('%% cadence:debut %%') });
    } catch { /* fichier en cours de synchro */ }
  }
  return out;
});

// Écrit (ou remplace) la section Cadence d'une note, entre deux balises de commentaire Obsidian
const DEBUT = '%% cadence:debut %%', FIN = '%% cadence:fin %%';
ipcMain.handle('ecrire-section', async (evenement, relatif, nom, section) => {
  const chemin = fichierNote(relatif, nom);
  const bloc = `${DEBUT}\n${String(section).trim()}\n${FIN}`;
  let texte = '';
  try { texte = await fsp.readFile(chemin, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const i = texte.indexOf(DEBUT), j = texte.indexOf(FIN);
  let nouveau;
  if (i >= 0 && j > i) nouveau = texte.slice(0, i) + bloc + texte.slice(j + FIN.length);
  else nouveau = (texte.trim() ? texte.replace(/\s*$/, '\n\n') : '') + bloc + '\n';
  await fsp.mkdir(path.dirname(chemin), { recursive: true });
  await ecrireAtomique(chemin, nouveau);
  return { cree: !texte };
});

// Associer une note à une tâche : ligne « 📝 [[note]] » ajoutée au corps de la tâche
ipcMain.handle('lier-note', async (evenement, tache, note, mtime) => {
  if (typeof note !== 'string' || !note || /[\[\]|\n]/.test(note)) throw new Error('Nom de note invalide.');
  const tn = reglagesTaskNotes();
  const { chemin, texte } = await lireVerifie(tache, mtime);
  if (texte.includes(`📝 [[${note}]]`)) return false;
  let nouveau = texte.replace(/\s*$/, '\n') + `\n📝 [[${note}]]\n`;
  nouveau = changerCle(nouveau, champ(tn, 'dateModified'), maintenant());
  await ecrireAtomique(chemin, nouveau);
  return true;
});

let veilleurNotes = null;
ipcMain.handle('suivre-notes', (evenement, relatif) => {
  if (veilleurNotes) { veilleurNotes.close(); veilleurNotes = null; }
  try { veilleurNotes = fs.watch(dossierNotes(relatif), () => prevenir('notes-changees')); } catch { /* dossier absent */ }
  return true;
});

ipcMain.handle('lire-note', async (evenement, relatif, nom) => {
  const f = fichierNote(relatif, nom);
  const [texte, info] = await Promise.all([fsp.readFile(f, 'utf8'), fsp.stat(f)]);
  return { texte, mtime: info.mtimeMs };
});

ipcMain.handle('ecrire-note', async (evenement, relatif, nom, texte, mtime) => {
  const f = fichierNote(relatif, nom);
  try {
    const info = await fsp.stat(f);
    if (mtime && Math.abs(info.mtimeMs - mtime) > 1) { const e = new Error('La note a été modifiée ailleurs (Obsidian, synchronisation) : recharge-la avant d\'enregistrer.'); throw e; }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await ecrireAtomique(f, String(texte));
  return (await fsp.stat(f)).mtimeMs;
});

ipcMain.handle('renommer-note', async (evenement, relatif, nom, nouveau) => {
  const n = String(nouveau || '').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
  if (!n) throw new Error('Il faut un titre.');
  const src = fichierNote(relatif, nom), dest = fichierNote(relatif, n);
  if (n === nom) return { nom: n, liens: 0 };
  if (fs.existsSync(dest)) throw new Error('Une note porte déjà ce nom.');
  await fsp.rename(src, dest);
  return { nom: n, liens: await majLiens(nom, n) };
});

// Images et pièces jointes du coffre, servies à l'interface par coffre://f/<nom>
let indexFichiers = null;
async function trouverFichier(nom) {
  const cherche = async () => {
    indexFichiers = new Map();
    const parcourir = async (d) => {
      for (const e of await fsp.readdir(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) await parcourir(p); else if (!indexFichiers.has(e.name)) indexFichiers.set(e.name, p);
      }
    };
    await parcourir(config.coffre);
  };
  if (!indexFichiers || !indexFichiers.has(nom)) await cherche();
  return indexFichiers.get(nom);
}
function servirCoffre() {
  protocol.handle('coffre', async requete => {
    const nom = path.basename(decodeURIComponent(new URL(requete.url).pathname));
    if (!config.coffre || !/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(nom)) return new Response('Interdit', { status: 403 });
    const f = await trouverFichier(nom);
    if (!f) return new Response('Introuvable', { status: 404 });
    return net.fetch(pathToFileURL(f).toString());
  });
}

// --- Tâches : supprimer (vers la corbeille du coffre) et renommer (avec mise à jour des liens) ----

ipcMain.handle('supprimer-tache', async (evenement, nom, mtime) => {
  const { chemin } = await lireVerifie(nom, mtime);
  const corbeille = path.join(config.coffre, '.trash');
  await fsp.mkdir(corbeille, { recursive: true });
  let dest = path.join(corbeille, path.basename(chemin)), n = 1;
  while (fs.existsSync(dest)) dest = path.join(corbeille, `${path.basename(chemin, '.md')} ${++n}.md`);
  await fsp.rename(chemin, dest);
  return true;
});

async function fichiersMd(dossier, out = []) {
  for (const e of await fsp.readdir(dossier, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dossier, e.name);
    if (e.isDirectory()) await fichiersMd(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

ipcMain.handle('renommer-tache', async (evenement, nom, titre, mtime) => {
  const tn = reglagesTaskNotes();
  const nouveauTitre = String(titre || '').replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!nouveauTitre) throw new Error('Il faut un titre.');
  const { chemin, texte } = await lireVerifie(nom, mtime);
  const ancien = path.basename(chemin, '.md');
  if (nouveauTitre === ancien) return { liens: 0 };
  const dest = fichierTache(nouveauTitre);
  if (fs.existsSync(dest)) throw new Error('Une tâche porte déjà ce nom.');
  let nouveau = changerCle(texte, champ(tn, 'title'), yamlTexte(nouveauTitre));
  nouveau = changerCle(nouveau, champ(tn, 'dateModified'), maintenant());
  await ecrireAtomique(chemin, nouveau);
  await fsp.rename(chemin, dest);
  return { liens: await majLiens(ancien, nouveauTitre), nom: nouveauTitre };
});

// Liens [[ancien]], [[ancien|…]], [[ancien#…]] remplacés partout dans le coffre
async function majLiens(ancien, nouveau) {
  const echap = ancien.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\[\\[${echap}(?=[\\]|#])`, 'g');
  let liens = 0;
  for (const f of await fichiersMd(config.coffre)) {
    let t; try { t = await fsp.readFile(f, 'utf8'); } catch { continue; }
    if (!re.test(t)) continue; re.lastIndex = 0;
    await ecrireAtomique(f, t.replace(re, `[[${nouveau}`)); liens++;
  }
  return liens;
}

// --- Météo (Open-Meteo : gratuit, sans compte). Seul accès réseau de Cadence. ---------------------
const nombre = (v, min, max) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new Error('Coordonnées invalides.'); return n; };
ipcMain.handle('meteo', async (evenement, lat, lon) => {
  const la = nombre(lat, -90, 90).toFixed(3), lo = nombre(lon, -180, 180).toFixed(3);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&hourly=precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,weather_code&timezone=auto&forecast_days=16`;
  const r = await net.fetch(url);
  if (!r.ok) throw new Error(`Météo indisponible (${r.status}).`);
  const d = await r.json();
  return d.hourly;
});
ipcMain.handle('meteo-lieu', async (evenement, nom) => {
  const q = String(nom || '').trim().slice(0, 80); if (!q) return [];
  const r = await net.fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=fr`);
  if (!r.ok) throw new Error(`Recherche indisponible (${r.status}).`);
  const d = await r.json();
  return (d.results || []).map(x => ({ nom: x.name, region: [x.admin2, x.admin1, x.country].filter(Boolean).join(', '), lat: x.latitude, lon: x.longitude }));
});

// --- Agendas externes (lecture iCal) et Google Agenda (envoi) ---------------------------------
const etatGoogle = () => { const g = config.google || {}; const sim = process.env.CADENCE_FAUX_GOOGLE === '1'; return { configure: !!(g.clientId && g.clientSecret) || sim, connecte: !!g.refreshToken || sim, simule: sim, clientId: g.clientId || '', calendarId: g.calendarId || 'primary' }; };
ipcMain.handle('agendas-get', () => ({ agendas: (config.agendas || []).map(a => ({ nom: a.nom, couleur: a.couleur || '', url: a.url })), google: etatGoogle() }));
ipcMain.handle('agendas-set', async (evenement, liste) => {
  config.agendas = (Array.isArray(liste) ? liste : []).filter(a => a && /^https:\/\//.test(String(a.url || '').trim()))
    .map(a => ({ nom: String(a.nom || 'Agenda').slice(0, 60), url: String(a.url).trim(), couleur: String(a.couleur || '').slice(0, 20) }));
  await enregistrerConfig(); return true;
});
ipcMain.handle('agendas-lire', (evenement, de, a) => agendas.lireAgendas(config.agendas, de, a));
ipcMain.handle('google-reglages', async (evenement, clientId, clientSecret, calendarId) => {
  const g = config.google || {};
  const nouveauClient = clientId && clientId !== g.clientId;
  config.google = { ...g, clientId: String(clientId || '').trim(), clientSecret: clientSecret ? String(clientSecret).trim() : g.clientSecret, calendarId: String(calendarId || 'primary').trim() || 'primary' };
  if (nouveauClient) delete config.google.refreshToken;
  await enregistrerConfig(); return etatGoogle();
});
ipcMain.handle('google-connecter', async () => {
  const rt = await agendas.connecterGoogle(config.google);
  config.google = { ...config.google, refreshToken: rt }; await enregistrerConfig(); return etatGoogle();
});
ipcMain.handle('google-deconnecter', async () => { if (config.google) delete config.google.refreshToken; await enregistrerConfig(); return etatGoogle(); });
// Envoie (crée ou met à jour) l'évènement d'une tâche et retient son identifiant dans la tâche (clé cadenceGoogle)
ipcMain.handle('google-envoyer', async (evenement, nom, ev, mtime) => {
  const id = await agendas.envoyerEvenement(config.google, { ...ev, fuseau: Intl.DateTimeFormat().resolvedOptions().timeZone });
  if (id !== ev.id) {
    const { chemin, texte } = await lireVerifie(nom, null);
    await ecrireAtomique(chemin, changerCle(texte, 'cadenceGoogle', id));
  }
  config.googleSync = { ...(config.googleSync || {}), [id]: ev.empreinte || '' }; await enregistrerConfig();
  return id;
});
ipcMain.handle('google-retirer', async (evenement, nom, id) => {
  if (id && id !== 'oui') { await agendas.supprimerEvenement(config.google, id); if (config.googleSync) delete config.googleSync[id]; await enregistrerConfig(); }
  if (nom) { try { const { chemin, texte } = await lireVerifie(nom, null); await ecrireAtomique(chemin, changerCle(texte, 'cadenceGoogle', null)); } catch { /* tâche supprimée */ } }
  return true;
});
ipcMain.handle('google-empreintes', () => config.googleSync || {});
// Rendez-vous de l'agenda Google connecté (modifiables). CADENCE_FAUX_GOOGLE=1 : agenda simulé pour les tests.
const fuseau = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
let faux = null;
function fauxGoogle() {
  if (faux) return faux;
  const j = new Date(); j.setHours(0, 0, 0, 0); const lundi = new Date(j); lundi.setDate(j.getDate() - ((j.getDay() + 6) % 7) + (((j.getDay() + 6) % 7) >= 5 ? 7 : 0));
  const at = (d, h, m = 0) => { const x = new Date(lundi); x.setDate(x.getDate() + d); x.setHours(h, m, 0, 0); return x.toISOString(); };
  faux = [
    { id: 'f1', uid: 'f1', titre: 'RDV conseillère bilan', lieu: 'Troyes', description: '', debut: at(2, 10), fin: at(2, 11, 30), allDay: false, recurrent: false, modifiable: true },
    { id: 'f2', uid: 'f2', titre: 'Dentiste', lieu: '', description: '', debut: at(3, 16), fin: at(3, 17), allDay: false, recurrent: false, modifiable: true },
  ];
  return faux;
}
const simule = () => process.env.CADENCE_FAUX_GOOGLE === '1';
ipcMain.handle('google-lire', async (evenement, de, a) => {
  if (simule()) return fauxGoogle().filter(x => x.fin > de && x.debut < a);
  if (!config.google || !config.google.refreshToken) return [];
  return agendas.lireGoogle(config.google, de, a);
});
ipcMain.handle('google-modifier', async (evenement, id, c) => {
  if (simule()) { const x = fauxGoogle().find(y => y.id === id); Object.assign(x, Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined))); return x; }
  return agendas.modifierRdv(config.google, id, { ...c, fuseau: fuseau() });
});
ipcMain.handle('google-creer', async (evenement, c) => {
  if (simule()) { const x = { id: 'f' + Date.now(), uid: '', description: '', lieu: '', recurrent: false, modifiable: true, ...c }; fauxGoogle().push(x); return x; }
  return agendas.creerRdv(config.google, { ...c, fuseau: fuseau() });
});
// Cases Cadence synchronisées : crée / met à jour (ev.id) l'évènement, renvoie son identifiant
let fauxBlocs = {};
ipcMain.handle('google-bloc', async (evenement, ev) => {
  if (simule()) { const id = ev.id && fauxBlocs[ev.id] ? ev.id : 'b' + Date.now() + Math.random().toString(36).slice(2, 5); fauxBlocs[id] = { ...ev, id }; return id; }
  return agendas.envoyerEvenement(config.google, { ...ev, fuseau: fuseau() });
});
ipcMain.handle('google-bloc-retirer', async (evenement, id) => {
  if (simule()) { delete fauxBlocs[id]; return true; }
  await agendas.supprimerEvenement(config.google, id); return true;
});
ipcMain.handle('google-blocs-simules', () => simule() ? fauxBlocs : null);
ipcMain.handle('google-supprimer', async (evenement, id) => {
  if (simule()) { faux = fauxGoogle().filter(y => y.id !== id); return true; }
  await agendas.supprimerRdv(config.google, id); return true;
});

ipcMain.handle('ouvrir-lien', (evenement, url) => {
  if (typeof url === 'string' && url.startsWith('obsidian://')) shell.openExternal(url);
});

// --- Suivi en direct du dossier des tâches et du fichier de données -------------

let veilleurs = [], minuteries = {}, dernierEcritDonnees = 0;

function prevenir(canal) {
  clearTimeout(minuteries[canal]);
  minuteries[canal] = setTimeout(() => BrowserWindow.getAllWindows().forEach(f => f.webContents.send(canal)), 250);
}

function surveiller() {
  veilleurs.forEach(v => v.close()); veilleurs = [];
  if (!config.coffre) return;
  try { veilleurs.push(fs.watch(dossierTaches(), () => prevenir('taches-changees'))); } catch { /* dossier absent */ }
  try {
    const f = fichierDonnees();
    veilleurs.push(fs.watch(path.dirname(f), (type, nom) => {
      if (nom === path.basename(f) && Date.now() - dernierEcritDonnees > 1500) prevenir('donnees-changees');
    }));
  } catch { /* dossier absent */ }
}

// --- Fenêtre ------------------------------------------------------------------

function servirFichiers() {
  protocol.handle('app', requete => {
    const chemin = decodeURIComponent(new URL(requete.url).pathname);
    const fichier = path.normalize(path.join(RACINE, chemin));
    if (!fichier.startsWith(RACINE + path.sep)) return new Response('Interdit', { status: 403 });
    return net.fetch(pathToFileURL(fichier).toString());
  });
}

function creerFenetre() {
  const fenetre = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 560,
    title: 'Cadence',
    icon: path.join(__dirname, 'icone.png'),
    backgroundColor: '#FAFAF7',
    autoHideMenuBar: true,
    show: !process.env.CADENCE_CAPTURE,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  fenetre.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('obsidian://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  fenetre.webContents.on('will-navigate', (evenement, url) => {
    if (url.startsWith('obsidian://')) shell.openExternal(url);
    if (!url.startsWith('app://cadence/')) evenement.preventDefault();
  });
  fenetre.loadURL('app://cadence/index.html');
  if (process.env.CADENCE_CAPTURE) capturer(fenetre, process.env.CADENCE_CAPTURE);
}

// Capture pour les tests : CADENCE_CAPTURE=/chemin/ecran.png
function capturer(fenetre, sortie) {
  fenetre.webContents.on('console-message', ({ level, message }) => console.log(`[console:${level}] ${message}`));
  fenetre.webContents.on('did-finish-load', () => setTimeout(async () => {
    if (process.env.CADENCE_SCRIPT) {   // tests : script exécuté dans la page avant la capture
      try { console.log('[script]', JSON.stringify(await fenetre.webContents.executeJavaScript(fs.readFileSync(process.env.CADENCE_SCRIPT, 'utf8')))); }
      catch (e) { console.log('[script] erreur', e.message); }
      await new Promise(r => setTimeout(r, 1200));
    }
    const image = await fenetre.webContents.capturePage();
    await fsp.writeFile(sortie, image.toPNG());
    console.log(`Capture : ${sortie}`);
    app.quit();
  }, 3000));
}

app.setName('Cadence');
app.whenReady().then(() => {
  chargerConfig();
  servirFichiers();
  servirCoffre();
  creerFenetre();
  surveiller();
});
app.on('window-all-closed', () => app.quit());
