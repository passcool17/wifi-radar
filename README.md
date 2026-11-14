# Wi-Fi Radar

Application web mobile (PWA) et microprogramme ESP32 pour voir, en direct, la **présence** et le **mouvement** détectés par le Wi-Fi CSI (Channel State Information). La v1.1 ajoute un écran OLED, un buzzer et un capteur PIR.

**App (mode simulé, en ligne) :** https://passcool17.github.io/wifi-radar/

**Installation du microprogramme :** https://passcool17.github.io/wifi-radar/flash/

**Guide de câblage (écran, buzzer, PIR) :** https://passcool17.github.io/wifi-radar/cablage/

**Dépôt :** https://github.com/passcool17/wifi-radar

## État

Version 1.1. L’app en ligne fonctionne en **mode simulé**. Le microprogramme cible un **ESP32-WROOM-32 DevKit** (USB-C, puce série CP2102, kit ELEGOO ESP-32 Super Starter). La v1.0.1 a fonctionné sur la carte réelle (présence et mouvement). La v1.1 (écran, buzzer, PIR) n’a pas encore été essayée sur la carte.

## Fonctions

- Écran radar (balayage, présence oui/non, niveau de mouvement 0 à 100, graphique des 60 dernières secondes, journal des débuts et fins de mouvement, heure de Toronto).
- Source **Simulé** : scénario réaliste en boucle (pièce calme, quelqu’un entre, s’assoit, repart), avec état PIR et badge **Confirmé**.
- Source **ESP32** : WebSocket `ws://<ip>/ws`, messages JSON `{t,rssi,motion,presence,pir,confirmed,mute}`. Adresse enregistrée dans le téléphone. Quand l’app est servie par l’ESP32 en HTTP, elle se connecte toute seule à `ws://<hôte>/ws`.
- Réglages : couper le son du buzzer (enregistré dans le téléphone et, une fois connecté, dans la carte), note honnête sur le contenu mixte HTTPS, bouton pour reconfigurer le Wi-Fi si l’app tourne sur la carte.
- PWA hors ligne (service worker `wifi-radar-v1.1`) lorsque la page est en HTTPS.
- Sur la carte : écran OLED (présence, mouvement, adresse IP), bip du buzzer à l’arrivée d’une présence, confirmation par le capteur PIR.

## Format des données

```json
{ "t": 1731590000000, "rssi": -62, "motion": 41, "presence": true, "pir": true, "confirmed": true, "mute": false }
```

- `t` : horodatage en millisecondes (temps Unix si le NTP a réussi, sinon le récepteur met l’heure d’arrivée).
- `rssi` : intensité du signal, en dBm.
- `motion` : niveau de mouvement, de 0 à 100.
- `presence` : présence détectée par le Wi-Fi CSI, `true` ou `false`.
- `pir` : capteur PIR actif, `true` ou `false` (absent sur un ancien microprogramme : l’app affiche « — »).
- `confirmed` : présence CSI et PIR actif, ou PIR actif dans les 5 dernières secondes.
- `mute` : buzzer coupé, tel que mémorisé dans la carte.

Le champ optionnel `bearing` (angle) n’est utilisé que par le simulateur, pour placer le point sur le radar.

L’app peut envoyer `{"cmd":"mute","v":true}` (ou `false`) sur le WebSocket pour couper ou rétablir le son.

## Câblage (kit ELEGOO)

