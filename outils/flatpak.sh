#!/bin/sh
# Fabrique le Flatpak de Cadence et l'installe pour l'utilisateur courant.
#
# Usage, depuis le dossier du projet :
#     sh outils/flatpak.sh
#
# Publication (utilisé par GitHub Actions, voir .github/workflows/flatpak.yml) :
#     PUBLIER=1 sh outils/flatpak.sh
#   → fabrique Cadence.flatpak sans l'installer. Le dépôt FlatKein le signe et le distribue.
#
# Prérequis (une seule fois) :
#     flatpak install --user flathub org.electronjs.Electron2.BaseApp//25.08
#     npm install
#
# Étapes : application de bureau (electron-builder) → dossier Flatpak → dépôt local → Cadence.flatpak → installation.

set -e

ID=fr.cadence.Cadence
VERSION_BASE=25.08
CONSTRUCTION=dist/flatpak/construction
DEPOT=dist/flatpak/depot

echo "1/5  Application de bureau"
npx electron-builder --linux dir > /dev/null

echo "2/5  Dossier Flatpak"
rm -rf "$CONSTRUCTION"
flatpak build-init --base=org.electronjs.Electron2.BaseApp --base-version=$VERSION_BASE \
  "$CONSTRUCTION" $ID org.freedesktop.Platform org.freedesktop.Platform $VERSION_BASE

FICHIERS="$CONSTRUCTION/files"
mkdir -p "$FICHIERS/bin" "$FICHIERS/share/applications" "$FICHIERS/share/metainfo" \
  "$FICHIERS/share/icons/hicolor/512x512/apps"
cp -r dist/linux-unpacked "$FICHIERS/cadence"
rm -f "$FICHIERS/cadence/chrome-sandbox"          # inutile : zypak s'en charge
install -m 755 bureau/flatpak/lanceur.sh "$FICHIERS/bin/cadence"
install -m 644 bureau/flatpak/$ID.desktop "$FICHIERS/share/applications/"
install -m 644 bureau/flatpak/$ID.metainfo.xml "$FICHIERS/share/metainfo/"
install -m 644 bureau/icone.png "$FICHIERS/share/icons/hicolor/512x512/apps/$ID.png"

# Fiche AppStream : ce que lisent Warehouse, Discover ou GNOME Logiciels pour afficher l'application
# dans le catalogue du dépôt (nom, description, icône). Construite à partir du metainfo.
mkdir -p "$FICHIERS/share/app-info/xmls"
for TAILLE in 64 128; do
  mkdir -p "$FICHIERS/share/app-info/icons/flatpak/${TAILLE}x${TAILLE}"
  install -m 644 bureau/flatpak/icone-$TAILLE.png "$FICHIERS/share/app-info/icons/flatpak/${TAILLE}x${TAILLE}/$ID.png"
done
{
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<components version="0.14" origin="flatpak">'
  sed -e '1d' -e "s|</component>|  <icon type=\"cached\" width=\"64\" height=\"64\">$ID.png</icon>\n  <icon type=\"cached\" width=\"128\" height=\"128\">$ID.png</icon>\n  <bundle type=\"flatpak\">app/$ID/x86_64/master</bundle>\n</component>|" \
    bureau/flatpak/$ID.metainfo.xml
  echo '</components>'
} | gzip > "$FICHIERS/share/app-info/xmls/$ID.xml.gz"

echo "3/5  Permissions"

# Pas de réseau : l'application n'en a pas besoin.
# Dossier personnel : pour lire et écrire dans le coffre Obsidian, où qu'il soit (Syncthing, Nextcloud…).
flatpak build-finish "$CONSTRUCTION" \
  --command=cadence \
  --socket=wayland --socket=fallback-x11 --share=ipc --device=dri \
  --filesystem=home \
  --talk-name=org.freedesktop.Notifications \
  --env=ELECTRON_OZONE_PLATFORM_HINT=auto > /dev/null


echo "4/5  Dépôt local et fichier Cadence.flatpak"
rm -rf "$DEPOT"
flatpak build-export "$DEPOT" "$CONSTRUCTION" > /dev/null
flatpak build-bundle "$DEPOT" Cadence.flatpak $ID

if [ -n "$PUBLIER" ]; then
  echo "Prêt à publier : Cadence.flatpak"
  exit 0
fi

echo "5/5  Installation"
flatpak install --user -y --noninteractive --reinstall Cadence.flatpak

echo "Terminé : Cadence est dans le menu des applications et dans Warehouse."
