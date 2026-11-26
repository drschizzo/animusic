// Fragments GLSL partagés.

/**
 * Protection contre les valeurs non finies (NaN, ±Inf). Un seul pixel NaN suffit à
 * noircir toute l'image : le préfiltrage de la sonde de reflets, le flou du sol et le
 * halo (bloom) l'étalent, puis chaque matériau qui lit l'environnement le recopie.
 *
 * Le test se fait sur les bits de l'exposant (tous à 1 ⇔ NaN ou infini) plutôt
 * qu'avec isnan()/isinf(), que certains compilateurs (Metal en « fast math »)
 * suppriment en supposant qu'aucun NaN n'existe.
 */
export const FINITE = /* glsl */ `
  bool nonFinite(float x) { return (floatBitsToUint(x) & 0x7f800000u) == 0x7f800000u; }
  vec3 finite(vec3 c) { return (nonFinite(c.r) || nonFinite(c.g) || nonFinite(c.b)) ? vec3(0.0) : c; }
  vec4 finite(vec4 c) { return (nonFinite(c.r) || nonFinite(c.g) || nonFinite(c.b) || nonFinite(c.a)) ? vec4(0.0, 0.0, 0.0, 1.0) : c; }
`;