Guide détaillé, avec schéma : [cablage/](https://passcool17.github.io/wifi-radar/cablage/).

| Pièce | Broche de la pièce | Broche de l’ESP32 | Couleur suggérée |
| --- | --- | --- | --- |
| Écran OLED 0,96 po I2C | VCC | 3V3 | Rouge |
| Écran OLED | GND | GND | Noir |
| Écran OLED | SDA | GPIO21 | Bleu |
| Écran OLED | SCL | GPIO22 | Jaune |
| Buzzer (actif ou passif) | + / I/O / SIG | GPIO25 | Orange |
| Buzzer | − / GND | GND | Noir |
| Capteur PIR HC-SR501 | VCC | 5V ou VIN | Rouge |
| Capteur PIR | GND | GND | Noir |
| Capteur PIR | OUT | GPIO27 | Vert |

L’écran va au 3,3 V, le PIR au 5 V. Tous les GND vont ensemble. Ne mettez jamais 5 V sur une broche GPIO. Si un module est absent, la carte démarre quand même.

## Contenu mixte (GitHub Pages en HTTPS)

GitHub Pages force le HTTPS. Un navigateur bloque alors une connexion `ws://` vers une adresse du réseau local.

**Voie recommandée :** l’ESP32 sert lui-même l’app en HTTP (fichiers sur LittleFS) et le WebSocket sur `/ws`. Plus de contenu mixte : la page et le capteur sont sur le même hôte, en HTTP.

**Autre option :** ouvrir l’app depuis un petit serveur HTTP sur le réseau local (ordinateur ou Raspberry Pi) et indiquer l’IP de l’ESP32 dans les réglages.

## Installer le microprogramme

Carte visée : ESP32-WROOM-32 DevKit, connecteur USB-C, puce USB-série **CP2102** (carte réelle : ESP32-D0WD-V3 rév. 3.1).

1. Sur l’ordinateur Ubuntu, ouvrez [la page d’installation](https://passcool17.github.io/wifi-radar/flash/) dans **Chrome** ou **Edge**.
2. Une seule fois : `sudo usermod -a -G dialout $USER`, puis fermez la session et reconnectez-vous.
3. Si le port n’apparaît pas et que `brltty` est installé (et que vous n’utilisez pas de plage braille) : `sudo apt remove brltty`.
4. Branchez la carte avec un câble USB-C **données**, cliquez sur **Installer le microprogramme**, choisissez le port `ttyUSB0` / CP2102. Si ça échoue, maintenez **BOOT** et réessayez.
   Autre solution déjà utilisée : `wget` le fichier `wifi-radar-esp32.bin`, puis `esptool.py --no-stub write_flash -fm dio -fs 4MB 0x0 wifi-radar-esp32.bin`.
5. Avec le téléphone, joignez le réseau **WiFi-Radar-Setup**, ouvrez la page de configuration (ou http://192.168.4.1/setup), entrez le Wi-Fi de la maison. Le mot de passe reste dans la carte (NVS). Il n’est jamais écrit dans les journaux série, ni dans ce dépôt.
6. Revenez sur votre Wi-Fi, puis ouvrez http://wifi-radar.local (ou l’IP affichée à 115200 bauds, et sur l’écran OLED).
7. Pour recommencer la configuration : laissez le bouton **BOOT** enfoncé 3 secondes, ou utilisez **Reconfigurer le Wi-Fi** dans les réglages de l’app servie par la carte.

## Comment le capteur travaille

Une fois connecté au routeur, le microprogramme active le CSI (`esp_wifi_set_csi`) et envoie de petits pings vers la passerelle pour obtenir des trames. Le mouvement (0–100) vient de la variance d’amplitude CSI sur une fenêtre glissante ; la présence utilise un seuil avec hystérésis. L’idée de base (CSI + ping du routeur) vient de l’exemple officiel `csi_recv_router`.

Le capteur PIR confirme ce que le Wi-Fi a vu. Le buzzer émet deux courts bips quand la présence passe de non à oui (pause d’au moins 10 secondes entre deux bips). L’écran se rafraîchit au plus 4 fois par seconde.

## Compiler le microprogramme (sur la machine de développement)

```bash
# arduino-cli et le cœur esp32:esp32 doivent être installés (voir firmware/build.sh)
./firmware/build.sh
```

Cela produit `flash/wifi-radar-esp32.bin` (image fusionnée : bootloader + table de partitions + application + LittleFS, à l’offset 0) et `flash/manifest.json` pour ESP Web Tools (version 1.1.0). Le script installe au besoin les bibliothèques Adafruit GFX, SSD1306 et BusIO.

Cible : `esp32:esp32:esp32`, schéma de partitions `no_ota` (4 Mo).

## Licences et sources

- App et microprogramme de ce dépôt : code écrit pour ce projet, à l’usage de passcool17.
- [espressif/esp-csi](https://github.com/espressif/esp-csi) : **Apache License 2.0**. L’activation du CSI et le ping périodique du routeur s’inspirent de `examples/get-started/csi_recv_router`, avec attribution dans `firmware/WifiRadar/csi_motion.cpp`. Le calcul du mouvement et l’hystérésis de présence sont originaux.
- [janiththilanka/ESP-WIFI-Radar](https://github.com/janiththilanka/ESP-WIFI-Radar) : **aucune licence publiée** (vérifié le 14 novembre 2026 via l’API GitHub). Aucun code n’en a été copié ; le dépôt est seulement cité comme référence d’idée.
- [ESP Web Tools](https://esphome.github.io/esp-web-tools/) (Apache-2.0) : bouton d’installation sur la page `/flash/`.
- Arduino-ESP32, Adafruit GFX / SSD1306 / BusIO et bibliothèques associées : leurs licences respectives (principalement Apache-2.0 / BSD / LGPL).

## Limites

- La v1.0.1 (Wi-Fi et CSI) a été essayée sur la carte réelle. La v1.1 (OLED, buzzer, PIR) n’a pas encore été essayée sur un vrai ESP32 ni sur un vrai Galaxy S20 FE.
- Le CSI sur ESP32 classique est sensible à la pièce, au routeur et au canal ; les seuils devront sans doute être ajustés une fois le kit essayé.
- Le service worker ne s’installe pas sur `http://wifi-radar.local` (contexte non sécurisé). L’app reste utilisable en ligne locale.
- Un seul capteur, pas de cartographie de la pièce.
