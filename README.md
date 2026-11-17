# Cadence

Une **semaine type** en agenda à l'heure réelle (routines, créneaux), reliée à un **coffre Obsidian**
qui utilise le plugin [TaskNotes](https://github.com/callumalpass/tasknotes).

- Les tâches du coffre s'affichent **en direct**, rangées par tag ou par projet, avec leurs checklists.
- Chaque bloc de la semaine peut être lié à un tag ou à un projet : une pastille compte les tâches prêtes.
- **Glisser une tâche sur un jour** fixe sa date planifiée (`scheduled`) dans la note de la tâche.
- Les tâches déjà datées dans la semaine apparaissent toutes seules dans le bon créneau (📅).
- **Cocher une ligne de checklist** l'écrit dans la note ; **＋ Tâche** crée une nouvelle tâche TaskNotes.
- Filtres : masquer les tâches placées, bloquées par une autre, ou datées à plus de 30 jours.
- Édition directe des créneaux, sans mode spécial : étirer le bas d'un bloc (par 15 min), glisser pour le déplacer, 🗑 pour le supprimer,
  « + » après 3 s de survol entre deux créneaux, double-clic pour le modifier. Les chevauchements sont refusés.
- Une tâche déposée sur un espace libre crée une case de son type (titre, tag, couleur, projet) ; maintenue 3 s entre deux créneaux collés, elle en ouvre un. Quand une case bouge ou disparaît, ses tâches datées suivent dans Obsidian.
- Trait de l'heure actuelle sur la semaine en cours.
- Tâches : rappel automatique 30 min avant l'heure prévue, renommage par double-clic (liens mis à jour dans tout le coffre),
  🗑 suppression avec confirmation (vers la corbeille `.trash` du coffre).
- Onglet **Notes** : les notes d'un dossier réglable (par défaut celui des notes quotidiennes d'Obsidian), à associer à une tâche (🔗),
  notes ouvertes dans un grand cadre pour les éditer (titre compris, enregistrement automatique, aperçu avec images), et **↻ Daily** qui écrit le programme du jour bloc par bloc (encadré violet) dans une note unique, `CADENCE` à la racine du coffre par défaut, avec les liens vers les tâches
  (section entre `%% cadence:debut %%` et `%% cadence:fin %%`, remplacée à chaque mise à jour).
- Impression A4 paysage de la semaine.

## Principes

- **Coquille vide** : l'application ne contient aucune donnée. Au premier lancement, on choisit son coffre.
- **Fichier dans le coffre** : la semaine type, les tags et les projets sont enregistrés dans un fichier JSON du coffre
  (`Cadence.json` par défaut, réglable), synchronisé avec le reste des notes.
- **Réglages TaskNotes respectés** : dossier des tâches, identification (tag ou propriété), noms des champs,
  statuts et priorités sont lus dans `.obsidian/plugins/tasknotes/data.json`.
- **Écritures prudentes** : seules quelques lignes précises du frontmatter ou du corps sont modifiées ; si la note a changé
  entre-temps (Obsidian, synchronisation…), l'écriture est refusée et la liste rechargée.
- **Pas de réseau.** HTML, CSS et JavaScript sans framework.

## Lancer

**Sur Linux, depuis le dépôt Flatpak FlatKein** (mises à jour automatiques, visible dans Warehouse) :

    flatpak install --user https://jeff12873.github.io/FlatKein/fr.cadence.Cadence.flatpakref

Chaque envoi sur la branche `main` fabrique `Cadence.flatpak` et le publie dans les Releases
(`.github/workflows/flatpak.yml`). Le dépôt [FlatKein](https://github.com/Jeff12873/FlatKein) le signe et le distribue.

**En Flatpak fabriqué localement** : `sh outils/flatpak.sh` (prérequis en tête du script).

**Dans un navigateur** : ouvrir `index.html`. Mode autonome : on charge le dossier des tâches à la main,
en lecture seule, et la semaine est gardée dans le navigateur.

## Commandes utiles

| Commande | Effet |
|---|---|
| `npm install` | Installe Electron et l'outil d'emballage (une seule fois) |
| `npm run demarrer` | Lance l'application de bureau sans l'emballer |
| `sh outils/flatpak.sh` | Fabrique `Cadence.flatpak` et l'installe |
| `CADENCE_CAPTURE=/tmp/ecran.png npm run demarrer` | Capture d'écran automatique (tests) |

## Organisation

| Fichier | Rôle |
|---|---|
| `index.html` | Toute l'interface (semaine, panneau des tâches, réglages) |
| `bureau/main.js` | Fenêtre Electron et pont vers le coffre : lecture, suivi, écritures |
| `bureau/preload.js` | Fonctions exposées à l'interface sous `window.cadence` |
| `bureau/flatpak/` | Lanceur, fiche `.desktop`, metainfo et icônes du Flatpak |
| `outils/flatpak.sh` | Fabrication du Flatpak |
