# three-advanced-techniques (copie partielle)

Fichiers repris tels quels de https://github.com/marcofugaro/three-advanced-techniques,
commit 97c1e27 (paquet 0.2.0), licence MIT (voir LICENSE). Copiés plutôt qu'installés :
le paquet est en 0.x, et son point d'entrée importe aussi three-mesh-bvh.

- `rendering/ambient-occlusion/XeGTAONode.js` : occlusion ambiante (postfxNodes.js)
- `rendering/taau/TAAUNode.js` : anticrénelage temporel avec montée en résolution (postfxNodes.js)
- `rendering/environment-lighting/SlicedPMREMGenerator.js` : préfiltrage de la sonde de reflets (environment.js)
- `rendering/screen-space-reflections/` (SSRNode.js et ses utils, dont sa propre copie de compileQuad.js) : essai ?webgpu&ssr (postfxNodes.js)
- `utils/GPUTierDetector.js` : qualité de départ du mode auto (main.js)
- `utils/compileQuad.js` : dépendance des précédents

Ne pas modifier ces fichiers : pour les mettre à jour, recopier ceux du dépôt.
