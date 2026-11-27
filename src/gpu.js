// Prototype WebGPU (évaluation de la migration) : choisi par l'adresse.
//
//   ?webgpu         WebGPURenderer, sur WebGPU seulement : sans adaptateur WebGPU qui
//                   convienne, la page reprend le moteur WebGL (pas de repli WebGL 2)
//   ?raw            WebGLRenderer actuel, mais avec la même scène « brute » que le
//                   prototype : comparaison à l'identique
//
// Scène brute : matériaux, lumières et ombres seulement. Pas de post-traitement en WebGL
// (?raw), ni reflet du sol, ni sonde de reflets ; en WebGPU, la chaîne d'effets en nœuds
// de postfxNodes.js (reflets en espace écran compris) et la sonde. Les retouches de matériaux par
// onBeforeCompile (grain de surface, verre…) et les ShaderMaterial écrits à la main
// (lointain, cônes des projecteurs, poussières, ombres de contact, trappes, souffles)
// sont ignorés par WebGPURenderer : chacun a son équivalent en nœuds TSL dans nodes.js,
// branché ici quand le prototype est actif. Un ShaderMaterial resté sans équivalent est
// masqué (hideUnsupported), et signalé dans la console.

const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);

// La passe de scène (postfxNodes.js) écrit six cibles, 40 octets par pixel : au-delà des 32
// garantis par WebGPU. Il faut un adaptateur qui en permet davantage, sinon moteur WebGL.
const SCENE_BYTES = 40;
const wanted = params.has('webgpu');
const adapter = wanted ? await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }) : null;
const attachmentBytes = adapter?.limits.maxColorAttachmentBytesPerSample ?? 0;
export const WEBGPU = attachmentBytes >= SCENE_BYTES;
if (wanted && !WEBGPU) console.warn('WebGPU absent ou trop limité sur cette machine : moteur WebGL.');
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
  const renderer = new WebGPURenderer({ antialias: true, powerPreference: 'high-performance', requiredLimits: { maxColorAttachmentBytesPerSample: attachmentBytes } });
  await renderer.init();
  return renderer;
}

/** Nom du moteur effectivement utilisé, pour l'affichage. */
export function backendName(renderer) {
  if (!renderer.isWebGPURenderer) return RAW ? 'WebGL (brut)' : 'WebGL';
  return 'WebGPU';
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
        if (WEBGPU) console.warn('WebGPU : ShaderMaterial sans équivalent en nœuds, masqué', o.name || o.type, o);
      }
    }
  });
  return hidden;
}
