// Prototype WebGPU (évaluation de la migration) : choisi par l'adresse.
//
//   ?webgpu         WebGPURenderer (WebGPU, ou WebGL 2 si le navigateur ne l'a pas)
//   ?webgpu&webgl2  WebGPURenderer forcé sur son moteur WebGL 2
//   ?raw            WebGLRenderer actuel, mais avec la même scène « brute » que le
//                   prototype : comparaison à l'identique
//
// Scène brute : matériaux, lumières et ombres seulement. Pas de post-traitement en WebGL
// (?raw), ni reflet du sol, ni sonde de reflets ; en WebGPU, la chaîne d'effets en nœuds
// de postfxNodes.js, le reflet du sol et la sonde. Les objets à shader GLSL écrit à la
// main (ShaderMaterial : cônes des projecteurs, poussières, bordure du plateau…) sont
// masqués, car WebGPURenderer ne sait pas les dessiner : il faudra les réécrire en TSL. Les retouches de matériaux par
// onBeforeCompile (grain de surface, verre…) sont ignorées par WebGPURenderer : chacune a
// son équivalent en nœuds TSL dans nodes.js, branché ici quand le prototype est actif.

const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);

export const WEBGPU = params.has('webgpu');
export const RAW = WEBGPU || params.has('raw');

/** Retouches de matériaux en TSL (null hors prototype : les vues gardent alors leur GLSL). */
export const nodes = WEBGPU ? await import('./nodes.js') : null;

/** Chaîne d'effets en nœuds (null hors prototype). */
export const NodePostFX = WEBGPU ? (await import('./postfxNodes.js')).PostFX : null;

/** Uniformes pilotés par les vues ({ nom: { value } }), dans la forme attendue par le moteur. */
export const shared = (spec) => (nodes ? nodes.uniforms(spec) : spec);

/** Moteur de rendu du prototype, déjà initialisé (null hors prototype). */
export const gpuRenderer = WEBGPU ? await createRenderer() : null;
nodes?.useRenderer(gpuRenderer);

async function createRenderer() {
  const { WebGPURenderer } = await import('three/webgpu');
  const renderer = new WebGPURenderer({ antialias: true, powerPreference: 'high-performance', forceWebGL: params.has('webgl2') });
  await renderer.init();
  return renderer;
}

/** Nom du moteur effectivement utilisé, pour l'affichage. */
export function backendName(renderer) {
  if (!renderer.isWebGPURenderer) return RAW ? 'WebGL (brut)' : 'WebGL';
  return renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGPU → repli WebGL 2';
}

/** Masque les objets que le prototype ne sait pas dessiner (matériaux GLSL écrits à la main). */
export function hideUnsupported(root) {
  let hidden = 0;
  // C'est le matériau qu'on masque, pas l'objet : les vues rallument leurs objets à leur gré.
  root.traverse((o) => {
    for (const m of o.material ? [].concat(o.material) : []) {
      if ((m.isShaderMaterial || m.isRawShaderMaterial) && m.visible) {
        m.visible = false;
        hidden++;
      }
    }
  });
  return hidden;
}
