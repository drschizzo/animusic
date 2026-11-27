// Écran de chargement. Son animation est entièrement en CSS (transformations et opacité,
// voir index.html) : le navigateur la joue hors du fil principal, elle reste donc fluide
// même pendant un calcul. L'avancement n'est qu'un changement d'échelle de la barre.

const LABELS = {
  model: 'Écriture de la chorégraphie…',
  machines: 'Montage des machines…',
  shaders: 'Préparation des lumières et des matières…',
  scène: 'Mise en place de la scène…',
};

export class Loader {
  constructor(root = document.getElementById('loader')) {
    this.root = root;
    this.bar = root.querySelector('.loader-bar > div');
    this.text = root.querySelector('.loader-text');
    this.value = 0;
  }

  /** Affiche l'écran ; `veil` : voile translucide par-dessus la scène (changement de morceau). */
  show(veil = false) {
    this.value = 0;
    this.bar.style.transform = 'scaleX(0)';
    this.root.classList.toggle('veil', veil);
    this.root.classList.remove('done');
    this.root.setAttribute('aria-busy', 'true');
  }

  /** Avancement (0 à 1, jamais en arrière) et étape en cours. */
  progress(fraction, step) {
    this.value = Math.max(this.value, Math.min(1, fraction));
    this.bar.style.transform = `scaleX(${this.value.toFixed(3)})`;
    const label = LABELS[step];
    if (label && this.text.textContent !== label) this.text.textContent = label;
  }

  hide() {
    this.bar.style.transform = 'scaleX(1)';
    this.root.classList.add('done');
    this.root.setAttribute('aria-busy', 'false');
  }
}
