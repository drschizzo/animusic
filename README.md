# Animusic — prototype

![Aperçu](docs/apercu.png)

Génère une scène 3D animée dans l'esprit d'*Animusic* (Pipe Dream) à partir d'un fichier MIDI :
des canons tirent des billes qui retombent pile sur des lames de marimba, des bras robotisés jouent la
batterie, des médiators pincent des cordes de basse et des tubes d'orgue s'illuminent sur les notes tenues.

**En ligne : https://drschizzo.github.io/animusic/** (déployé automatiquement par GitHub Actions).

## Utilisation

- Glisse un `.mid` sur la page (ou « Ouvrir un MIDI… ») ; une démo se charge au démarrage.
- Chaque piste reçoit automatiquement un instrument (**Billes**, **Basse**, **Orgue**, **Batterie**),
  modifiable dans la liste des pistes, ou **Masquée**.
- **Caméra** : *Réalisateur* (plans automatiques), *Orbite*, ou *Libre* (souris). Toucher la vue passe en libre.
- **Barre de lecture** pour naviguer dans le morceau ; **Retard image** pour corriger une latence audio mal
  annoncée (Bluetooth) ; **Qualité** *Auto* baisse ombres / bloom / résolution si l'animation rame.
- **Sons réalistes** : échantillons General MIDI (SoundFont FluidR3), sinon synthèse.
- **⏺ Vidéo** : rejoue le morceau et l'enregistre (image + son) en MP4 ou WebM.
- **⇩ Blender** : exporte l'animation complète en glTF (`.glb`).

## Développement

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # tests unitaires (chorégraphie, instruments, arrangeur, réalisateur)
npm run build && npm run smoke   # build + test de fumée dans Chromium (comme en CI)
npm run bench -- morceau.mid     # banc d'essai : arrangement, NaN, coût par image
```

## Principe : l'animation à l'envers

Comme dans MIDImotion (l'outil d'Animusic), rien n'est simulé : tout est **calculé à l'avance à partir des notes**,
puis la scène est posée à l'instant `t` lu sur l'horloge audio.

- **Billes** : tir à `t − T`, vitesse initiale `v0 = (cible − départ + ½·g·T²·ŷ) / T` → parabole exacte ;
  le canon le plus proche et libre vise juste avant de tirer.
- **Batterie** : un bras à deux segments par élément, pose de frappe par cinématique inverse ; la baguette se lève
  avant le coup (plus haut si le coup est fort et espacé) et touche la peau pile à l'instant de la note.
- **Basse** : des chariots glissent devant la corde suivante pendant que le médiator est au repos, puis il traverse
  la corde à l'instant exact (aller, puis retour au coup suivant) ; la corde vibre avec un flou de mouvement.
- **Orgue** : la valve s'ouvre avant la note, la colonne de lumière dure autant que la note.
- **Réalisateur** : la liste des plans est calculée pour tout le morceau ; chaque segment cadre l'instrument le plus
  actif par rapport à son niveau habituel (bonus à son entrée), en alternant plans larges, rapprochés, contre-plongées.

## Synchro image / son

L'image est calée sur l'échantillon **réellement en train de sortir des haut-parleurs**
(`AudioContext.getOutputTimestamp()`, à défaut `currentTime − outputLatency`), et non sur l'horloge de
programmation de Tone.js qui a ~0,1 s d'avance. Pendant un enregistrement vidéo, le son étant capté à la source,
l'image suit l'horloge de rendu audio.

## Architecture

| Fichier | Rôle |
|---|---|
| `src/midi.js` | Lecture MIDI (`@tonejs/midi`) → pistes / notes / programme ; morceau de démo |
| `src/arranger.js` | Rôle de chaque piste (programme GM + statistiques + passe globale), construction et placement des instruments |
| `src/choreography.js`, `src/drums.js`, `src/strings.js`, `src/pipes.js` | **Cœurs purs, sans Three.js** : mouvements calculés de chaque instrument |
| `src/director.js` | **Pur** : plans caméra et pose de la caméra à l'instant t |
| `src/*View.js` | Rendu Three.js de chaque instrument |
| `src/scene.js` | Scène, lumières, post-traitement, qualité ; instancie la vue de chaque instrument |
| `src/audio.js` | Tone.js : échantillons GM, synthèse de secours, horloge de référence, capture pour la vidéo |
| `src/exporter.js` | Export glTF (animation cuite) |
| `src/main.js` | Interface et boucle de rendu |

Outils : `tools/make-samples.mjs` (génère les échantillons avec FluidSynth), `tools/bench.mjs`,
`tools/smoke.mjs`, `tools/stress-midi.mjs` (fichiers MIDI de stress).

## Export vers Blender

*Fichier → Importer → glTF 2.0* puis choisir le `.glb`. On y trouve tous les instruments (noms préfixés
`billes_`, `batterie_`, `basse_`, `orgue_`, `bille_pisteN_k`) et la caméra animée `camera_realisateur`
(à définir comme caméra active). L'animation est échantillonnée à 30 img/s ; le décalage du son par rapport au
début de l'animation est indiqué dans le message d'export et dans les propriétés personnalisées de la racine
(`animusic.decalageAudioSecondes`). Non exportés : sol, lumières et éclats lumineux (émission animée, non
standard en glTF) — à recréer dans Blender.

## Sons

Les échantillons de `public/samples/` sont extraits du SoundFont *Fluid (R3) General MIDI* de Frank Wen,
sous licence MIT (voir `public/samples/LICENSE.txt`). Pour les régénérer :

```bash
sudo apt-get install fluidsynth fluid-soundfont-gm ffmpeg
npm run samples
```

## Déploiement

`.github/workflows/deploy.yml` teste, construit, lance le test de fumée dans Chromium, puis publie sur GitHub Pages
à chaque push sur la branche par défaut.
