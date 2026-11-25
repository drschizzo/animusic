# Animusic — prototype

![Aperçu](docs/apercu.png)

Génère une scène 3D animée dans l'esprit d'*Animusic* (Pipe Dream) à partir d'un fichier MIDI :
des canons tirent des billes qui retombent pile sur des lames de marimba au moment exact de chaque note.

## Lancer

```bash
npm install
npm run dev
```

Puis ouvrir http://localhost:5173. Une démo se charge au démarrage ; glisse un `.mid` sur la page
(ou « Ouvrir un MIDI… ») pour générer ta propre scène. Les pistes de percussions sont décochées par défaut.

```bash
npm test
```

## Principe : l'animation à l'envers

Comme dans MIDImotion (l'outil d'Animusic), rien n'est simulé : tout est **calculé à l'avance à partir des notes**.
Pour une note à l'instant `t` sur la lame `L` :

1. tir à `t − T` (T = temps de vol) ;
2. vitesse initiale `v0 = (cible − départ + ½·g·T²·ŷ) / T` → parabole exacte ;
3. le canon s'oriente vers `v0` juste avant le tir, recule, son embout s'illumine ;
4. la lame s'illumine et vibre à l'impact, la bille rebondit puis disparaît.

## Architecture

| Fichier | Rôle |
|---|---|
| `src/midi.js` | Lecture MIDI (`@tonejs/midi`) → pistes/notes ; morceau de démo |
| `src/choreography.js` | **Cœur pur, sans Three.js** : disposition des lames, attribution des canons, trajectoires, poses à l'instant t |
| `src/scene.js` | Rendu Three.js (PBR, ombres, bloom) ; pose la scène à l'instant t |
| `src/audio.js` | Synthèse Tone.js ; son horloge est la référence de temps de l'animation |
| `src/main.js` | Interface, chargement, boucle de rendu |

La chorégraphie étant indépendante du rendu, elle pourra être exportée plus tard (ex. vers Blender).

## Pistes pour la suite

- Autres instruments virtuels selon le type de piste (basse → cordes pincées, batterie → bras robotisés, accords tenus → tuyaux d'orgue)
- Réalisateur caméra automatique (plans choisis selon les instruments actifs)
- Sons échantillonnés (SoundFont) par instrument General MIDI
- Barre de lecture / navigation dans le temps
