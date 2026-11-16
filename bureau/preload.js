// Pont entre l'interface (index.html) et le coffre Obsidian. Seules ces fonctions sont exposées,
// sous window.cadence. Sans elles (page ouverte dans un navigateur), l'interface fonctionne
// en mode autonome : chargement manuel du dossier, lecture seule, stockage dans le navigateur.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cadence', {
  config: () => ipcRenderer.invoke('config'),
  choisirCoffre: () => ipcRenderer.invoke('choisir-coffre'),
  reglerDonnees: (relatif) => ipcRenderer.invoke('regler-donnees', relatif),
  lireDonnees: () => ipcRenderer.invoke('lire-donnees'),
  ecrireDonnees: (donnees) => ipcRenderer.invoke('ecrire-donnees', donnees),
  lireTaches: () => ipcRenderer.invoke('lire-taches'),
  cocher: (nom, index, fait, mtime) => ipcRenderer.invoke('cocher', nom, index, fait, mtime),
  planifier: (nom, valeur, mtime) => ipcRenderer.invoke('planifier', nom, valeur, mtime),
  creerTache: (tache) => ipcRenderer.invoke('creer-tache', tache),
  terminer: (nom, mtime) => ipcRenderer.invoke('terminer', nom, mtime),
  rouvrir: (nom, ancien) => ipcRenderer.invoke('rouvrir', nom, ancien),
  ouvrirLien: (url) => ipcRenderer.invoke('ouvrir-lien', url),
  surChangementTaches: (fn) => ipcRenderer.on('taches-changees', () => fn()),
  surChangementDonnees: (fn) => ipcRenderer.on('donnees-changees', () => fn()),
});
